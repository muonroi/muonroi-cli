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

/**
 * Transient transport failures that carry NO http status — the fetch/undici
 * layer tore the connection down before a response existed. Session
 * e74e820c6417 lost every council opening statement to this class: both
 * participants threw `The socket connection was closed unexpectedly` (also in
 * crash.log as an unhandled rejection), the classifier below saw no status code
 * and no "timeout"/"rate limit" substring, declared it non-retryable, and the
 * debate died with `Not enough successful openings` after 6 silent one-shot
 * attempts. A socket teardown is the single most retryable failure there is.
 */
const RETRYABLE_NETWORK_PATTERNS = [
  "socket connection was closed",
  "socket hang up",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "enotfound",
  "eai_again",
  "epipe",
  "etimedout",
  "network error",
  "fetch failed",
  "premature close",
  "terminated",
  "stream closed",
  "connection closed",
  "connection error",
];

export function isRetryableError(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; name?: string; message?: string; code?: string };
  // A user cancellation is never retryable — retrying it would resurrect a turn
  // the human explicitly killed. (Deadline aborts surface as "timeout" below.)
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return e?.name === "TimeoutError";
  const code = e?.statusCode ?? e?.status;
  if (code === 429 || code === 408 || (code !== undefined && code >= 500 && code < 600)) return true;
  // An explicit 4xx (auth, bad param, content filter) is deterministic — a
  // retry burns latency and money to fail identically.
  if (code !== undefined && code >= 400 && code < 500) return false;
  const msg = (e?.message ?? "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("timeout")) return true;
  const sysCode = typeof e?.code === "string" ? e.code.toLowerCase() : "";
  return RETRYABLE_NETWORK_PATTERNS.some((p) => msg.includes(p) || sysCode === p);
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
