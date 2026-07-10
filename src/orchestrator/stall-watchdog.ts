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
  /** Call on every received stream chunk to reset the any-activity stall timer. */
  pet(): void;
  /**
   * Call ONLY on real forward-progress chunks (a text-delta or a tool-call) to
   * reset the no-forward-progress timer. No-op when the watchdog was created
   * without a progressTimeoutMs. This is what makes the guard catch a reasoning
   * model stuck in an endless chain-of-thought: `pet()` (called on EVERY chunk,
   * including reasoning-delta) keeps the any-activity timer alive, but the
   * progress timer only survives if actual output flows.
   */
  petProgress(): void;
  /** Stop the timers (call when the stream completes or errors). Idempotent. */
  dispose(): void;
  /** True iff the watchdog aborted the stream because of a stall. */
  fired(): boolean;
}

/** Options for the second (no-forward-progress) timer of a stall watchdog. */
export interface StallWatchdogProgressOpts {
  /**
   * If > 0, arm a SECOND timer that is reset only by petProgress() (real
   * output), not by pet() (any chunk). Aborts the same signal when no forward
   * progress happens for this long — catching runaway reasoning that keeps the
   * any-activity timer alive with reasoning-delta chunks. <= 0 disables it.
   */
  progressTimeoutMs: number;
  /** Called when the no-forward-progress timer fires (before abort). */
  onProgressFire?: () => void;
}

export const STALL_ABORT_REASON = "provider-stall";

/** User-facing message surfaced when the stall watchdog fires. */
export const STALL_ERROR_MESSAGE =
  "Model not responding — no output received within the stall timeout. " +
  "The provider may be out of balance, rate-limited, or unreachable. " +
  "Tune MUONROI_PROVIDER_STALL_TIMEOUT_MS (0 disables) or switch model/provider.";

/** Inputs to the stall re-prompt decision — see {@link shouldRepromptStall}. */
export interface StallRepromptState {
  /** The watchdog fired for this attempt. */
  stallTriggered: boolean;
  /** How many stall re-prompts have already happened this turn. */
  stallRetryCount: number;
  /** Configured cap (getProviderStallRetries); 0 disables re-prompt. */
  maxStallRetries: number;
  /** Real content parts received this attempt (the abort part is NOT counted). */
  chunksThisAttempt: number;
  /** True when no assistant text has flowed this attempt. */
  assistantTextEmpty: boolean;
  /** True on genuine user cancel (never re-prompt over a cancel). */
  aborted: boolean;
}

/**
 * Decide whether a fired stall watchdog should trigger a re-prompt (re-issue
 * the same request) instead of surfacing the stall.
 *
 * ONLY a time-to-first-byte stall qualifies: zero real chunks AND no assistant
 * text this attempt, under the retry cap, and not a user cancel. Re-issuing
 * after tools ran or text flowed would corrupt/duplicate output — those cases
 * fall through to the partial-answer rescue path instead. Pure (no side
 * effects) so it is unit-testable in isolation from the orchestrator loop.
 */
export function shouldRepromptStall(s: StallRepromptState): boolean {
  return (
    s.stallTriggered &&
    s.stallRetryCount < s.maxStallRetries &&
    s.chunksThisAttempt === 0 &&
    s.assistantTextEmpty &&
    !s.aborted
  );
}

/** Inputs to the mid-loop stall continuation decision — see {@link shouldContinueAfterMidLoopStall}. */
export interface MidLoopStallState {
  /** The watchdog fired for this attempt. */
  stallTriggered: boolean;
  /**
   * Real content parts received across the WHOLE streamText attempt (all steps).
   * `> 0` proves earlier tool steps already ran — so this is NOT a time-to-first-
   * byte stall (that case is handled by {@link shouldRepromptStall}).
   */
  chunksThisAttempt: number;
  /**
   * Real content parts received since the last step boundary (reset in
   * `prepareStep`). `0` means the in-flight step's provider request produced no
   * byte before the watchdog fired — a dead socket on a SINGLE step, with every
   * prior step fully completed. Safe to continue: the completed steps'
   * assistant+tool messages are appended to history before re-issuing, so no
   * tool is re-run and no text is duplicated.
   */
  chunksThisStep: number;
  /** How many mid-loop continuations have already happened this turn. */
  retryCount: number;
  /** Configured cap (getProviderStallRetries); 0 disables continuation. */
  maxRetries: number;
  /** True on genuine user cancel (never continue over a cancel). */
  aborted: boolean;
}

