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

import { logger } from "../utils/logger.js";

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
  /**
   * Optional gate consulted the instant a timer would fire. When it returns
   * true the watchdog RE-ARMS instead of aborting — used to hold the stream
   * open while a blocking interactive card (`ask_user`) awaits a human, without
   * counting that wait as a provider stall.
   */
  shouldSuppressFire?: () => boolean,
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
    timer = setTimeout(() => {
      // Hold open (re-arm) while an interactive card blocks the turn — the
      // human is thinking, not a stalled provider.
      if (shouldSuppressFire?.()) {
        arm();
        return;
      }
      fire(onFire);
    }, timeoutMs);
    // Don't keep the event loop alive solely for the watchdog (Node).
    (timer as { unref?: () => void }).unref?.();
  };

  const armProgress = () => {
    if (!progressEnabled) return;
    progressTimer = setTimeout(() => {
      if (shouldSuppressFire?.()) {
        armProgress();
        return;
      }
      fire(progressOpts?.onProgressFire);
    }, progressTimeoutMs);
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

// ─────────────────────────────────────────────────────────────────────────────
// Failing-tool-loop guard (N3) — "forward progress" must mean USEFULNESS
// ─────────────────────────────────────────────────────────────────────────────
//
// Root cause it addresses (measured): `petProgress()` above is called on a
// text-delta OR a tool-call, so a sub-agent that emits a tool call every ~6s
// resets the no-forward-progress timer forever even when every one of those
// calls fails identically. A degenerate sub-agent ran 176 steps / 1116s /
// ~7.45M input tokens that way; the largest inter-step gap over the whole run
// was 30.5s, so NO time-based threshold could have caught it without killing
// healthy runs (a healthy run's largest measured gap is 30.2s).
//
// The discriminator is not timing, it is the RESULT: N consecutive tool results
// that are failures of the same *class*. Class, not literal string, because the
// looping calls carried differing arguments — which is exactly why the existing
// `tool-repetition-detector.ts` (keyed on toolName + hash(input) + hash(error))
// never fired: its callKey changed on every iteration.
//
// Verified against the local interaction DB (~/.muonroi-cli/muonroi.db,
// tool_calls join tool_results, 647 calls across 14 sessions): the longest run
// of consecutive same-class tool failures was 1 in 12 sessions and 2 in one
// session; a single degenerate session contained runs of 12 and 8 — all
// `read_file` returning `ERROR: Failed to read file: The "path" property must
// be of type string, got undefined` with DIFFERENT arguments each time.
// N = 8 therefore sits 4x above the observed healthy maximum and still catches
// both degenerate runs.

/** Default consecutive same-class tool failures that terminate a sub-agent turn. */
const DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD = 8;

/** Abort reason attached to the signal when the failing-tool-loop guard fires. */
export const TOOL_FAILURE_LOOP_ABORT_REASON = "tool-failure-loop";

/**
 * N for the failing-tool-loop guard. `MUONROI_TOOL_FAILURE_LOOP_N` overrides;
 * a value below 2 disables the guard entirely. Clamped to at most 200 so a
 * typo cannot make the guard fire on the first failure.
 */
export function getToolFailureLoopThreshold(): number {
  const raw = process.env.MUONROI_TOOL_FAILURE_LOOP_N?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD;
  if (parsed < 2) return 0; // explicit opt-out
  return Math.min(parsed, 200);
}

/**
 * Reduce a tool failure message to its error CLASS: the same underlying
 * failure with different arguments must produce the same key, and two
 * genuinely different failures must not.
 *
 * Erases the parts that vary per call (paths, quoted operands, numbers) and
 * keeps the failure's prose. `ERROR: File not found: D:\a\b.ts` and
 * `ERROR: File not found: /x/y.ts` both become `file not found: <path>`.
 */
export function normalizeToolErrorClass(raw: string): string {
  return raw
    .replace(/^\s*"?\s*ERROR:\s*/i, "")
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s"'`,)\]]*/g, "<path>") // windows absolute
    .replace(/(?:[\\/][^\s"'`,)\]\\/]+){2,}/g, "<path>") // posix / nested relative
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<q>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Classify one tool result. Returns the failure class key, or `null` when the
 * result is not a failure (which RESETS the run — a single useful tool result
 * proves the sub-agent is still making progress).
 *
 * A builtin tool never throws: `registry.ts:formatResult` renders a failed
 * `ToolResult` as the string `ERROR: <message>` and the AI SDK delivers it as a
 * normal `tool-result` part. So a leading `ERROR:` is the repo's own failure
 * marker, matched deliberately narrowly — matching "error" anywhere would class
 * a successful `grep` for the word "error" as a failure.
 */
export function toolFailureClass(toolName: string, output: unknown, isToolErrorPart = false): string | null {
  let text: string;
  if (typeof output === "string") text = output;
  else if (output instanceof Error) text = output.message;
  else if (output === undefined || output === null) text = isToolErrorPart ? "unknown tool error" : "";
  else {
    try {
      text = JSON.stringify(output) ?? String(output);
    } catch (err) {
      // No-Silent-Catch: a non-serializable tool payload is expected (cycles,
      // class instances); record why we fell back to String() rather than hide it.
      logger.debug("orchestrator", "[stall-watchdog] tool output not JSON-serializable; using String()", {
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      text = String(output);
    }
  }
  const head = text.slice(0, 400);
  if (!isToolErrorPart && !/^\s*"?\s*ERROR:/i.test(head)) return null;
  return `${toolName}|${normalizeToolErrorClass(head)}`;
}

/** One `record()` outcome — see {@link createToolFailureLoopDetector}. */
export interface ToolFailureLoopOutcome {
  /** Failure class of THIS result, or null when it was not a failure. */
  failureClass: string | null;
  /** Length of the current consecutive same-class failure run (0 when reset). */
  runLength: number;
  /** True exactly once, on the result that reaches the threshold. */
  tripped: boolean;
}

/** Stateful run-length counter over a sub-agent's tool results. */
export interface ToolFailureLoopDetector {
  /** Feed one tool result (or tool-error part). */
  record(toolName: string, output: unknown, isToolErrorPart?: boolean): ToolFailureLoopOutcome;
  /** Current consecutive same-class failure run length. */
  runLength(): number;
  /** The class currently being repeated, or null. */
  currentClass(): string | null;
  /** Verbatim text of the most recent failure (for the abort message). */
  lastFailureText(): string;
}

/**
 * Create the detector. A threshold below 2 disables it (record() always reports
 * `tripped: false`, so the caller needs no extra flag).
 */
export function createToolFailureLoopDetector(
  threshold: number = getToolFailureLoopThreshold(),
): ToolFailureLoopDetector {
  const enabled = Number.isFinite(threshold) && threshold >= 2;
  let currentClass: string | null = null;
  let runLength = 0;
  let lastText = "";
  let trippedAlready = false;

  return {
    record(toolName, output, isToolErrorPart = false) {
      const failureClass = toolFailureClass(toolName, output, isToolErrorPart);
      if (failureClass === null) {
        // A non-failure result is real forward progress — reset the run.
        currentClass = null;
        runLength = 0;
        trippedAlready = false;
        return { failureClass: null, runLength: 0, tripped: false };
      }
      if (failureClass === currentClass) {
        runLength += 1;
      } else {
        currentClass = failureClass;
        runLength = 1;
        trippedAlready = false;
      }
      lastText = typeof output === "string" ? output : String((output as Error)?.message ?? output);
      const tripped = enabled && runLength >= threshold && !trippedAlready;
      if (tripped) trippedAlready = true;
      return { failureClass, runLength, tripped };
    },
    runLength: () => runLength,
    currentClass: () => currentClass,
    lastFailureText: () => lastText,
  };
}

/**
 * Message surfaced when the guard fires. Returned as the sub-agent's
 * `ToolResult.output`, which is what `resolveImplFailureReason`
 * (product-loop/sprint-runner.ts) reports as the sprint's failure reason — so
 * the sprint says WHY it stopped instead of "isolated implementation task failed".
 */
export function buildToolFailureLoopMessage(toolName: string, runLength: number, lastFailureText: string): string {
  const snippet = lastFailureText.slice(0, 240).replace(/\s+/g, " ").trim();
  return (
    `[tool-failure-loop abort] The sub-agent turn was terminated: "${toolName}" returned the same class of ` +
    `failure ${runLength} times in a row with no successful tool result in between, so no forward progress ` +
    `was being made (emitting tool calls is not progress).\n` +
    `Last failure: ${snippet}`
  );
}
