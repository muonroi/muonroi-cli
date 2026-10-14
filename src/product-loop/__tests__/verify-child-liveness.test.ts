/**
 * The verify silence budget must measure silence EVERYWHERE, not just in the parent.
 *
 * MEASURED DEFECT — run `muc2joffe506`, sprint 1, 2026-09-25, parent session
 * `2a116648b48e`, verify child session `9f04faf649b3` (`~/.muonroi-cli/muonroi.db`,
 * queried read-only):
 *
 *   06:34:07.852Z  child session's first row
 *   06:53:40.352Z  the PARENT's last stage-activity beat, detail "Running verify
 *                  sub-agent" — emitted at verify/orchestrator.ts:163, i.e. just
 *                  BEFORE `agent.runTaskRequest`, and nothing after it ever was
 *   06:53:59.772Z  child's next row — 19.4s later, so it was plainly working
 *   ~07:06:47Z     the 786.6s silence budget expired; stage aborted;
 *                  `sprints/1-goal-gate.json` → "source":"verdict-not-pass",
 *                  criteria 0/4, sprint score 0, phases-deadlocked P1,P2,P3
 *   07:16:30.761Z  child's LAST row — it worked 9.7 min PAST the abandonment
 *
 * 302 child rows landed after the parent went quiet, 125 of them after the
 * deadline. At the granularity this fix heartbeats on — `tool_call` / `tool_result`
 * — the silent window held 76 + 77 events whose LARGEST inter-event gap was
 * 125.8s, against an armed budget of 786.6s. So the stage was never close to
 * silent; the parent simply had no channel to hear it on, because
 * `buildVerifyAgent.runTaskRequest` declared an `onActivity` parameter
 * (`verify/orchestrator.ts` passes it at :164) and then dropped it on the floor.
 *
 * At that same moment the deterministic floor had measured everything green:
 * `cd frontend && npm run build` OK, `npm run test` OK, pytest OK.
 *
 * The fixture below is that timeline: baseline 39.3s x 20 = 786.6s, 4 parent
 * events with the last one at 06:53:40, child active until 07:16:30.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk, ToolResult } from "../../types/index.js";

vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));

import { __resetInteractivePauseForTests } from "../../orchestrator/interactive-pause.js";
import { runInIdealScope } from "../../utils/ideal-run-scope.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { buildVerifyAgent, computeVerifyBudget, runVerifyWithWatchdog } from "../sprint-runner.js";
import type { DriverContext } from "../types.js";

const RUN_ID = "muc2joffe506";
const SPRINT_N = 1;

/**
 * Run `muc2joffe506`'s own recorded verify baseline: 39.3s. x20 => 786.6s.
 *
 * Derived INSIDE the `/ideal` scope, which is where the incident's budget was
 * derived: that is what makes the ceiling `none` rather than the 3600s default,
 * matching `sprints/1-verify.md` verbatim ("floor 600s, ceiling none").
 */
const BASELINE_MS = 39_330;
const BUDGET = runInIdealScope(() => computeVerifyBudget(BASELINE_MS));
const BUDGET_MS = BUDGET.budgetMs;

/**
 * The largest gap between consecutive child `tool_call` rows inside the window the
 * parent was silent for (measured: 125.8s, ending 06:59:08.517Z).
 */
const CHILD_MAX_GAP_MS = 125_800;

/** 06:53:40.352Z -> 07:16:30.761Z, the span the child kept working for. */
const CHILD_ACTIVE_SPAN_MS = 1_370_409;

let flowDir: string;
let cwd: string;

function toolCallChunk(name: string): StreamChunk {
  return {
    type: "tool_calls",
    toolCalls: [{ id: `c${name}`, type: "function", function: { name, arguments: "{}" } }],
  };
}

/** Sleep on the FAKE clock, so `advanceTimersByTimeAsync` drives the timeline. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A verify child that emits real tool activity on `gapMs` centres for `spanMs`,
 * then finishes its turn normally. The shape of session `9f04faf649b3`.
 */
function childThatKeepsWorking(gapMs: number, spanMs: number): DriverContext["processMessageFn"] {
  return async function* (): AsyncGenerator<StreamChunk, void, unknown> {
    let elapsed = 0;
    while (elapsed + gapMs <= spanMs) {
      await sleep(gapMs);
      elapsed += gapMs;
      yield toolCallChunk("bash");
      yield { type: "tool_result", toolResult: { success: true, output: "ok" } as ToolResult };
    }
    yield { type: "content", content: "VERIFY_PASS\nbuild OK, tests OK\n" };
    yield { type: "done" };
  };
}

