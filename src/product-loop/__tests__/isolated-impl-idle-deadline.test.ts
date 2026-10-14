/**
 * The isolated-impl deadline must cancel on SILENCE, not on a wall clock that
 * expires while the child is demonstrably working.
 *
 * Measured defect — run `mtv9v1xu7615`, terminal `run-finished` event verbatim:
 *
 *   outcome: "threw", success: false, sprintsRun: 0, shipped: false
 *   reason: "isolated implementation stage exceeded 900s total watchdog (sprint 3)
 *    and was CANCELLED after 900.0s; observed 196 sub-agent activity event(s), the
 *    last one 0.8s before the deadline (at 2026-09-10T10:04:17.605Z) — the child
 *    was still emitting when it was cancelled; cause not diagnosed — only the
 *    observations above were measured"
 *
 * 196 activity events across the 900s window is a mean gap of 4.6s, and the last
 * gap was 0.8s. The child was writing the analyzer unit tests the PREVIOUS sprint
 * had been blocked on (`failedCondition: "engineering_floor"`,
 * `reason: "zero_coverage"`); 428 lines / 28 `[Fact]` tests were on disk
 * afterwards, 25 of 28 passing. The watchdog killed the sprint that was fixing
 * the thing the run was stuck on.
 *
 * The activity callback that produced those 196 observations was already wired —
 * it only phrased the error message and took NO part in the decision to cancel.
 * These tests pin that it now decides.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRequest, ToolResult } from "../../types/index.js";
import {
  buildIsolatedImplTimeoutMessage,
  getImplIdleTimeoutMs,
  getIsolatedImplCeilingMs,
  getIsolatedImplIdleTimeoutMs,
  runIsolatedImplWithDeadline,
  withIsolatedImplDeadline,
} from "../sprint-runner.js";

const REQUEST: TaskRequest = { agent: "general", description: "Sprint 3 implementation", prompt: "do it" };

/** The flat budget runSprint used to pass (`getImplTotalTimeoutMs()`), in ms. */
const OLD_FLAT_BUDGET_MS = 900_000;

type TaskOpts = { abortSignal?: AbortSignal; onActivity?: (detail: string) => void };

/**
 * A sub-agent stand-in that emits one activity notification every `cadenceMs`
 * (the real `onActivity` fires once per tool call the child starts) and stops
 * emitting after `emitForMs`. It settles only when `finish()` is called, or
 * never — exactly the shape of a child the parent can only observe.
 */
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
  const state = { settled: false, rejected: false, error: undefined as unknown };
  p.then(
    () => {
      state.settled = true;
    },
    (e) => {
      state.settled = true;
      state.rejected = true;
      state.error = e;
    },
  );
  return state;
}

describe("isolated-impl deadline constants — derivation", () => {
  it("the idle window matches the streamed path's existing idle constant", () => {
    // `withImplIdleWatchdog` has guarded the SAME stage (the implementation
    // turn) with a 4-minute time-to-next-chunk budget in production. The
    // isolated path's equivalent signal is time-to-next-activity-event, so it
    // inherits that number rather than inventing one.
    expect(getImplIdleTimeoutMs()).toBe(240_000);
    expect(getIsolatedImplIdleTimeoutMs()).toBe(getImplIdleTimeoutMs());
  });

  it("the absolute ceiling is well above the 900s at which a productive stage was cut", () => {
    // Run mtv9v1xu7615 was still emitting at 900.0s. Any ceiling at or below
    // that reproduces the defect, so the ceiling must clear it with margin.
    expect(getIsolatedImplCeilingMs()).toBeGreaterThan(OLD_FLAT_BUDGET_MS);
    expect(getIsolatedImplCeilingMs()).toBe(3_600_000);
  });

  it("the ceiling is far enough above the idle window that the two never race", () => {
    expect(getIsolatedImplCeilingMs() / getIsolatedImplIdleTimeoutMs()).toBeGreaterThanOrEqual(10);
  });
});

