/**
 * Wraps an LLM call with visible retry progress. AI SDK's built-in retry is
 * silent — when SiliconFlow rate-limits a 5-retry-deep council call, the user
 * sees a 62s blank window and thinks the CLI hung. This wrapper logs each
 * retry attempt + backoff to stderr so they know progress is happening.
 *
 * Pass `maxRetries: 0` to the underlying SDK call to disable its built-in
 * retry, and let this wrapper handle it instead.
 */
export interface VisibleRetryOpts {
  /** Total attempts including the first. Default 6 (1 initial + 5 retries). */
  maxAttempts?: number;
  /** Backoff delays in ms for retries 1..maxAttempts-1. Default [2000, 4000, 8000, 16000, 32000]. */
  delaysMs?: number[];
  /** Label for log messages (e.g. "council.generate", "council.debate"). */
  label?: string;
  /** Hook called before each delay; default writes to stderr. */
  onRetry?: (attempt: number, totalAttempts: number, delayMs: number, error: Error) => void;
}

import { classifyStreamError } from "../orchestrator/retry-classifier.js";

/**
 * Whether a thrown/returned error should trigger a visible retry.
 *
 * Delegates to the single source of truth ({@link classifyStreamError}) shared
 * with the main-chat stream path. Two parallel classifiers used to exist —
 * `visible-retry.ts:isRetryableError` for council calls and
 * `retry-classifier.ts:classifyStreamError` for the orchestrator stream — and
 * they drifted apart at least once with real user-visible consequences:
 *
 *   bab91d29 — council's `isRetryableError` did NOT match
 *   "The socket connection was closed unexpectedly", so session e74e820c6417
 *   burned 6 one-shot attempts inside a 3s fault window and the debate died
 *   with `Not enough successful openings`. The same socket-drop pattern WAS
 *   retried on the main-chat path.
 *
 * Unifying here means every future transient-class (1210 one-shot degrade,
 * network regex additions, cause-recursion edge cases) lands in ONE place.
 *
 * Note: classifyStreamError's 1210 branch also flips the thinking-degrade latch
 * (`markProviderThinkingDegrade`) on first sighting — that side effect MUST
 * fire here too, otherwise the retry would rebuild the same rejected body and
 * 1210 again. Going through the function (not copying its regex) is load-bearing.
 */
export function isRetryableError(err: unknown): boolean {
  return classifyStreamError(err).transient;
}

/**
 * Optional UI sink for retry progress. The TUI registers one via
 * {@link setRetryReporter}; without it (headless/CLI, tests) retries fall back
 * to stderr. This exists because a raw `process.stderr.write` under OpenTUI's
 * raw-mode alt-screen paints over wherever the cursor sits — the retry line was
 * bleeding into the composer input frame (user-reported). Routing through a
 * toast keeps it in the proper surface.
 */
type RetryReporter = (message: string, level: "warn" | "info") => void;
let retryReporter: RetryReporter | null = null;

export function setRetryReporter(fn: RetryReporter | null): void {
  retryReporter = fn;
}

function defaultOnRetry(attempt: number, total: number, delayMs: number, error: Error): void {
  const reason =
    (error as { statusCode?: number }).statusCode === 429 ? "rate-limited (429)" : error.message.slice(0, 80);
  const message = `[retry] ${reason} — waiting ${Math.round(delayMs / 1000)}s before attempt ${attempt + 1}/${total}`;
  if (retryReporter) {
    retryReporter(message, "warn");
    return;
  }
  process.stderr.write(`${message}\n`);
}

export async function withVisibleRetry<T>(fn: () => Promise<T>, opts: VisibleRetryOpts = {}): Promise<T> {
  const delays = opts.delaysMs ?? [2000, 4000, 8000, 16000, 32000];
  const maxAttempts = opts.maxAttempts ?? delays.length + 1;
  const onRetry = opts.onRetry ?? defaultOnRetry;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1 || !isRetryableError(err)) break;
      const delayMs = delays[attempt] ?? delays[delays.length - 1]!;
      const e = err instanceof Error ? err : new Error(String(err));
      onRetry(attempt, maxAttempts, delayMs, e);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
