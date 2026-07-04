import { APICallError } from "@ai-sdk/provider";
import { isProviderThinkingDegraded, markProviderThinkingDegrade } from "../providers/strategies/thinking-mode.js";
import { STALL_ABORT_REASON } from "./stall-watchdog.js";

/**
 * Detect the generic, spec-undocumented param rejection from the z.ai GLM
 * coding endpoint (HTTP 400 code 1210 "Invalid API parameter") and the
 * opencode-go Console Go proxy (HTTP 400 invalid_request "Upstream request
 * failed"). z.ai does NOT publish the exact constraint (verified 2026-07-02 vs
 * docs.z.ai/api-reference/api-code — 1210 is an intentionally generic bucket),
 * so no client transform can guarantee prevention. These are matched narrowly
 * (400 + specific phrasing) so ordinary 400s stay non-transient.
 */
function isProviderParamReject(err: unknown): boolean {
  const status = APICallError.isInstance(err)
    ? err.statusCode
    : ((err as { statusCode?: number; status?: number } | null)?.statusCode ??
      (err as { status?: number } | null)?.status);
  if (status !== 400) return false;
  const message = err instanceof Error ? err.message : String(err);
  const body = APICallError.isInstance(err) && typeof err.responseBody === "string" ? err.responseBody : "";
  const hay = `${message}\n${body}`;
  return /invalid api parameter|upstream request failed|unexpected end of JSON input|code"?\s*:?\s*1210/i.test(hay);
}

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

  // Provider-stall watchdog abort (DOMException(STALL_ABORT_REASON,
  // "TimeoutError")): the stream produced no chunk within the stall timeout.
  // Must NOT be retried — a stalled provider just stalls again, burning another
  // full timeout of silence. Check BEFORE the generic TimeoutError branch.
  if (e.name === "TimeoutError" && e.message === STALL_ABORT_REASON) {
    return { transient: false, reason: "provider-stall" };
  }

  // TimeoutError: AbortSignal.timeout() fired — transient
  if (e.name === "TimeoutError") {
    return { transient: true, reason: "timeout-error" };
  }

  // z.ai / opencode-go generic param reject (1210 / "Upstream request failed"):
  // give EXACTLY ONE retry with a degraded-but-valid body. The first sighting
  // latches thinking OFF (markProviderThinkingDegrade) so the rebuilt request
  // (factory re-invoked by withStreamRetry) sends the validator-safe shape;
  // parallel tool_calls are already split by the transform. If it STILL rejects
  // after we've degraded, stop retrying — the cause is beyond our client fix.
  if (isProviderParamReject(err)) {
    if (isProviderThinkingDegraded()) {
      return { transient: false, reason: "provider-param-reject-after-degrade" };
    }
    markProviderThinkingDegrade();
    return { transient: true, reason: "provider-param-reject-degrade-retry" };
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

  // Rate limits (including wrapped messages from proxies like "Console Go")
  if (/rate limit|rate-limited|429|too many requests/i.test(message)) {
    return { transient: true, reason: "rate-limit-message" };
  }

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
