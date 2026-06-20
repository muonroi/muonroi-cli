/**
 * withDeadlineRace abort-grace: a provider that ignores its abortSignal mid-call
 * must not keep the caller blocked until the (minutes-long) wall-clock deadline.
 * When the user-abort signal fires, the race rejects within a short grace window.
 */
import { describe, expect, it } from "vitest";
import { withDeadlineRace } from "../llm-deadline.js";

describe("withDeadlineRace — abort grace", () => {
  it("rejects shortly after abort even when fn() never settles", async () => {
    const ac = new AbortController();
    const neverSettles = () => new Promise<string>(() => {}); // simulates a stalled provider
    const start = Date.now();
    setTimeout(() => ac.abort(new Error("user pressed Esc")), 40);
    await expect(withDeadlineRace(neverSettles, 60_000, "test", ac.signal, 80)).rejects.toThrow(/aborted by user/);
    // Must unblock far before the 60s deadline.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("already cancelled"));
    const neverSettles = () => new Promise<string>(() => {});
    await expect(withDeadlineRace(neverSettles, 60_000, "test", ac.signal, 50)).rejects.toThrow(/aborted by user/);
  });

  it("returns the fn() result when it settles before any abort", async () => {
    const ac = new AbortController();
    await expect(withDeadlineRace(() => Promise.resolve("ok"), 60_000, "test", ac.signal, 80)).resolves.toBe("ok");
  });

  it("still enforces the wall-clock deadline when no signal is passed (back-compat)", async () => {
    const neverSettles = () => new Promise<string>(() => {});
    await expect(withDeadlineRace(neverSettles, 60, "test")).rejects.toThrow(/deadline/);
  });
});
