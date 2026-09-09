/**
 * N3(a)+(c) — the isolated-impl deadline must CANCEL the work it gives up on,
 * and must report only what it measured.
 *
 * Measured defect: `withIsolatedImplDeadline` was a bare `Promise.race` over an
 * already-started promise with no AbortSignal anywhere, and the call site
 * passed none. Losing the race abandoned the child: the watchdog threw at
 * 11:13:44 and the sub-agent ran on to 11:17:24 — 220s and 32 further steps,
 * 29.8% of the entire run's recorded spend, AFTER the run was declared dead.
 *
 * The second defect was the message. It asserted, unconditionally on any
 * timeout, that the turn "never completed (hung on the JS side after its final
 * response; the isolated path has no per-chunk stall guard)". Both halves were
 * false for that run (a tool call every ~6s; the guard exists in
 * stream-runner.ts) — a diagnosis carried over from run mrhc43f0fb9b that cost
 * a later investigation an entire hypothesis.
 *
 * Gate 4 — this repo has twice shipped a helper whose test passed while the
 * real call site passed nothing into it. `runIsolatedImplWithDeadline` IS the
 * production call site (runSprint calls exactly it), so the signal assertions
 * below cannot pass while the wiring is absent.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { TaskRequest, ToolResult } from "../../types/index.js";
import {
  buildIsolatedImplTimeoutMessage,
  runIsolatedImplWithDeadline,
  withIsolatedImplDeadline,
} from "../sprint-runner.js";

const REQUEST: TaskRequest = { agent: "general", description: "Sprint 1 implementation", prompt: "do it" };

describe("withIsolatedImplDeadline — cancellation", () => {
  it("aborts the child's signal when the deadline wins (not merely un-awaits it)", async () => {
    let seen: AbortSignal | undefined;
    const run = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>(() => {}); // never settles
    };
    await expect(withIsolatedImplDeadline(run, 30, 4)).rejects.toThrow(/CANCELLED/);
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(true);
  });

  it("the cancelled task actually STOPS — no further steps after the deadline", async () => {
    let steps = 0;
    const run = async (signal: AbortSignal) => {
      // A step loop that honours cancellation, like a streaming sub-agent turn.
      while (!signal.aborted) {
        steps += 1;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("aborted");
    };
    await expect(withIsolatedImplDeadline(run, 40, 1)).rejects.toThrow(/CANCELLED/);
    const stepsAtDeadline = steps;
    await new Promise((r) => setTimeout(r, 60));
    // The pre-fix behaviour was 32 further steps over 220s. Zero now.
    expect(steps).toBe(stepsAtDeadline);
  });

  it("still hands the task a (never-aborted) signal when the deadline is disabled", async () => {
    let seen: AbortSignal | undefined;
    const out = await withIsolatedImplDeadline(
      async (signal) => {
        seen = signal;
        return "done";
      },
      0,
      2,
    );
    expect(out).toBe("done");
    expect(seen?.aborted).toBe(false);
  });

  it("observes (never leaks) the abandoned task's late rejection", async () => {
    let reject!: (e: Error) => void;
    const run = () => new Promise<string>((_, rj) => (reject = rj));
    await expect(withIsolatedImplDeadline(run, 20, 9)).rejects.toThrow(/CANCELLED/);
    // Late rejection after the race settled must be swallowed-with-logging, not
    // escape as an unhandled rejection.
    expect(() => reject(new Error("late boom"))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("buildIsolatedImplTimeoutMessage — observations, never a narrative", () => {
  it("never repeats the old hardcoded diagnosis", () => {
    const msg = buildIsolatedImplTimeoutMessage({ sprintN: 1, totalMs: 900_000, elapsedMs: 900_100 });
    expect(msg).not.toMatch(/hung on the JS side/);
    expect(msg).not.toMatch(/no per-chunk stall guard/);
    expect(msg).not.toMatch(/never completed/);
    expect(msg).toMatch(/cause not diagnosed/);
  });

  it("reports elapsed time, event count and recency when the child was still emitting", () => {
    const now = Date.now();
    const msg = buildIsolatedImplTimeoutMessage({
      sprintN: 3,
      totalMs: 900_000,
      elapsedMs: 900_140,
      firedAtMs: now,
      observation: { events: 176, lastEventAtMs: now - 4_200 },
    });
    expect(msg).toContain("sprint 3");
    expect(msg).toContain("CANCELLED after 900.1s");
    expect(msg).toContain("176 sub-agent activity event(s)");
    expect(msg).toContain("4.2s before the deadline");
    expect(msg).toContain("still emitting when it was cancelled");
  });

  it("says so plainly when nothing was ever observed", () => {
    const msg = buildIsolatedImplTimeoutMessage({
      sprintN: 2,
      totalMs: 60_000,
      elapsedMs: 60_010,
      observation: { events: 0, lastEventAtMs: null },
    });
    expect(msg).toContain("observed 0 sub-agent activity events");
    expect(msg).toContain("nothing was seen streaming");
  });

  it("distinguishes a child that had gone quiet", () => {
    const now = Date.now();
    const msg = buildIsolatedImplTimeoutMessage({
      sprintN: 5,
      totalMs: 900_000,
      elapsedMs: 900_000,
      firedAtMs: now,
      observation: { events: 4, lastEventAtMs: now - 600_000 },
    });
    expect(msg).toContain("the child had gone quiet");
  });
});

describe("call site — runIsolatedImplWithDeadline (gate 4)", () => {
  it("passes the deadline's OWN signal into runIsolatedTask", async () => {
    const runIsolatedTask = vi.fn(
      async (_req: TaskRequest, opts?: { abortSignal?: AbortSignal }): Promise<ToolResult> => {
        expect(opts?.abortSignal).toBeInstanceOf(AbortSignal);
        expect(opts?.abortSignal?.aborted).toBe(false);
        return { success: true, output: "ok" };
      },
    );
    const res = await runIsolatedImplWithDeadline({
      runIsolatedTask,
      request: REQUEST,
      totalMs: 5_000,
      sprintN: 1,
    });
    expect(res.success).toBe(true);
    expect(runIsolatedTask).toHaveBeenCalledTimes(1);
    expect(runIsolatedTask.mock.calls[0]?.[1]?.abortSignal).toBeDefined();
  });

  it("aborts THAT signal when the deadline fires", async () => {
    let received: AbortSignal | undefined;
    const runIsolatedTask = async (_req: TaskRequest, opts?: { abortSignal?: AbortSignal }): Promise<ToolResult> => {
      received = opts?.abortSignal;
      return new Promise<ToolResult>(() => {});
    };
    await expect(
      runIsolatedImplWithDeadline({ runIsolatedTask, request: REQUEST, totalMs: 30, sprintN: 6 }),
    ).rejects.toThrow(/sprint 6\) and was CANCELLED/);
    expect(received?.aborted).toBe(true);
  });

  it("reports the child's real activity in the timeout message", async () => {
    const runIsolatedTask = async (
      _req: TaskRequest,
      opts?: { onActivity?: (d: string) => void },
    ): Promise<ToolResult> => {
      opts?.onActivity?.("read_file a.ts");
      opts?.onActivity?.("read_file b.ts");
      opts?.onActivity?.("read_file c.ts");
      return new Promise<ToolResult>(() => {});
    };
    await expect(
      runIsolatedImplWithDeadline({ runIsolatedTask, request: REQUEST, totalMs: 40, sprintN: 2 }),
    ).rejects.toThrow(/3 sub-agent activity event\(s\)/);
  });

  it("the production call site in runSprint uses this seam (not a re-implemented race)", () => {
    const src = readFileSync(fileURLToPath(new URL("../sprint-runner.ts", import.meta.url)), "utf8");
    // Exactly one production invocation, inside runSprint's isolated branch.
    const callSites = src.match(/await runIsolatedImplWithDeadline\(\{/g) ?? [];
    expect(callSites).toHaveLength(1);
    expect(src).toContain("runIsolatedTask: ctx.runIsolatedTask,");
    // And no path may go back to racing an already-started promise.
    expect(src).not.toMatch(/withIsolatedImplDeadline\(\s*ctx\.runIsolatedTask\(/);
  });
});
