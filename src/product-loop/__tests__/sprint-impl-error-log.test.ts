import { beforeEach, describe, expect, it, vi } from "vitest";

const logInteraction = vi.fn();
vi.mock("../../storage/index.js", () => ({
  logInteraction: (...args: unknown[]) => logInteraction(...args),
  logUIInteraction: vi.fn(),
}));

import { logSprintImplError } from "../sprint-runner.js";
import type { DriverContext } from "../types.js";

/**
 * Exercises the REAL `logSprintImplError` against a mocked storage layer.
 *
 * Run mrn9yfle9801 halted in the implementation stage with only
 * `halt_card_open {trigger:"loop_throw"}` on record — the exception text was
 * unrecoverable afterwards, because stderr belongs to the TUI child and the
 * /ideal council path writes no `messages` rows. Two indistinguishable causes
 * produce that halt: an immediate `!result.success`, and a
 * `withIsolatedImplDeadline` watchdog trip. `durationMs` is the only field that
 * separates them, so it is asserted rather than trusted.
 */
describe("logSprintImplError", () => {
  const ctx = { runId: "mrn9yfle9801", sessionId: "74b0de62aeb6" } as unknown as DriverContext;

  beforeEach(() => {
    logInteraction.mockReset();
  });

  it("persists the exception text, impl model and elapsed time", () => {
    logSprintImplError(ctx, {
      sprintN: 1,
      message: "isolated implementation task failed",
      stack: "at foo | at bar",
      implModelId: "gpt-5.4",
      elapsedMs: 1_100,
      isolated: true,
    });

    expect(logInteraction).toHaveBeenCalledTimes(1);
    const [sessionId, eventType, meta] = logInteraction.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(sessionId).toBe("74b0de62aeb6");
    expect(eventType).toBe("council");
    expect(meta.eventSubtype).toBe("sprint_impl_error");
    expect(meta.model).toBe("gpt-5.4");
    // ~1s ⇒ immediate failure, NOT the watchdog. This is the discriminator the
    // halted run lacked.
    expect(meta.durationMs).toBe(1_100);
    const data = meta.data as Record<string, unknown>;
    expect(data.message).toBe("isolated implementation task failed");
    expect(data.runId).toBe("mrn9yfle9801");
    expect(data.isolated).toBe(true);
  });

  it("falls back to runId when no chat session id is threaded", () => {
    logSprintImplError({ runId: "run-1" } as unknown as DriverContext, {
      sprintN: 2,
      message: "boom",
      elapsedMs: 5,
      isolated: false,
    });
    expect((logInteraction.mock.calls[0] as unknown[])[0]).toBe("run-1");
  });

  it("truncates a runaway message so one row cannot blow the text limit", () => {
    logSprintImplError(ctx, { sprintN: 1, message: "x".repeat(9_000), elapsedMs: 1, isolated: true });
    const meta = (logInteraction.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect((meta.data as { message: string }).message.length).toBe(2_000);
  });

  it("omits model when none could be resolved", () => {
    logSprintImplError(ctx, { sprintN: 1, message: "boom", elapsedMs: 1, isolated: true });
    const meta = (logInteraction.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(meta).not.toHaveProperty("model");
  });

  it("swallows a storage failure — the audit trail must not become a second failure", () => {
    logInteraction.mockImplementation(() => {
      throw new Error("db locked");
    });
    expect(() => logSprintImplError(ctx, { sprintN: 1, message: "boom", elapsedMs: 1, isolated: true })).not.toThrow();
  });
});
