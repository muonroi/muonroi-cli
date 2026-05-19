import { APICallError } from "@ai-sdk/provider";

export interface TransientCheck {
  transient: boolean;
  reason: string;
}

/**
 * Classifies a stream error as transient (safe to retry) or non-transient.
 *
 * Transient:
 *  - Network-level errors: ECONNREFUSED, ETIMEDOUT, ECONNRESET, EAI_AGAIN,
 *    "fetch failed", "Unable to connect", "socket hang up", "network"
 *  - HTTP 408 (request timeout), 425 (too early), 429 (rate limit), 5xx
 *  - TypeError with "fetch failed" message (browser/bun/node fetch layer)
 *  - AbortSignal.timeout firing (err.name === "TimeoutError")
 *
 * Non-transient:
 *  - AbortError (user cancellation) — caller must handle abort separately
 *  - HTTP 400, 401, 403, 422, and any other 4xx not listed above
 *  - Malformed tool/function name errors
 */
export function classifyStreamError(err: unknown, depth = 0): TransientCheck {
  if (depth > 2) {
    return { transient: false, reason: "max-depth reached" };
  }

  if (!(err instanceof Error) && typeof err !== "object") {
    return { transient: false, reason: "non-error value" };
  }

  const e = err as {
    name?: string;
    message?: string;
    statusCode?: number;
    status?: number;
    cause?: unknown;
    retryAfter?: number | string;
  };

  // AbortError: user cancellation — never retry, caller must handle
  if (e.name === "AbortError") {
    return { transient: false, reason: "user-abort" };
  }

  // TimeoutError: AbortSignal.timeout() fired — transient
  if (e.name === "TimeoutError") {
    return { transient: true, reason: "timeout-error" };
  }

  // AI SDK APICallError with statusCode
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status != null) {
      if (isTransientStatusCode(status)) {
        return { transient: true, reason: `http-${status}` };
      }
      // Any other status code (400, 401, 403, 422, etc.) is not transient
      return { transient: false, reason: `http-${status}-non-transient` };
    }
  }

  // Check plain statusCode / status field (some providers attach it directly)
  const statusCode = e.statusCode ?? (e as { status?: number }).status;
  if (typeof statusCode === "number") {
    if (isTransientStatusCode(statusCode)) {
      return { transient: true, reason: `http-${statusCode}` };
    }
    // Explicit non-transient status
    if (statusCode >= 400) {
      return { transient: false, reason: `http-${statusCode}-non-transient` };
    }
  }

  const message = typeof e.message === "string" ? e.message : "";

  // Malformed function/tool name errors — non-transient (own handler elsewhere)
  if (/invalid.*function.*name|function.*name.*invalid|malformed.*tool|NoSuchTool/i.test(message)) {
    return { transient: false, reason: "malformed-tool-name" };
  }

  // Network-level error patterns — transient
  if (isTransientMessage(message)) {
    return { transient: true, reason: "network-error" };
  }

  // TypeError with "fetch failed" or network message
  if (e.name === "TypeError" && isTransientMessage(message)) {
    return { transient: true, reason: "fetch-failed" };
  }

  // Recurse into cause (one level only)
  if (e.cause != null) {
    const causeResult = classifyStreamError(e.cause, depth + 1);
    if (causeResult.transient) {
      return { transient: true, reason: `cause:${causeResult.reason}` };
    }
  }

  return { transient: false, reason: "unknown" };
}

function isTransientStatusCode(code: number): boolean {
  return code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599);
}

function isTransientMessage(message: string): boolean {
  return /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|Unable to connect|network|socket hang up/i.test(
    message,
  );
}

/**
 * Parse Retry-After header value to milliseconds.
 * Accepts an integer (seconds) or an HTTP-date string.
 * Returns null if the value cannot be parsed.
 */
export function parseRetryAfterMs(value: string | undefined | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  // Try HTTP-date ("Mon, 19 May 2026 12:00:00 GMT")
  const ts = Date.parse(value);
  if (!Number.isNaN(ts)) {
    const diff = ts - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}