describe("withIsolatedImplDeadline — idle-based cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("REGRESSION mtv9v1xu7615: a child still emitting past 900s is NOT cancelled", async () => {
    // The measured cadence was 196 events / 900s ≈ 4.6s. 6s is the slower,
    // more conservative reading of the same run and is what the message
    // builder's own doc records, so use it.
    const child = emittingChild({ cadenceMs: 6_000, emitForMs: 1_200_000 });
    const p = runIsolatedImplWithDeadline({
      runIsolatedTask: child.task,
      request: REQUEST,
      sprintN: 3,
      totalMs: getIsolatedImplCeilingMs(),
      idleMs: getIsolatedImplIdleTimeoutMs(),
    });
    const state = track(p);

    // 1200s of steady work — well past the 900s flat budget that killed it.
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(child.emitted).toBeGreaterThan(150);
    expect(state.settled).toBe(false);

    child.finish({ success: true, output: "28 [Fact] tests written" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toMatchObject({ success: true });
  });

  it("cancels after the idle window when the child goes silent, long before the old budget", async () => {
    const child = emittingChild({ cadenceMs: 6_000, emitForMs: 0 }); // never emits
    const p = runIsolatedImplWithDeadline({
      runIsolatedTask: child.task,
      request: REQUEST,
      sprintN: 4,
      totalMs: 3_600_000,
      idleMs: 240_000,
    });
    const state = track(p);

    await vi.advanceTimersByTimeAsync(239_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.rejected).toBe(true);
    expect(Date.now()).toBeLessThan(OLD_FLAT_BUDGET_MS);
    await expect(p).rejects.toThrow(/no sub-agent activity for 240s/);
  });

  it("WEDGE mrhc43f0fb9b: 2 files written, final llm-done, then silence — caught in ~4min not 30+", async () => {
    // The doc comment on withIsolatedImplDeadline records this run: the
    // isolated impl wrote 2 files, emitted its final llm-done, then sat idle
    // for 30+ minutes. The silence starts immediately, so the idle window must
    // catch it far sooner than the old 900s flat budget ever did.
    const child = emittingChild({ cadenceMs: 5_000, emitForMs: 10_000 }); // 2 events, then quiet
    const p = runIsolatedImplWithDeadline({
      runIsolatedTask: child.task,
      request: REQUEST,
      sprintN: 1,
      totalMs: 3_600_000,
      idleMs: 240_000,
    });
    const state = track(p);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.emitted).toBe(2);

    await vi.advanceTimersByTimeAsync(241_000);
    expect(state.rejected).toBe(true);
    // Last event at t=10_000, idle window 240_000 → fires at ~250_000.
    expect(Date.now()).toBeLessThan(300_000);
    expect(Date.now()).toBeLessThan(OLD_FLAT_BUDGET_MS);
    await expect(p).rejects.toThrow(/no sub-agent activity for 240s/);
  });

  it("the absolute ceiling still cancels a child that emits forever", async () => {
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

  it("aborts the child on an IDLE cancellation, not merely un-awaits it", async () => {
    let seen: AbortSignal | undefined;
    const task = async (_req: TaskRequest, o?: TaskOpts): Promise<ToolResult> => {
      seen = o?.abortSignal;
      return new Promise<ToolResult>(() => {});
    };
    const p = runIsolatedImplWithDeadline({
      runIsolatedTask: task,
      request: REQUEST,
      sprintN: 2,
      totalMs: 3_600_000,
      idleMs: 30_000,
    });
    const state = track(p);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(state.rejected).toBe(true);
    expect(seen?.aborted).toBe(true);
    await expect(p).rejects.toThrow(/CANCELLED/);
  });

  it("keeps disabling the deadline entirely when totalMs <= 0", async () => {
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
    expect(state.settled).toBe(false); // no idle guard either — fully disabled
    child.finish({ success: true, output: "ok" });
    await expect(p).resolves.toMatchObject({ success: true });
  });

  it("falls back to the flat totalMs budget when no activity signal is wired", async () => {
    // No `observe` → every instant looks identical to silence, so an idle rule
    // is unusable. Degrade to exactly the pre-existing flat behaviour rather
    // than never timing out (which would reinstate the mrhc43f0fb9b wedge).
    const p = withIsolatedImplDeadline(() => new Promise<string>(() => {}), 50_000, 8, undefined, 10_000);
    const state = track(p);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.settled).toBe(false); // the 10s idle window did NOT arm
    await vi.advanceTimersByTimeAsync(31_000);
    expect(state.rejected).toBe(true);
    await expect(p).rejects.toThrow(/total watchdog/);
  });
});

