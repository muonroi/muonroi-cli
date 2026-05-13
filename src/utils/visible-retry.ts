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

function isRetryableError(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; name?: string; message?: string };
  const code = e?.statusCode ?? e?.status;
  if (code === 429 || code === 408 || (code !== undefined && code >= 500 && code < 600)) return true;
  const msg = (e?.message ?? "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("timeout");
}

function defaultOnRetry(attempt: number, total: number, delayMs: number, error: Error): void {
  const reason =
    (error as { statusCode?: number }).statusCode === 429 ? "rate-limited (429)" : error.message.slice(0, 80);
  process.stderr.write(
    `[retry] ${reason} — waiting ${Math.round(delayMs / 1000)}s before attempt ${attempt + 1}/${total}\n`,
  );
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
