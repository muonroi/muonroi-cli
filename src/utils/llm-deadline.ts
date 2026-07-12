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
export async function withDeadlineRace<T>(
  fn: () => Promise<T>,
  deadlineMs: number,
  label: string,
  /**
   * User-abort signal. When it fires, the race rejects within `abortGraceMs`
   * even if `fn()` hasn't settled — so a provider that ignores its abortSignal
   * mid-call (observed with DeepSeek/grok socket stalls) can't keep the caller
   * (and, for council, the locked composer) blocked until the full `deadlineMs`.
   * The short grace lets the normal fetch-level abort win first when it's quick.
   */
  abortSignal?: AbortSignal,
  abortGraceMs = 1500,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortTimer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${deadlineMs}ms deadline (timeout)`));
    }, deadlineMs);
  });
  const racers: Array<Promise<T>> = [fn(), deadline as Promise<T>];
  if (abortSignal) {
    const abortRace = new Promise<never>((_, reject) => {
      const arm = () => {
        abortTimer = setTimeout(() => reject(new Error(`${label} aborted by user`)), abortGraceMs);
      };
      if (abortSignal.aborted) arm();
      else {
        abortListener = arm;
        abortSignal.addEventListener("abort", arm, { once: true });
      }
    });
    racers.push(abortRace as Promise<T>);
  }
  try {
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortTimer) clearTimeout(abortTimer);
    if (abortListener && abortSignal) abortSignal.removeEventListener("abort", abortListener);
  }
}

/**
 * Wall-clock backstop (ms) for an isolated sub-agent task (`runIsolatedTask`).
 *
 * The council `generate()` chokepoint and the sprint impl/verify stages already
 * have deadlines, but the *other* `runIsolatedTask` await points — plan-adherence
 * review + fix, council research, grounding-verify — were bare `await`s. A
 * provider that hangs on the JS side after the sub-agent's stream finishes wedges
 * the whole pipeline with no error (observed live: run mrhc43f0fb9b impl, and the
 * scoping stall). Wrap those calls in `withDeadlineRace(fn, getIsolatedTaskDeadlineMs(), ...)`
 * so a hang surfaces as a rejection the caller already handles. Generous by
 * default so a legitimately long tool-using sub-agent is not cut short; override
 * with MUONROI_IDEAL_ISOLATED_TASK_MS. Clamped to [60s, 30min].
 */
export function getIsolatedTaskDeadlineMs(): number {
  const raw = Number.parseInt(process.env.MUONROI_IDEAL_ISOLATED_TASK_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 60_000 && raw <= 1_800_000) return raw;
  return 900_000; // 15 min backstop
}
