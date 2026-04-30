/**
 * src/providers/errors.ts
 *
 * Normalized error mapping for multi-provider streams.
 * Maps AI SDK errors to one of 5 kinds: rate_limit | auth | content_filter | server_error | unknown.
 * PROV-05 requirement.
 */

export type NormalizedErrorKind = 'rate_limit' | 'auth' | 'content_filter' | 'server_error' | 'unknown';

export interface NormalizedError extends Error {
  kind: NormalizedErrorKind;
  status?: number;
  provider_message?: string;
}

/**
 * Normalize any thrown error into a NormalizedError with a consistent `kind`.
 * Uses error name, HTTP status, and message pattern matching.
 */
export function normalizeError(err: unknown): NormalizedError {
  const e = err instanceof Error ? err : new Error(String(err));
  const name = e.name ?? '';
  const msg = e.message ?? '';
  const status = (err as any)?.status ?? (err as any)?.statusCode;

  let kind: NormalizedErrorKind = 'unknown';

  if (name === 'RateLimitError' || status === 429 || /rate.?limit/i.test(msg)) {
    kind = 'rate_limit';
  } else if (name === 'AuthenticationError' || status === 401 || status === 403 || /auth|unauthor|forbidden/i.test(msg)) {
    kind = 'auth';
  } else if (/content.?filter|safety|policy|blocked/i.test(msg)) {
    kind = 'content_filter';
  } else if (typeof status === 'number' && status >= 500) {
    kind = 'server_error';
  }

  const out = Object.assign(e, { kind, status, provider_message: msg });
  return out as NormalizedError;
}