/**
 * A child that does `calls` real tool calls on `gapMs` centres and then goes
 * genuinely quiet while still alive. Must be cut — and the message must name what
 * it had heard from the child.
 */
function childThatWorksThenHangs(gapMs: number, calls: number): DriverContext["processMessageFn"] {
  return async function* (): AsyncGenerator<StreamChunk, void, unknown> {
    for (let i = 0; i < calls; i++) {
      await sleep(gapMs);
      yield toolCallChunk("bash");
      yield { type: "tool_result", toolResult: { success: true, output: "ok" } as ToolResult };
    }
    await new Promise<void>(() => {});
  };
}

/** A child that is ALIVE but producing nothing — the hang this budget exists for. */
function childThatHangs(): DriverContext["processMessageFn"] {
  return async function* (): AsyncGenerator<StreamChunk, void, unknown> {
    await new Promise<void>(() => {});
  };
}

/**
 * A child whose stream emits some real activity and then DIES (throws). The parent
 * must not be left waiting on it.
 */
function childThatDies(afterMs: number): DriverContext["processMessageFn"] {
  return async function* (): AsyncGenerator<StreamChunk, void, unknown> {
    await sleep(afterMs);
    yield toolCallChunk("bash");
    throw new Error("child process exited unexpectedly");
  };
}

/**
 * A child that emits ONLY non-progress chunks. These must NOT re-arm the budget:
 * `withImplIdleWatchdog`'s own doc (sprint-runner.ts:1066-1072) records a live
 * defeat of exactly this shape — "the impl created 2 files then emitted only
 * non-progress heartbeat chunks for 9+ min, resetting a per-chunk idle timer
 * without ever completing".
 */
function childThatOnlyChatters(gapMs: number): DriverContext["processMessageFn"] {
  return async function* (): AsyncGenerator<StreamChunk, void, unknown> {
    for (;;) {
      await sleep(gapMs);
      yield { type: "toast", content: "still thinking…", toastLevel: "info" };
      yield { type: "content", content: "…\n" };
      yield { type: "task_list_update" };
    }
  };
}

function makeCtx(processMessageFn: DriverContext["processMessageFn"]): DriverContext {
  return { runId: RUN_ID, flowDir, processMessageFn } as unknown as DriverContext;
}

/**
 * Mirror `runVerifyOrchestration`'s REAL wiring (verify/orchestrator.ts:163-164):
 * one beat before the sub-agent starts, then the sub-agent with `onProgress`
 * handed in as its `onActivity`. The parent's 4 beats and their timing come from
 * this; everything after the 4th is the child's to report.
 */
function wireRealOrchestrationShape(): void {
  (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (agent: { runTaskRequest: VerifyRunTask }, opts?: VerifyOpts) => {
      // The three preparation beats, then the one the incident recorded last.
      opts?.onProgress?.("Loaded verify environment manifest: .muonroi-cli/environment.json");
      opts?.onProgress?.("Sandbox off — running verify on host (no shuru checkpoint)");
      opts?.onProgress?.("No verify checkpoint needed for this recipe");
      opts?.onProgress?.("Running verify sub-agent");
      return agent.runTaskRequest(
        { agent: "verify", description: "verify", prompt: "verify the sprint" } as never,
        opts?.onProgress,
        opts?.abortSignal,
      );
    },
  );
}

type VerifyOpts = { onProgress?: (d: string) => void; abortSignal?: AbortSignal };
type VerifyRunTask = (req: never, onActivity?: (d: string) => void, abortSignal?: AbortSignal) => Promise<ToolResult>;

/** Block until the watchdog has armed (see verify-budget-scaling.test.ts). */
async function untilWatchdogArmed(): Promise<void> {
  const mock = runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>;
  for (let i = 0; i < 5_000; i++) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("verify orchestration was never invoked — the watchdog never armed");
}

function runStage(processMessageFn: DriverContext["processMessageFn"]): Promise<ToolResult> {
  const ctx = makeCtx(processMessageFn);
  const agent = buildVerifyAgent(ctx, cwd);
  return runInIdealScope(() => runVerifyWithWatchdog(agent, RUN_ID, SPRINT_N, { budget: BUDGET }));
}

