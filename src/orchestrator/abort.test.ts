import { describe, expect, it } from "vitest";
import { createAbortContext } from "./abort.js";

describe("AbortContext", () => {
  it("Test 1: initial state — not aborted", () => {
    const ctx = createAbortContext();
    expect(ctx.signal.aborted).toBe(false);
    expect(ctx.isAborted()).toBe(false);
    expect(ctx.reason()).toBeUndefined();
  });

  it("Test 1: after abort — signal is aborted and reason is captured", () => {
    const ctx = createAbortContext();
    ctx.abort("test");
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.isAborted()).toBe(true);
    expect(ctx.reason()).toBe("test");
  });

  it("Test 2: abort is idempotent — second call does not throw", () => {
    const ctx = createAbortContext();
    expect(() => {
      ctx.abort("first");
      ctx.abort("second");
    }).not.toThrow();
    // Reason captured from first call only
    expect(ctx.reason()).toBe("first");
  });

  it("Test 2: abort with no reason is idempotent", () => {
    const ctx = createAbortContext();
    ctx.abort();
    ctx.abort("later");
    expect(ctx.isAborted()).toBe(true);
    expect(ctx.reason()).toBeUndefined();
  });
});
