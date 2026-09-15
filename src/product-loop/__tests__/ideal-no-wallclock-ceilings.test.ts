/**
 * `/ideal` has no WALL-CLOCK ceilings that cut work which is still running.
 *
 * User decision (verbatim): "không có giới hạn gì cả" — no limits at all. Commit
 * `7ee436e6` removed every spend / token / effort limit through the run-scoped
 * switch in `src/utils/ideal-run-scope.ts`; this file removes the remaining
 * TOTAL-ELAPSED bounds, which are a different thing from a hang guard: they fire
 * on a healthy, progressing operation purely because it has taken too long.
 *
 * Measured harm — run `mtv9v1xu7615`, terminal `run-finished` verbatim:
 *
 *   outcome: "threw", sprintsRun: 0
 *   reason: "isolated implementation stage exceeded 900s total watchdog (sprint 3)
 *    and was CANCELLED after 900.0s; observed 196 sub-agent activity event(s), the
 *    last one 0.8s before the deadline"
 *
 * 196 events across 900s is a mean gap of 4.6s. The child was working when a wall
 * clock killed it. Commit `4acd4bbb` converted THAT one stage to idle+ceiling for
 * exactly this reason; these tests carry the same principle to the rest.
 *
 * THE SAFETY RULE every case here encodes: a ceiling is also the last thing that
 * ends a genuinely stuck operation. So each "not cancelled while working" case is
 * paired with a "still cancelled when silent" case naming the guard that does it,
 * and with an "unchanged outside /ideal" case. An unbounded path with no liveness
 * signal is a worse failure than the ceiling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { councilLlmTimeoutMs } from "../../council/llm.js";
import { getCouncilContinuationWatchdogMs } from "../../orchestrator/council-continuation-budget.js";
import { withTurnWatchdog } from "../../orchestrator/turn-watchdog.js";
import type { StreamChunk, TaskRequest, ToolResult } from "../../types/index.js";
import { runInIdealScope } from "../../utils/ideal-run-scope.js";
import { withDeadlineRace } from "../../utils/llm-deadline.js";
import {
  computeVerifyBudget,
  getImplTotalTimeoutMs,
  getIsolatedImplCeilingMs,
  getIsolatedImplIdleTimeoutMs,
  getVerifyBudgetCeilingMs,
  runIsolatedImplWithDeadline,
  runVerifyWithWatchdog,
  withImplIdleWatchdog,
} from "../sprint-runner.js";
import { resolveUndebatedGateTimeoutMs, UNDEBATED_GATE_DEFAULT_TIMEOUT_MS } from "../undebated-criteria-gate.js";
import { getFloorTimeoutMs, runFloorCommand } from "../verify-floor.js";

const runVerifyOrchestrationMock = vi.hoisted(() => vi.fn());
vi.mock("../../verify/orchestrator.js", () => ({
  runVerifyOrchestration: runVerifyOrchestrationMock,
}));

const REQUEST: TaskRequest = { agent: "general", description: "Sprint 3 implementation", prompt: "do it" };

/** The flat budget that cut run mtv9v1xu7615 while the child was still emitting. */
const CUT_AT_MS = 900_000;

type TaskOpts = { abortSignal?: AbortSignal; onActivity?: (detail: string) => void };

/** A child that emits one activity notification every `cadenceMs` for `emitForMs`. */
function emittingChild(opts: { cadenceMs: number; emitForMs: number }) {
  let finish: ((r: ToolResult) => void) | undefined;
  let emitted = 0;
  const task = async (_req: TaskRequest, o?: TaskOpts): Promise<ToolResult> =>
    new Promise<ToolResult>((resolve) => {
      finish = resolve;
      let at = 0;
      const tick = () => {
        if (o?.abortSignal?.aborted) return;
        at += opts.cadenceMs;
        emitted += 1;
        o?.onActivity?.(`edit_file step-${emitted}`);
        if (at < opts.emitForMs) setTimeout(tick, opts.cadenceMs);
      };
      if (opts.emitForMs > 0) setTimeout(tick, opts.cadenceMs);
    });
  return {
    task,
    get emitted() {
      return emitted;
    },
    finish: (r: ToolResult) => finish?.(r),
  };
}

