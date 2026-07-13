// src/council/__tests__/generate-stall-guard.test.ts
//
// Diagnostic (round 1) for the /ideal wedge: reproduce the exact guard
// composition `createCouncilLLM.generate` wraps around its streaming call —
//   withDeadlineRace( () => withVisibleRetry( () => <stream> ), deadline, signal )
// — against the three ways a deepseek stream can misbehave, and assert the CALLER
// always unblocks. If any of these HANG, the bug is in the guard composition. If
// they all pass (as expected — the primitives are already unit-tested), the guard
// is sound and the live hang must be an UNGUARDED call site or a different await,
// which then justifies live logging (round 2) rather than a blind patch here.
//
// Real timers + tiny delays → fast. The util deadline has no [60s,30min] clamp
// (that clamp lives only in COUNCIL_LLM_TIMEOUT_MS / getIsolatedTaskDeadlineMs),
// so we can exercise the same composition at millisecond scale.

import { describe, expect, it } from "vitest";
import { withDeadlineRace } from "../../utils/llm-deadline.js";
import { withVisibleRetry } from "../../utils/visible-retry.js";

const DEADLINE = 150;

/** Mimics collectStreamText parking on a dead stream that never yields/closes. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** A retryable failure (503) — drives withVisibleRetry's backoff loop. */
function throwsRetryable(): Promise<never> {
  return Promise.reject(Object.assign(new Error("503 upstream stalled"), { statusCode: 503 }));
}

describe("createCouncilLLM.generate guard composition (diagnostic)", () => {
  it("H1: a parked stream (never settles, abort ignored) → caller rejects at the deadline", async () => {
    const start = Date.now();
    await expect(
      withDeadlineRace(
        () => withVisibleRetry(() => neverSettles<string>(), { label: "council.generate" }),
        DEADLINE,
        "council.generate",
      ),
    ).rejects.toThrow(/council\.generate exceeded 150ms deadline/);
    // Sanity: it unblocked roughly at the deadline, not after minutes.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("H2: a retryable-error loop does NOT defeat the deadline (retry backoff is capped)", async () => {
    // Fast backoff so several retries fit under the deadline, proving the
    // withVisibleRetry loop cannot outlive the withDeadlineRace cap.
    const start = Date.now();
    await expect(
      withDeadlineRace(
        () =>
          withVisibleRetry(throwsRetryable, {
            label: "council.generate",
            delaysMs: [20, 20, 20, 20, 20],
            onRetry: () => {},
          }),
        DEADLINE,
        "council.generate",
      ),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("H3: a user-abort mid-stall rejects within the grace window (composer never stays locked)", async () => {
    const controller = new AbortController();
    const p = withDeadlineRace(
      () => withVisibleRetry(() => neverSettles<string>(), { label: "council.generate" }),
      60_000, // long deadline — the abort, not the deadline, must be what unblocks
      "council.generate",
      controller.signal,
      200, // abortGraceMs
    );
    const assertion = expect(p).rejects.toThrow(/aborted by user/);
    controller.abort(new Error("user pressed Esc"));
    await assertion;
  });
});