beforeAll(async () => {
  await import("../verify-floor.js");
  await import("../verify-baseline.js");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  flowDir = mkdtempSync(join(tmpdir(), "verify-child-flow-"));
  cwd = mkdtempSync(join(tmpdir(), "verify-child-cwd-"));
  mkdirSync(join(flowDir, "runs", RUN_ID), { recursive: true });
  writeFileSync(
    join(flowDir, "runs", RUN_ID, "verify-baseline.json"),
    JSON.stringify({ version: 1, runId: RUN_ID, verdict: "PASS", failures: [], elapsedMs: BASELINE_MS }),
    "utf8",
  );
  vi.clearAllMocks();
  __resetInteractivePauseForTests();
  wireRealOrchestrationShape();
});

afterEach(() => {
  vi.useRealTimers();
  __resetInteractivePauseForTests();
  rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("verify silence budget — the CHILD's liveness reaches the budget", () => {
  it("does not cut a child that is still working after the parent's own beats stop", async () => {
    // The budget is armed at 786.6s of silence. The child works for 1370s with a
    // largest gap of 125.8s — 6.3x inside the budget. Before the fix the parent
    // heard nothing after "Running verify sub-agent" and cut it at 786.6s.
    const p = runStage(childThatKeepsWorking(CHILD_MAX_GAP_MS, CHILD_ACTIVE_SPAN_MS));
    await untilWatchdogArmed();

    await vi.advanceTimersByTimeAsync(CHILD_ACTIVE_SPAN_MS + 60_000);

    const res = await p;
    expect(res.error ?? "").not.toContain("verify-timeout");
    expect(res.success).toBe(true);
    expect(res.output).toContain("VERIFY_PASS");
  }, 60_000);

  it("STILL cuts a child that is alive but producing nothing", async () => {
    // The property most easily lost by this change. A hung verify is the reason
    // the watchdog exists; forwarding child activity must not blunt it.
    const p = runStage(childThatHangs());
    await untilWatchdogArmed();

    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1_000);
    await vi.advanceTimersByTimeAsync(60_000); // salvage grace

    const res = await p;
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("verify-timeout");
    expect(res.error ?? "").toContain("this was a SILENCE budget, not a total");
  }, 60_000);

  it("STILL cuts a child that only emits non-progress chatter, never a tool call", async () => {
    // `withImplIdleWatchdog`'s recorded defeat: heartbeat chunks resetting a
    // per-chunk idle timer while nothing advanced. The heartbeat is therefore
    // derived from tool chunks ONLY, so this child is silence.
    const p = runStage(childThatOnlyChatters(30_000));
    await untilWatchdogArmed();

    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1_000);
    await vi.advanceTimersByTimeAsync(60_000);

    const res = await p;
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("verify-timeout");
  }, 60_000);

  it("does not leave the parent waiting when the child dies", async () => {
    const p = runStage(childThatDies(60_000));
    await untilWatchdogArmed();

    // Well inside the budget: the stage must settle because the CHILD ended, not
    // because the clock ran out.
    await vi.advanceTimersByTimeAsync(120_000);

    const res = await p;
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("child process exited unexpectedly");
    expect(res.error ?? "").not.toContain("verify-timeout");
  }, 60_000);

  it("reports the child's own activity in the timeout message, not just the parent's 4 beats", async () => {
    // When it DOES fire, the message must account for what it heard. The incident's
    // message said "observed 4 stage activity event(s)" — the parent's preparation
    // beats and nothing else — while 302 rows of child work in that same window
    // went unmentioned. A child that works, then genuinely goes quiet, must show up
    // in BOTH the count and the last-detail.
    const p = runStage(childThatWorksThenHangs(CHILD_MAX_GAP_MS, 3));
    await untilWatchdogArmed();

    await vi.advanceTimersByTimeAsync(CHILD_MAX_GAP_MS * 3 + 1_000);
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 60_000);
    await vi.advanceTimersByTimeAsync(60_000); // salvage grace

    const msg = (await p).error ?? "";
    expect(msg).toContain("verify-timeout");
    const observed = Number(/observed (\d+) stage activity event/.exec(msg)?.[1] ?? "0");
    // 4 parent beats + 3 tool calls + 3 tool results. The incident reported 4.
    expect(observed).toBe(10);
    // And the last thing heard was the CHILD's work, not the beat fired just
    // before the child started. (A tool RESULT closes each pair, so that is the
    // detail — the tool name rides on the call, pinned in nested-turn's own test.)
    expect(msg).not.toContain('reading: "Running verify sub-agent"');
    expect(msg).toContain('reading: "verify sub-agent tool result"');
  }, 60_000);
});