/** Settled-state probe that never leaves an unhandled rejection behind. */
function track<T>(p: Promise<T>) {
  const state = { settled: false, rejected: false, value: undefined as unknown, error: undefined as unknown };
  p.then(
    (v) => {
      state.settled = true;
      state.value = v;
    },
    (e) => {
      state.settled = true;
      state.rejected = true;
      state.error = e;
    },
  );
  return state;
}

function useFake() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Isolated implementation stage — the 60 min absolute ceiling
//    Hang guard that remains: getIsolatedImplIdleTimeoutMs() (240s), armed by
//    withIsolatedImplDeadline's self-rearming silence timer from the sub-agent's
//    own per-tool onActivity notifications.
// ─────────────────────────────────────────────────────────────────────────────

describe("isolated implementation ceiling", () => {
  it("is OFF inside an /ideal run and unchanged outside it", () => {
    expect(getIsolatedImplCeilingMs()).toBe(3_600_000);
    expect(runInIdealScope(() => getIsolatedImplCeilingMs())).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps honouring MUONROI_SPRINT_ISOLATED_IMPL_CEILING_MS outside /ideal", () => {
    const prev = process.env.MUONROI_SPRINT_ISOLATED_IMPL_CEILING_MS;
    process.env.MUONROI_SPRINT_ISOLATED_IMPL_CEILING_MS = "120000";
    try {
      expect(getIsolatedImplCeilingMs()).toBe(120_000);
    } finally {
      if (prev === undefined) delete process.env.MUONROI_SPRINT_ISOLATED_IMPL_CEILING_MS;
      else process.env.MUONROI_SPRINT_ISOLATED_IMPL_CEILING_MS = prev;
    }
  });

  describe("withIsolatedImplDeadline with no ceiling", () => {
    useFake();

    it("mtv9v1xu7615 shape: a child emitting for 3h past every ceiling is NOT cancelled", async () => {
      const child = emittingChild({ cadenceMs: 6_000, emitForMs: 11_000_000 });
      const p = runIsolatedImplWithDeadline({
        runIsolatedTask: child.task,
        request: REQUEST,
        sprintN: 3,
        totalMs: Number.POSITIVE_INFINITY,
        idleMs: getIsolatedImplIdleTimeoutMs(),
      });
      const state = track(p);

      await vi.advanceTimersByTimeAsync(10_800_000); // 3 hours
      expect(child.emitted).toBeGreaterThan(1_000);
      expect(state.settled).toBe(false);

      child.finish({ success: true, output: "shipped" });
      await vi.advanceTimersByTimeAsync(0);
      await expect(p).resolves.toMatchObject({ success: true });
    });

    it("STILL ends a genuinely stuck child — the 240s silence guard is what does it", async () => {
      const child = emittingChild({ cadenceMs: 6_000, emitForMs: 0 }); // never emits
      const p = runIsolatedImplWithDeadline({
        runIsolatedTask: child.task,
        request: REQUEST,
        sprintN: 4,
        totalMs: Number.POSITIVE_INFINITY,
        idleMs: 240_000,
      });
      const state = track(p);

      await vi.advanceTimersByTimeAsync(239_000);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.rejected).toBe(true);
      expect(Date.now()).toBeLessThan(CUT_AT_MS);
      await expect(p).rejects.toThrow(/no sub-agent activity for 240s/);
    });

    it("aborts the child rather than abandoning it when the silence guard fires", async () => {
      let seen: AbortSignal | undefined;
      const task = async (_req: TaskRequest, o?: TaskOpts): Promise<ToolResult> => {
        seen = o?.abortSignal;
        return new Promise<ToolResult>(() => {});
      };
      const p = runIsolatedImplWithDeadline({
        runIsolatedTask: task,
        request: REQUEST,
        sprintN: 2,
        totalMs: Number.POSITIVE_INFINITY,
        idleMs: 30_000,
      });
      const state = track(p);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(state.rejected).toBe(true);
      expect(seen?.aborted).toBe(true);
    });

    it("keeps cancelling at a FINITE ceiling — normal (non-/ideal) behaviour is untouched", async () => {
      const child = emittingChild({ cadenceMs: 6_000, emitForMs: Number.MAX_SAFE_INTEGER });
      const p = runIsolatedImplWithDeadline({
        runIsolatedTask: child.task,
        request: REQUEST,
        sprintN: 7,
        totalMs: 600_000,
        idleMs: 240_000,
      });
      const state = track(p);
      await vi.advanceTimersByTimeAsync(590_000);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(state.rejected).toBe(true);
      await expect(p).rejects.toThrow(/absolute ceiling/i);
    });

    it("totalMs <= 0 still disables BOTH bounds (the pre-existing opt-out is unchanged)", async () => {
      const child = emittingChild({ cadenceMs: 1_000, emitForMs: 0 });
      const p = runIsolatedImplWithDeadline({
        runIsolatedTask: child.task,
        request: REQUEST,
        sprintN: 5,
        totalMs: 0,
        idleMs: 1_000,
      });
      const state = track(p);
      await vi.advanceTimersByTimeAsync(10_000_000);
      expect(state.settled).toBe(false);
      child.finish({ success: true, output: "ok" });
      await expect(p).resolves.toMatchObject({ success: true });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Streamed implementation stage — the 15 min total
//    Hang guard that remains: getImplIdleTimeoutMs() (240s), the
//    time-to-next-chunk arm of withImplIdleWatchdog.
// ─────────────────────────────────────────────────────────────────────────────

describe("streamed implementation total", () => {
  it("is OFF inside an /ideal run and unchanged outside it", () => {
    expect(getImplTotalTimeoutMs()).toBe(15 * 60 * 1000);
    expect(runInIdealScope(() => getImplTotalTimeoutMs())).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps honouring MUONROI_SPRINT_IMPL_TOTAL_MS outside /ideal", () => {
    const prev = process.env.MUONROI_SPRINT_IMPL_TOTAL_MS;
    process.env.MUONROI_SPRINT_IMPL_TOTAL_MS = "600000";
    try {
      expect(getImplTotalTimeoutMs()).toBe(600_000);
    } finally {
      if (prev === undefined) delete process.env.MUONROI_SPRINT_IMPL_TOTAL_MS;
      else process.env.MUONROI_SPRINT_IMPL_TOTAL_MS = prev;
    }
  });

  describe("withImplIdleWatchdog with no total", () => {
    useFake();

    /** Yields one chunk every `gapMs`, forever. */
    async function* streaming(gapMs: number): AsyncGenerator<StreamChunk, void, unknown> {
      for (;;) {
        await new Promise((r) => setTimeout(r, gapMs));
        yield { type: "content", content: "." } as StreamChunk;
      }
    }

    /** Yields nothing, ever. */
    async function* silent(): AsyncGenerator<StreamChunk, void, unknown> {
      await new Promise(() => {});
    }

    it("a turn still streaming past 15 min is NOT cut", async () => {
      let seen = 0;
      const p = (async () => {
        for await (const _c of withImplIdleWatchdog(streaming(60_000), 240_000, 1, Number.POSITIVE_INFINITY)) {
          seen += 1;
          if (seen >= 60) break; // 60 minutes of steady streaming
        }
      })();
      const state = track(p);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(seen).toBe(60);
      expect(state.rejected).toBe(false);
      await p;
    });

    it("STILL ends a silent turn — the 240s idle guard is what does it", async () => {
      const p = (async () => {
        for await (const _c of withImplIdleWatchdog(silent(), 240_000, 1, Number.POSITIVE_INFINITY)) {
          /* nothing ever arrives */
        }
      })();
      const state = track(p);
      await vi.advanceTimersByTimeAsync(239_000);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.rejected).toBe(true);
      await expect(p).rejects.toThrow(/produced no output for 240s/);
    });

    it("a FINITE total still cuts a heartbeat-only turn (non-/ideal behaviour untouched)", async () => {
      const p = (async () => {
        for await (const _c of withImplIdleWatchdog(streaming(1_000), 240_000, 1, 10_000)) {
          /* heartbeats keep the idle guard alive */
        }
      })();
      const state = track(p);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(state.rejected).toBe(true);
      await expect(p).rejects.toThrow(/total watchdog/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Verify stage — the 60 min ceiling on the derived budget, and the budget
//    itself, which inside /ideal becomes a SILENCE window instead of a total.
//    Hang guard that remains: the same budget, measured from the stage's last
//    observed activity event instead of from its start — strictly more
//    permissive than today (silence-since-last-event <= total-elapsed, always)
//    while still ending a stage that produces nothing at all.
// ─────────────────────────────────────────────────────────────────────────────

describe("verify stage budget", () => {
  it("the absolute ceiling is OFF inside /ideal and unchanged outside it", () => {
    expect(getVerifyBudgetCeilingMs()).toBe(3_600_000);
    expect(runInIdealScope(() => getVerifyBudgetCeilingMs())).toBe(Number.POSITIVE_INFINITY);
  });

  it("a slow repo's derived budget is no longer clamped to 60 min inside /ideal", () => {
    // A baseline of 10 min x the 20x multiplier derives 200 min, which today is
    // clamped to the 60 min ceiling.
    const outside = computeVerifyBudget(600_000);
    expect(outside.basis).toBe("ceiling");
    expect(outside.budgetMs).toBe(3_600_000);

    const inside = runInIdealScope(() => computeVerifyBudget(600_000));
    expect(inside.basis).toBe("baseline-derived");
    expect(inside.budgetMs).toBe(12_000_000);
  });

  describe("runVerifyWithWatchdog", () => {
    useFake();

    beforeEach(() => {
      runVerifyOrchestrationMock.mockReset();
    });

    /** A verify stage that reports one progress beat every `cadenceMs`, forever. */
    function progressingVerify(cadenceMs: number) {
      runVerifyOrchestrationMock.mockImplementation(
        async (_agent: unknown, opts: { onProgress?: (d: string) => void; abortSignal?: AbortSignal }) =>
          new Promise<ToolResult>(() => {
            const tick = () => {
              if (opts.abortSignal?.aborted) return;
              opts.onProgress?.("Running verify sub-agent");
              setTimeout(tick, cadenceMs);
            };
            setTimeout(tick, cadenceMs);
          }),
      );
    }

    const BUDGET = computeVerifyBudget(null); // 600_000 floor, no baseline

    it("a verify stage still reporting progress past 60 min is NOT aborted inside /ideal", async () => {
      progressingVerify(300_000); // one beat every 5 min — inside the 10 min window
      const p = runInIdealScope(() =>
        runVerifyWithWatchdog({} as never, "run-x", 2, { budget: runInIdealScope(() => computeVerifyBudget(null)) }),
      );
      const state = track(p);
      await vi.advanceTimersByTimeAsync(7_200_000); // 2 hours
      expect(state.settled).toBe(false);
    });

    it("STILL aborts a verify stage that reports nothing at all", async () => {
      runVerifyOrchestrationMock.mockImplementation(async () => new Promise<ToolResult>(() => {}));
      const p = runInIdealScope(() => runVerifyWithWatchdog({} as never, "run-y", 2, { budget: BUDGET }));
      const state = track(p);
      await vi.advanceTimersByTimeAsync(599_000);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.settled).toBe(true);
      await expect(p).resolves.toMatchObject({ success: false, error: /verify-timeout/ as never });
    });

    it("outside /ideal the budget is still a TOTAL — a progressing stage is cut at it", async () => {
      progressingVerify(300_000);
      const p = runVerifyWithWatchdog({} as never, "run-z", 2, { budget: BUDGET });
      const state = track(p);
      await vi.advanceTimersByTimeAsync(601_000);
      expect(state.settled).toBe(true);
      const r = (await p) as ToolResult;
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/verify-timeout/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Verify FLOOR — the 10 min per-command budget.
//    Hang guard that remains: the same 10 min, measured as silence on the
//    child's own stdout/stderr. A build that prints nothing for 10 minutes is
//    dead; one that is printing is alive, and that signal was already being
//    collected (the `sink` handlers) — it simply took no part in the decision.
// ─────────────────────────────────────────────────────────────────────────────

describe("verify floor per-command budget", () => {
  it("the number is unchanged in both modes — only WHAT it measures changes", () => {
    expect(getFloorTimeoutMs()).toBe(600_000);
    expect(runInIdealScope(() => getFloorTimeoutMs())).toBe(600_000);
  });

  // Real child processes, so real timers — kept sub-second on purpose. A fake
  // clock cannot drive an OS process's stdout.
  const CHATTY =
    "let n=0;const t=setInterval(()=>{n++;process.stdout.write('.')},20);setTimeout(()=>{clearInterval(t);process.exit(0)},700);";
  const MUTE = "setTimeout(()=>process.exit(0),700);";

  function run(script: string, timeoutMs: number, inIdeal: boolean) {
    const cmd = `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"`;
    const invoke = () => runFloorCommand("build", cmd, process.cwd(), timeoutMs);
    return inIdeal ? runInIdealScope(invoke) : invoke();
  }

  it("inside /ideal a command that keeps printing outlives the budget", async () => {
    const r = await run(CHATTY, 200, true);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.elapsedMs).toBeGreaterThan(200);
  }, 15_000);

  it("inside /ideal a command that prints NOTHING is still killed at the silence budget", async () => {
    const r = await run(MUTE, 200, true);
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  }, 15_000);

  it("outside /ideal the budget is still a TOTAL — a printing command is killed at it", async () => {
    const r = await run(CHATTY, 200, false);
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Council LLM per-call deadline (300 s).
//    Hang guard that remains: createStallWatchdog(getProviderStallTimeoutMs())
//    armed inside collectStreamText (src/council/llm.ts) and re-armed on EVERY
//    chunk including reasoning-delta, plus the caller's own abort signal.
// ─────────────────────────────────────────────────────────────────────────────

describe("council per-call deadline", () => {
  it("is OFF inside an /ideal run and unchanged outside it", () => {
    expect(councilLlmTimeoutMs()).toBe(300_000);
    expect(runInIdealScope(() => councilLlmTimeoutMs())).toBe(0);
  });

  it("keeps honouring MUONROI_COUNCIL_LLM_TIMEOUT_MS outside /ideal", () => {
    const prev = process.env.MUONROI_COUNCIL_LLM_TIMEOUT_MS;
    process.env.MUONROI_COUNCIL_LLM_TIMEOUT_MS = "120000";
    try {
      expect(councilLlmTimeoutMs()).toBe(120_000);
    } finally {
      if (prev === undefined) delete process.env.MUONROI_COUNCIL_LLM_TIMEOUT_MS;
      else process.env.MUONROI_COUNCIL_LLM_TIMEOUT_MS = prev;
    }
  });

  describe("withDeadlineRace", () => {
    useFake();

    it("arms no deadline at all when given 0 — a long call is not rejected", async () => {
      let done: ((v: string) => void) | undefined;
      const p = withDeadlineRace(() => new Promise<string>((r) => (done = r)), 0, "council.generate");
      const state = track(p);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(state.settled).toBe(false);
      done?.("ok");
      await expect(p).resolves.toBe("ok");
    });

    it("a user abort STILL unblocks the caller when no deadline is armed", async () => {
      const ctrl = new AbortController();
      const p = withDeadlineRace(() => new Promise<string>(() => {}), 0, "council.generate", ctrl.signal);
      const state = track(p);
      ctrl.abort();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.rejected).toBe(true);
      await expect(p).rejects.toThrow(/aborted by user/);
    });

    it("a FINITE deadline still rejects (normal chat behaviour untouched)", async () => {
      const p = withDeadlineRace(() => new Promise<string>(() => {}), 5_000, "chat.call");
      const state = track(p);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(state.rejected).toBe(true);
      await expect(p).rejects.toThrow(/exceeded 5000ms deadline/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Council continuation turn — the 600 s total.
//    Hang guard that remains: the 120 s idle arm of the same withTurnWatchdog.
// ─────────────────────────────────────────────────────────────────────────────

describe("council continuation watchdog", () => {
  it("drops only the TOTAL inside /ideal; the idle guard is identical", () => {
    expect(getCouncilContinuationWatchdogMs()).toEqual({ idleMs: 120_000, totalMs: 600_000 });
    expect(runInIdealScope(() => getCouncilContinuationWatchdogMs())).toEqual({ idleMs: 120_000, totalMs: 0 });
  });

  it("keeps honouring both env overrides outside /ideal", () => {
    const prevI = process.env.MUONROI_COUNCIL_CONTINUATION_IDLE_MS;
    const prevT = process.env.MUONROI_COUNCIL_CONTINUATION_TOTAL_MS;
    process.env.MUONROI_COUNCIL_CONTINUATION_IDLE_MS = "30000";
    process.env.MUONROI_COUNCIL_CONTINUATION_TOTAL_MS = "90000";
    try {
      expect(getCouncilContinuationWatchdogMs()).toEqual({ idleMs: 30_000, totalMs: 90_000 });
    } finally {
      if (prevI === undefined) delete process.env.MUONROI_COUNCIL_CONTINUATION_IDLE_MS;
      else process.env.MUONROI_COUNCIL_CONTINUATION_IDLE_MS = prevI;
      if (prevT === undefined) delete process.env.MUONROI_COUNCIL_CONTINUATION_TOTAL_MS;
      else process.env.MUONROI_COUNCIL_CONTINUATION_TOTAL_MS = prevT;
    }
  });

  describe("withTurnWatchdog with totalMs 0", () => {
    useFake();

    async function* streaming(gapMs: number): AsyncGenerator<StreamChunk, void, unknown> {
      for (;;) {
        await new Promise((r) => setTimeout(r, gapMs));
        yield { type: "content", content: "." } as StreamChunk;
      }
    }

    it("a continuation still streaming past 10 min is NOT cut", async () => {
      let seen = 0;
      const p = (async () => {
        for await (const _c of withTurnWatchdog(streaming(60_000), { idleMs: 120_000, totalMs: 0, label: "t" })) {
          seen += 1;
          if (seen >= 30) break;
        }
      })();
      const state = track(p);
      await vi.advanceTimersByTimeAsync(1_800_000);
      expect(seen).toBe(30);
      expect(state.rejected).toBe(false);
      await p;
    });

    it("STILL ends a silent continuation — the 120 s idle guard is what does it", async () => {
      const p = (async () => {
        for await (const _c of withTurnWatchdog(
          (async function* () {
            await new Promise(() => {});
          })(),
          { idleMs: 120_000, totalMs: 0, label: "council continuation turn" },
        )) {
          /* nothing */
        }
      })();
      const state = track(p);
      await vi.advanceTimersByTimeAsync(121_000);
      expect(state.rejected).toBe(true);
      await expect(p).rejects.toThrow(/produced no output for 120s/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. NOT a work ceiling — do not sweep it away.
// ─────────────────────────────────────────────────────────────────────────────

describe("the undebated-criteria gate waits for a HUMAN, not for work", () => {
  it("is identical inside and outside /ideal — removing it would wait forever at the card", () => {
    // This is how long the gate waits for someone to answer an askcard before
    // applying the unattended default; `/ideal` legitimately sits on approve
    // cards for many minutes (CLAUDE.md records a 17-minute wait that was NOT a
    // hang). An unattended run with no bound here never finishes.
    expect(resolveUndebatedGateTimeoutMs()).toBe(UNDEBATED_GATE_DEFAULT_TIMEOUT_MS);
    expect(runInIdealScope(() => resolveUndebatedGateTimeoutMs())).toBe(UNDEBATED_GATE_DEFAULT_TIMEOUT_MS);
    expect(UNDEBATED_GATE_DEFAULT_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("still honours its env override in both modes (0 = CI, resolve immediately)", () => {
    const env = { MUONROI_UNDEBATED_GATE_TIMEOUT_MS: "0" } as unknown as NodeJS.ProcessEnv;
    expect(resolveUndebatedGateTimeoutMs(env)).toBe(0);
    expect(runInIdealScope(() => resolveUndebatedGateTimeoutMs(env))).toBe(0);
  });
});