/**
 * Decide whether a fired stall watchdog should CONTINUE the turn (append the
 * completed steps' messages, then re-issue streamText to resume from the
 * stalled step) instead of falling through to the partial-answer rescue.
 *
 * This is the mid-loop counterpart to {@link shouldRepromptStall}. The TTFB
 * re-prompt restarts the WHOLE request from the original prompt, so it is gated
 * on `chunksThisAttempt === 0` to avoid re-running tools. Continuation instead
 * preserves all completed steps in history (assistant tool-calls + their
 * tool-results), so re-issuing cannot re-run a tool — making it safe even when
 * earlier steps had side effects (writes, commits).
 *
 * Qualifies ONLY when: the watchdog fired, earlier steps ran
 * (`chunksThisAttempt > 0`), the CURRENT step produced nothing
 * (`chunksThisStep === 0` → a clean dead socket, no partial text to duplicate),
 * under the retry cap, and not a user cancel. A step that emitted partial text
 * then stalled (`chunksThisStep > 0`) falls through to rescue instead, since
 * re-issuing would duplicate that partial output. Pure (no side effects) so it
 * is unit-testable in isolation from the orchestrator loop.
 */
export function shouldContinueAfterMidLoopStall(s: MidLoopStallState): boolean {
  return (
    s.stallTriggered && s.chunksThisAttempt > 0 && s.chunksThisStep === 0 && s.retryCount < s.maxRetries && !s.aborted
  );
}

/**
 * Exponential backoff (ms, capped at 4s) before the Nth stall re-prompt
 * (1-based): 500 → 1000 → 2000 → 4000 → 4000.
 */
export function stallRepromptBackoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (Math.max(1, attempt) - 1), 4_000);
}

export function createStallWatchdog(
  timeoutMs: number,
  onFire?: () => void,
  progressOpts?: StallWatchdogProgressOpts,
): StallWatchdog {
  const controller = new AbortController();
  let firedFlag = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const enabled = Number.isFinite(timeoutMs) && timeoutMs > 0;

  const progressTimeoutMs = progressOpts?.progressTimeoutMs ?? 0;
  const progressEnabled = Number.isFinite(progressTimeoutMs) && progressTimeoutMs > 0;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;

  const fire = (onSpecificFire?: () => void) => {
    if (firedFlag) return;
    firedFlag = true;
    // Stop the OTHER timer so it can't also fire after the abort (e.g. the
    // any-activity stall timer that was armed just before the progress timer
    // tripped — otherwise both onFire callbacks would run).
    clearBoth();
    // DOMException(TimeoutError) mirrors AbortSignal.timeout() semantics so
    // downstream isAbortError-style checks treat it as an abort.
    controller.abort(new DOMException(STALL_ABORT_REASON, "TimeoutError"));
    try {
      onSpecificFire?.();
    } catch {
      /* callback must not break the watchdog */
    }
  };

  const arm = () => {
    if (!enabled) return;
    timer = setTimeout(() => fire(onFire), timeoutMs);
    // Don't keep the event loop alive solely for the watchdog (Node).
    (timer as { unref?: () => void }).unref?.();
  };

  const armProgress = () => {
    if (!progressEnabled) return;
    progressTimer = setTimeout(() => fire(progressOpts?.onProgressFire), progressTimeoutMs);
    (progressTimer as { unref?: () => void }).unref?.();
  };

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const clearProgress = () => {
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
  };

  function clearBoth() {
    clear();
    clearProgress();
  }

  arm();
  armProgress();

  return {
    signal: controller.signal,
    pet() {
      if (!enabled || firedFlag) return;
      clear();
      arm();
    },
    petProgress() {
      if (!progressEnabled || firedFlag) return;
      clearProgress();
      armProgress();
    },
    dispose() {
      clear();
      clearProgress();
    },
    fired() {
      return firedFlag;
    },
  };
}