describe("verify watchdog — the abort reaches the child it gave up on", () => {
  /**
   * REAL timers and a deliberately tiny budget. The unwind happens on the JS
   * microtask/timer queue rather than on a clock this test can fast-forward, so
   * faking time would hide the very thing under test.
   */
  const SMALL_BUDGET = runInIdealScope(() => computeVerifyBudget(null, { floorMs: 200 }));
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("unwinds the child at its NEXT YIELD when the watchdog fires — it does not run on unbounded", async () => {
    vi.useRealTimers();
    // The other half of the same dropped-parameter defect.
    // `verify/orchestrator.ts:164` passes `options.abortSignal` third;
    // `buildVerifyAgent.runTaskRequest` used to take only `req`, so
    // `controller.abort()` reached nothing. MEASURED, run `muc2joffe506` sprint 1:
    // 125 further child rows and ~10 min of work past the 07:06:47 abandonment,
    // and `1-verify.md` said "it may still be running when this returned".
    const state = { unwound: false, beats: 0, resumedAfterAbort: false, ranAnotherLoop: false };
    const child = (() =>
      (async function* (): AsyncGenerator<StreamChunk, void, unknown> {
        try {
          // Three quick beats: the stage is visibly alive and must NOT be cut.
          for (let i = 0; i < 3; i++) {
            state.beats++;
            yield toolCallChunk("bash");
            await delay(20);
          }
          yield { type: "content", content: "partial findings: build OK\n" };
          // Now go quiet for far longer than the 200ms budget — a genuine stall.
          await delay(2_000);
          // The queued `return()` takes effect at the next YIELD, so the body does
          // resume this far. Documented rather than wished away.
          state.resumedAfterAbort = true;
          yield toolCallChunk("bash");
          // ...and never gets past that yield.
          state.ranAnotherLoop = true;
        } finally {
          state.unwound = true;
        }
      })()) as NonNullable<DriverContext["processMessageFn"]>;

    const ctx = makeCtx(child);
    const res = await runInIdealScope(() =>
      runVerifyWithWatchdog(buildVerifyAgent(ctx, cwd), RUN_ID, SPRINT_N, { budget: SMALL_BUDGET }),
    );

    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("verify-timeout");
    // It was alive for its three beats and only cut once it went quiet.
    expect(state.beats).toBe(3);

    // THE PROPERTY: the child was TOLD to stop, not merely abandoned. Give its
    // pending 2s await time to settle so the queued return() can land.
    await delay(2_600);
    expect(state.unwound).toBe(true);
    expect(state.resumedAfterAbort).toBe(true); // resumed as far as the next yield
    expect(state.ranAnotherLoop).toBe(false); // and stopped THERE, not after it

    // A second consequence of honouring the abort: because collection now returns
    // promptly instead of looping forever, the salvage recovers the real partial
    // report rather than reporting that the grace expired.
    expect(res.output).toContain("partial findings: build OK");
    expect(res.error ?? "").not.toMatch(/salvage grace/);
  }, 30_000);

  it("does not abort a child that already finished — the signal arrives too late to matter", async () => {
    // `runVerifyWithWatchdog` aborts its controller on the timeout path only; a
    // stage that returned normally must never be cancelled retroactively, or a
    // green verify would be torn down after the fact.
    let returnedAfterDone = false;
    const gen = (async function* (): AsyncGenerator<StreamChunk, void, unknown> {
      yield toolCallChunk("bash");
      yield { type: "content", content: "VERIFY_PASS\n" };
      yield { type: "done" };
    })();
    const realReturn = gen.return?.bind(gen);
    gen.return = (async (v?: unknown) => {
      returnedAfterDone = true;
      return realReturn ? await realReturn(v as never) : { done: true as const, value: undefined };
    }) as typeof gen.return;

    const p = runStage((() => gen) as NonNullable<DriverContext["processMessageFn"]>);
    await untilWatchdogArmed();
    await vi.advanceTimersByTimeAsync(1_000);

    const res = await p;
    expect(res.success).toBe(true);
    expect(res.output).toContain("VERIFY_PASS");
    // The stream ran to completion, so nothing was unwound.
    expect(returnedAfterDone).toBe(false);

    // And the budget lapsing afterwards must not retroactively cancel anything.
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 60_000);
    expect(returnedAfterDone).toBe(false);
  }, 60_000);
});