describe("the two cancellations must read differently", () => {
  it("idle names the silence; ceiling names the ceiling", () => {
    const now = 1_000_000;
    const idleMsg = buildIsolatedImplTimeoutMessage({
      sprintN: 3,
      cause: "idle",
      totalMs: 3_600_000,
      idleMs: 240_000,
      elapsedMs: 512_400,
      firedAtMs: now,
      observation: { events: 12, lastEventAtMs: now - 240_000 },
    });
    const ceilingMsg = buildIsolatedImplTimeoutMessage({
      sprintN: 3,
      cause: "ceiling",
      totalMs: 3_600_000,
      idleMs: 240_000,
      elapsedMs: 3_600_100,
      firedAtMs: now,
      observation: { events: 600, lastEventAtMs: now - 800 },
    });

    expect(idleMsg).not.toBe(ceilingMsg);
    expect(idleMsg).toMatch(/no sub-agent activity for 240s/);
    expect(idleMsg).not.toMatch(/absolute ceiling was reached/i);
    expect(ceilingMsg).toMatch(/absolute ceiling/i);
    expect(ceilingMsg).not.toMatch(/no sub-agent activity for/);
    // Both still refuse to assert a cause they did not measure.
    expect(idleMsg).toContain("cause not diagnosed");
    expect(ceilingMsg).toContain("cause not diagnosed");
  });

  it("the idle message states the ceiling it did NOT reach, so the two are not confusable", () => {
    const msg = buildIsolatedImplTimeoutMessage({
      sprintN: 1,
      cause: "idle",
      totalMs: 3_600_000,
      idleMs: 240_000,
      elapsedMs: 250_000,
      observation: { events: 2, lastEventAtMs: 10_000 },
      firedAtMs: 250_000,
    });
    expect(msg).toMatch(/3600s absolute ceiling was NOT reached/);
  });

  it("the ceiling message says the child was inside its idle budget when it was cut", () => {
    const now = 5_000_000;
    const msg = buildIsolatedImplTimeoutMessage({
      sprintN: 2,
      cause: "ceiling",
      totalMs: 3_600_000,
      idleMs: 240_000,
      elapsedMs: 3_600_000,
      firedAtMs: now,
      observation: { events: 600, lastEventAtMs: now - 800 },
    });
    expect(msg).toMatch(/still emitting when it was cancelled/);
    expect(msg).toMatch(/absolute ceiling/i);
  });
});

describe("call-site wiring (gate 4) — runSprint must pass BOTH bounds", () => {
  it("runSprint hands the isolated deadline the idle window and the ceiling, not the flat budget", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../sprint-runner.ts", import.meta.url)), "utf8");
    expect(src).toContain("totalMs: getIsolatedImplCeilingMs(),");
    expect(src).toContain("idleMs: getIsolatedImplIdleTimeoutMs(),");
    // The flat 15-min budget must no longer bound the isolated path — that is
    // the constant that cut run mtv9v1xu7615 at 900s while it was working.
    expect(src).not.toMatch(/totalMs:\s*getImplTotalTimeoutMs\(\),\s*\n\s*sprintN,/);
  });
});
