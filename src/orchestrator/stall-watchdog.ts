/**
 * src/orchestrator/stall-watchdog.ts
 *
 * Time-to-next-chunk watchdog for streaming model calls.
 *
 * Root cause it addresses (observed live, 2026-05-31): a provider connection
 * can accept the request but never send a response chunk (e.g. an overloaded /
 * stalled backend). `streamText` has no built-in time-to-first-byte timeout, so
 * the `for await (...result.fullStream)` loop blocks forever — the agent looks
 * frozen with ZERO user feedback (no error, no toast). Cheap/free providers hit
 * this often (balance, rate, flaky routing).
 *
 * The watchdog exposes an AbortSignal that the caller combines into the
 * streamText abortSignal. If no chunk arrives within `timeoutMs`, it aborts the
 * stream with a TimeoutError. `pet()` is called on every received chunk to
 * re-arm the timer, so the guard covers BOTH the first chunk and any mid-stream
 * stall — without killing a stream that is actively producing output.
 *
 * `timeoutMs <= 0` disables the watchdog (signal never fires).
 */

export interface StallWatchdog {
  /** Combine this into the streamText abortSignal. */
  readonly signal: AbortSignal;
  /** Call on every received stream chunk to reset the stall timer. */
  pet(): void;
  /** Stop the timer (call when the stream completes or errors). Idempotent. */
  dispose(): void;
  /** True iff the watchdog aborted the stream because of a stall. */
  fired(): boolean;
}

export const STALL_ABORT_REASON = "provider-stall";

/** User-facing message surfaced when the stall watchdog fires. */
export const STALL_ERROR_MESSAGE =
  "Model not responding — no output received within the stall timeout. " +
  "The provider may be out of balance, rate-limited, or unreachable. " +
  "Tune MUONROI_PROVIDER_STALL_TIMEOUT_MS (0 disables) or switch model/provider.";

export function createStallWatchdog(timeoutMs: number, onFire?: () => void): StallWatchdog {
  const controller = new AbortController();
  let firedFlag = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const enabled = Number.isFinite(timeoutMs) && timeoutMs > 0;

  const arm = () => {
    if (!enabled) return;
    timer = setTimeout(() => {
      firedFlag = true;
      // DOMException(TimeoutError) mirrors AbortSignal.timeout() semantics so
      // downstream isAbortError-style checks treat it as an abort.
      controller.abort(new DOMException(STALL_ABORT_REASON, "TimeoutError"));
      try {
        onFire?.();
      } catch {
        /* callback must not break the watchdog */
      }
    }, timeoutMs);
    // Don't keep the event loop alive solely for the watchdog (Node).
    (timer as { unref?: () => void }).unref?.();
  };

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  arm();

  return {
    signal: controller.signal,
    pet() {
      if (!enabled || firedFlag) return;
      clear();
      arm();
    },
    dispose() {
      clear();
    },
    fired() {
      return firedFlag;
    },
  };
}
