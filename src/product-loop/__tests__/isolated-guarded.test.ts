/**
 * D9 — direct unit coverage of `runIsolatedGuarded`'s observation-enrichment
 * behaviour (`plan-adherence-review.ts`). `verify-fix-loop.test.ts` covers the
 * higher-level wiring (the fixer's own dedicated deadline); this suite pins
 * the lower-level primitive both that loop and the two existing
 * plan-adherence call sites share.
 */

import { describe, expect, it, vi } from "vitest";
import type { TaskRequest, ToolResult } from "../../types/index.js";
import { type IsolatedGuardObservation, runIsolatedGuarded } from "../plan-adherence-review.js";

const req: TaskRequest = { agent: "general", description: "test task", prompt: "do the thing" };

describe("runIsolatedGuarded — backward compatibility (no guardOpts)", () => {
  it("a caller that passes no guardOpts gets functionally identical behaviour: run's opts argument is undefined", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ success: true, output: "done" }));
    const result = await runIsolatedGuarded(run, req, "test-label");
    expect(result).toEqual({ success: true, output: "done" });
    expect(run).toHaveBeenCalledWith(req, undefined);
  });

  it("a timeout with no observation supplied reports only the base deadline message", async () => {
    const run = vi.fn(() => new Promise<ToolResult>(() => {})); // never settles
    const result = await runIsolatedGuarded(run, req, "test-label", { deadlineMs: 5 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("test-label exceeded 5ms deadline");
    // No observation was supplied, so no enrichment is appended.
    expect(result.error).not.toContain("observed");
  });
});

describe("runIsolatedGuarded — D9 observation enrichment", () => {
  it("a successful call fills the observation but the result is untouched", async () => {
    const observation: IsolatedGuardObservation = { events: 0, lastEventAtMs: null };
    const run = vi.fn(
      async (_r: TaskRequest, opts?: { onActivity?: (detail: string) => void }): Promise<ToolResult> => {
        opts?.onActivity?.("ran a tool");
        return { success: true, output: "done" };
      },
    );
    const result = await runIsolatedGuarded(run, req, "test-label", { observation });
    expect(result).toEqual({ success: true, output: "done" });
    expect(observation.events).toBe(1);
    expect(observation.lastDetail).toBe("ran a tool");
    expect(observation.lastEventAtMs).not.toBeNull();
  });

  it("a timeout with activity observed enriches the error with the event count and last detail", async () => {
    const observation: IsolatedGuardObservation = { events: 0, lastEventAtMs: null };
    const run = vi.fn((_r: TaskRequest, opts?: { onActivity?: (detail: string) => void }) => {
      opts?.onActivity?.("editing src/foo.ts");
      return new Promise<ToolResult>(() => {}); // never settles — forces the deadline race to fire
    });
    const result = await runIsolatedGuarded(run, req, "test-label", { deadlineMs: 5, observation });
    expect(result.success).toBe(false);
    expect(result.error).toContain("test-label exceeded 5ms deadline");
    expect(result.error).toContain("observed 1 sub-agent activity event(s)");
    expect(result.error).toContain("last activity: editing src/foo.ts");
  });

  it("a timeout with ZERO activity observed says so explicitly, distinguishing silence from a wedge", async () => {
    const observation: IsolatedGuardObservation = { events: 0, lastEventAtMs: null };
    const run = vi.fn(() => new Promise<ToolResult>(() => {}));
    const result = await runIsolatedGuarded(run, req, "test-label", { deadlineMs: 5, observation });
    expect(result.error).toContain("observed 0 sub-agent activity events before the timeout");
  });

  it("a custom deadlineMs overrides the generic isolated-task ceiling", async () => {
    const run = vi.fn(() => new Promise<ToolResult>(() => {}));
    const start = Date.now();
    const result = await runIsolatedGuarded(run, req, "test-label", { deadlineMs: 10 });
    const elapsed = Date.now() - start;
    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeded 10ms deadline");
    // Sanity: it actually used the SMALL override, not the 900_000ms default.
    expect(elapsed).toBeLessThan(5_000);
  });
});
