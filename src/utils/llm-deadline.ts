/**
 * src/utils/llm-deadline.ts
 *
 * Wall-clock guards for non-streaming LLM calls (generateObject / generateText).
 *
 * Root cause they address (observed live, 2026-06-03 driving OpenAI gpt-5.4-mini
 * via the agent harness): a provider connection can accept a request but never
 * send a response. The streaming path is covered by the time-to-next-chunk
 * stall watchdog (see orchestrator/stall-watchdog.ts), but **non-streaming**
 * pre-flight calls — debate planning, scope-ceiling finalize, etc. — had no
 * guard at all, so `await generateObject(...)` blocked forever and the agent
 * froze with ZERO feedback (no token, no toast).
 *
 * Two complementary helpers (extracted from council/llm.ts so every pre-flight
 * call site shares one implementation):
 *   - `withTimeoutSignal` — an AbortSignal combining a parent signal with a
 *     wall-clock deadline, so the SDK can abort the in-flight HTTP request.
 *   - `withDeadlineRace` — races the call against a deadline so the *caller*
 *     is guaranteed to unblock even when the SDK ignores its abort signal
 *     (observed with some providers mid-tool-execution).
 *
 * Use both together: pass the signal into the call for clean cancellation, and
 * wrap the await in the race for a hard caller-side guarantee.
 */

/**
 * Combine an optional parent AbortSignal with a wall-clock deadline. Returns
 * the merged signal plus a `cleanup` thunk the caller must invoke once the
 * underlying request settles so the timeout timer doesn't keep the process
 * alive past the call.
 */
export function withTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM call exceeded ${timeoutMs}ms deadline (timeout)`));
  }, timeoutMs);
  let parentListener: (() => void) | null = null;
  if (parent) {
    if (parent.aborted) {
      clearTimeout(timer);
      controller.abort(parent.reason);
    } else {
      parentListener = () => controller.abort(parent.reason);
      parent.addEventListener("abort", parentListener, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (parent && parentListener) parent.removeEventListener("abort", parentListener);
    },
  };
}

/**
 * Race a promise against a wall-clock deadline. The AI SDK occasionally fails
 * to honour `abortSignal` mid-call (observed: a provider sitting on a stuck
 * HTTP request — the controller.abort fires but the call keeps awaiting). This
 * race guarantees the surrounding code receives an Error within `deadlineMs`,
 * regardless of what the SDK does internally. The in-flight request should
 * still be aborted via `withTimeoutSignal` for cleanup; this layer just ensures
 * the caller is never blocked past the deadline.
 */
export async function withDeadlineRace<T>(fn: () => Promise<T>, deadlineMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${deadlineMs}ms deadline (timeout)`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
