import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDeadlineRace, withTimeoutSignal } from "../llm-deadline.js";

async function advanceTimersAsync(ms: number) {
  if (typeof (vi as any).advanceTimersByTimeAsync === "function") {
    await (vi as any).advanceTimersByTimeAsync(ms);
  } else {
    vi.advanceTimersByTime(ms);
    // Flush microtasks in Bun/older Node
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }
}

describe("withDeadlineRace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves with the value when fn settles before the deadline", async () => {
    const p = withDeadlineRace(async () => "ok", 1000, "test-call");
    await advanceTimersAsync(10);
    await expect(p).resolves.toBe("ok");
  });

  it("rejects with a labelled timeout error when fn exceeds the deadline", async () => {
    // A never-settling fn (e.g. a wedged provider response) must NOT hang the
    // caller — withDeadlineRace guarantees rejection at the deadline regardless
    // of whether the underlying SDK honours its abort signal.
    const p = withDeadlineRace(() => new Promise<string>(() => {}), 500, "plan_debate");
    const assertion = expect(p).rejects.toThrow(/plan_debate exceeded 500ms deadline/);
    await advanceTimersAsync(600);
    await assertion;
  });
});

describe("withTimeoutSignal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns a signal that is not aborted before the timeout", () => {
    const { signal, cleanup } = withTimeoutSignal(undefined, 1000);
    expect(signal.aborted).toBe(false);
    cleanup();
  });

  it("aborts the signal once the timeout elapses", async () => {
    const { signal } = withTimeoutSignal(undefined, 200);
    expect(signal.aborted).toBe(false);
    await advanceTimersAsync(250);
    expect(signal.aborted).toBe(true);
  });

  it("aborts immediately when the parent signal is already aborted", () => {
    const parent = AbortSignal.abort(new Error("parent gone"));
    const { signal, cleanup } = withTimeoutSignal(parent, 1000);
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it("propagates a later parent abort to the combined signal", () => {
    const controller = new AbortController();
    const { signal, cleanup } = withTimeoutSignal(controller.signal, 5000);
    expect(signal.aborted).toBe(false);
    controller.abort(new Error("parent aborted late"));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it("cleanup clears the timer so the signal never aborts afterwards", async () => {
    const { signal, cleanup } = withTimeoutSignal(undefined, 200);
    cleanup();
    await advanceTimersAsync(500);
    expect(signal.aborted).toBe(false);
  });
});
