import { classifyStreamError, parseRetryAfterMs } from "./retry-classifier.js";

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  errorName: string;
  errorMessage: string;
  nextDelayMs: number;
}

export interface RetryStreamOpts {
  /** Maximum total attempts (first try + retries). Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms for first retry. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 8000. */
  maxDelayMs?: number;
  /** Jitter fraction in 0..1. Delay is adjusted by ±(jitter * delay). Default: 0.25. */
  jitter?: number;
  /** User cancellation signal — abort the retry loop immediately. */
  signal?: AbortSignal;
  /** Telemetry callback, called before each retry sleep. */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Clock injection seam for tests. Replaces setTimeout-based sleep.
   * Default: real wall-clock sleep.
   */
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_JITTER = 0.25;

function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: number): number {
  // Exponential: 500 → 2000 → 8000
  const exp = Math.min(baseDelayMs * Math.pow(4, attempt - 1), maxDelayMs);
  const spread = exp * jitter;
  const delta = (Math.random() * 2 - 1) * spread; // ±jitter*delay
  return Math.min(Math.max(0, Math.round(exp + delta)), maxDelayMs);
}

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps an async factory so that transient errors trigger exponential-backoff
 * retries. Designed for streamText: the factory is re-invoked on each attempt.
 *
 * Once chunks have started flowing (i.e. the factory promise resolved), we do
 * NOT retry — partial-output corruption would result. The wrapper only catches
 * errors that occur before the promise resolves (i.e. the AI SDK setup phase
 * or the very first network rejection).
 *
 * Because Vercel AI SDK's streamText returns synchronously (the object is
 * available immediately), the actual network error surfaces when you first
 * await result.fullStream or result.response. The caller is expected to wrap
 * "await the first chunk" inside the factory if needed, OR use this wrapper
 * purely to guard the streamText call itself (which can throw on bad config).
 * Either way, the retry only fires when factory() REJECTS — not mid-stream.
 */
export async function withStreamRetry<T>(factory: () => Promise<T>, opts: RetryStreamOpts = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = opts.jitter ?? DEFAULT_JITTER;
  const sleepFn = opts.delay ?? realDelay;
  const { signal, onRetry } = opts;

  // Bail immediately if already aborted
  if (signal?.aborted) {
    throw new DOMException("Aborted before first attempt", "AbortError");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check abort before each attempt (including first)
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    try {
      return await factory();
    } catch (err: unknown) {
      lastError = err;

      // User abort — never retry; surface as AbortError so callers can distinguish
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const { transient } = classifyStreamError(err);
      if (!transient) {
        throw err;
      }

      // Exhausted attempts — fall through to throw
      if (attempt >= maxAttempts) {
        break;
      }

      // Compute delay — check for Retry-After header from 429 responses
      let nextDelayMs = computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);

      // Some AI SDK errors carry retryAfter (ms, already parsed by provider layer)
      // or the raw header string
      const errWithRetry = err as {
        retryAfter?: number | string;
        responseHeaders?: Record<string, string>;
        headers?: Record<string, string>;
      };

      const retryAfterRaw =
        errWithRetry.retryAfter ??
        errWithRetry.responseHeaders?.["retry-after"] ??
        errWithRetry.headers?.["retry-after"];

      if (typeof retryAfterRaw === "number" && retryAfterRaw > 0) {
        nextDelayMs = Math.min(retryAfterRaw, maxDelayMs);
      } else if (typeof retryAfterRaw === "string") {
        const parsed = parseRetryAfterMs(retryAfterRaw);
        if (parsed != null) {
          nextDelayMs = Math.min(parsed, maxDelayMs);
        }
      }

      const errorName = err instanceof Error ? err.name : "Error";
      const errorMessage = err instanceof Error ? err.message : String(err);

      onRetry?.({
        attempt,
        maxAttempts,
        errorName,
        errorMessage,
        nextDelayMs,
      });

      // Sleep — honor abort signal during the wait
      await Promise.race([
        sleepFn(nextDelayMs),
        new Promise<never>((_, reject) => {
          if (!signal) return;
          const onAbort = () => reject(new DOMException("Aborted during retry delay", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);

      // Re-check after sleep
      if (signal?.aborted) {
        throw new DOMException("Aborted during retry delay", "AbortError");
      }
    }
  }

  throw lastError;
}
