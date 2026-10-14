/**
 * src/providers/rate-limit-backoff.ts
 *
 * Reactive half of provider rate limiting: what a call does AFTER the provider
 * has answered "429 / rate limited". The proactive half (staying inside the
 * declared budget so the 429 never happens) is `rate-limiter.ts` + the
 * machine-wide `rate-ledger.ts`; this module is the backstop for every case the
 * declared budget cannot see — another machine on the same account, a provider
 * that counts tokens differently from our estimate, a catalog entry with no
 * `rate_limits` at all.
 *
 * WHY THE GENERIC TRANSIENT RETRY WAS NOT ENOUGH (measured, 2026-10-14)
 * ----------------------------------------------------------------------
 * 17 background delegations on one account ALL died 2.4–8.5 s after start with
 * "Rate limit reached, please try again later." — including one-word probes with
 * no tools. A per-minute budget refills over a MINUTE, but every retry layer
 * capped its backoff at 8 s (`withStreamRetry` DEFAULT_MAX_DELAY_MS, the main
 * turn's inline loop) and the background child had no retry at all. Nothing on
 * our side could ever wait out the window it had hit.
 *
 * So a rate-limit error gets its own schedule: honour the provider's
 * `retry-after-ms` / `retry-after` when it sends one, otherwise grow
 * exponentially to {@link RATE_LIMIT_MAX_DELAY_MS}, bounded by a TOTAL wait
 * budget ({@link rateLimitRetryBudgetMs}) rather than an attempt count — the
 * quantity that matters against a per-minute window is time, not tries. Every
 * other transient error keeps its existing short backoff.
 *
 * PROVIDER-AGNOSTIC
 * -----------------
 * Classification reads only the error's SHAPE (HTTP status, error name, the
 * standard rate-limit phrasings in message/body) — never a provider id. Any
 * provider's 429 gets the same treatment (Zero Hardcode).
 *
 * A 429 that means "out of credit" is NOT a rate limit: waiting four minutes
 * cannot top up a balance. Those stay on the short path so the user hears about
 * the balance promptly (see {@link isQuotaExhaustion}).
 */

import { APICallError } from "@ai-sdk/provider";

/** First rate-limit backoff step when the provider sends no Retry-After. */
export const RATE_LIMIT_BASE_DELAY_MS = 4_000;

/** Longest single rate-limit wait — one full per-minute window. */
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** Default total time a single call may spend waiting out rate limits. */
export const DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS = 240_000;

/** Upper bound on a configured budget, so a typo cannot park a call for hours. */
const MAX_RATE_LIMIT_RETRY_BUDGET_MS = 30 * 60_000;

/** ± fraction of jitter on computed (not provider-hinted) backoff steps. */
const RATE_LIMIT_JITTER = 0.2;

/**
 * Total wait budget for one call's rate-limit retries, from
 * `MUONROI_RATE_LIMIT_RETRY_BUDGET_MS`. `0` disables the long wait entirely (a
 * rate-limit error then falls through to the generic short transient retry, the
 * pre-fix behaviour). Unparseable / negative → the default.
 */
export function rateLimitRetryBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MUONROI_RATE_LIMIT_RETRY_BUDGET_MS;
  if (raw === undefined || raw === "") return DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS;
  return Math.min(Math.floor(n), MAX_RATE_LIMIT_RETRY_BUDGET_MS);
}

/**
 * Computed backoff for the `attempt`-th rate-limit retry (1-based):
 * 4 s → 8 s → 16 s → 32 s → 60 s → 60 s …, ±20% jitter so several agents that
 * were refused together do not come back together.
 */
export function rateLimitBackoffMs(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const exp = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** (n - 1), RATE_LIMIT_MAX_DELAY_MS);
  const delta = (random() * 2 - 1) * exp * RATE_LIMIT_JITTER;
  return Math.min(Math.max(0, Math.round(exp + delta)), RATE_LIMIT_MAX_DELAY_MS);
}

/**
 * How many attempts the computed (jitter-free) schedule fits into `budgetMs` —
 * the `maxAttempts` a retry announcement reports. A provider Retry-After can
 * make the real count differ; this is the plan, not a promise.
 */
export function plannedRateLimitAttempts(budgetMs: number): number {
  let waited = 0;
  let retries = 0;
  while (retries < 100) {
    const step = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** retries, RATE_LIMIT_MAX_DELAY_MS);
    if (waited + step > budgetMs) break;
    waited += step;
    retries++;
  }
  return retries + 1;
}

/**
 * "Out of balance / quota" phrasings. Several providers answer an empty wallet
 * with HTTP 429 (measured: z.ai "Insufficient balance or no resource package.
 * Please recharge."; OpenAI "You exceeded your current quota"). That is not a
 * rate window — no amount of waiting refills it.
 */
export function isQuotaExhaustion(text: string): boolean {
  return /insufficient[_ ](balance|quota|credit|funds)|out of (balance|credit)|recharge|no resource package|exceeded your current quota|quota[_ ]exceeded|billing|payment required/i.test(
    text,
  );
}

const RATE_LIMIT_TEXT_RE =
  /rate[ _-]?limit|rate[ _-]?limited|too many requests|\b429\b|throttl|requests? per (minute|second)|(tokens|requests) per min|concurrency limit|RESOURCE_EXHAUSTED/i;

function statusOf(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) return err.statusCode;
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  if (typeof e?.statusCode === "number") return e.statusCode;
  if (typeof e?.status === "number") return e.status;
  return undefined;
}

/** All the human-readable text an error carries: message, raw body, parsed data. */
function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const e = err as { message?: unknown; responseBody?: unknown; data?: unknown };
  const parts: string[] = [];
  if (typeof e.message === "string") parts.push(e.message);
  if (typeof e.responseBody === "string") parts.push(e.responseBody);
  if (e.data !== undefined) {
    try {
      parts.push(JSON.stringify(e.data));
    } catch {
      // Unserializable provider payload — message/body above are enough to classify.
    }
  }
  return parts.join("\n");
}

/** Errors that wrap the real provider error: `cause`, and AI SDK `RetryError.lastError`. */
function innerErrors(err: unknown): unknown[] {
  const e = err as { cause?: unknown; lastError?: unknown } | null;
  if (!e || typeof e !== "object") return [];
  return [e.lastError, e.cause].filter((x) => x != null && x !== err);
}

/**
 * Whether `err` is a provider RATE LIMIT that waiting can cure. Generic across
 * providers: HTTP 429, an error named `RateLimitError`, or the standard phrasings
 * (`rate limit`, `rate_limited`, `Too Many Requests`, a JSON `rate_limit_error`
 * type, …) in the message or raw body. Quota/balance exhaustion is excluded.
 */
export function isRateLimitError(err: unknown, depth = 0): boolean {
  if (err == null || depth > 3) return false;
  const text = errorText(err);
  if (isQuotaExhaustion(text)) return false;
  const status = statusOf(err);
  if (status === 429) return true;
  const name = (err as { name?: unknown }).name;
  if (name === "RateLimitError") return true;
  // A definite non-429 HTTP status (401, 400, 500 …) whose body merely mentions
  // limits is not a rate limit — only status-less errors are judged by text.
  if (status === undefined && RATE_LIMIT_TEXT_RE.test(text)) return true;
  return innerErrors(err).some((inner) => isRateLimitError(inner, depth + 1));
}

/**
 * Text-only variant of {@link isRateLimitError}, for failures that reached us
 * already flattened to a string (a sub-agent's "Task failed: HTTP 429: …").
 */
export function isRateLimitFailureText(text: string): boolean {
  return !isQuotaExhaustion(text) && RATE_LIMIT_TEXT_RE.test(text);
}

function headerValue(headers: unknown, key: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const v = (headers as { get: (k: string) => string | null }).get(key);
    return v ?? undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === key && typeof v === "string") return v;
  }
  return undefined;
}

/**
 * Parse a `Retry-After` value: delta-seconds (fractional allowed) or an
 * HTTP-date. Null when unparseable.
 */
export function parseRetryAfterHeader(value: string | undefined | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) return Math.max(0, ts - now);
  return null;
}

/**
 * The provider's own "come back in N ms" hint, if it sent one. Reads the
 * standard headers off the AI SDK `APICallError.responseHeaders` (case-
 * insensitive): `retry-after-ms` (OpenAI-style, ms) first, then `retry-after`
 * (RFC 9110 seconds or HTTP-date). Also accepts an already-parsed `retryAfter`
 * field (number = ms, string = header value) that some wrappers attach.
 * Searches wrapped errors too.
 */
export function retryAfterMsFromError(err: unknown, now: number = Date.now(), depth = 0): number | null {
  if (err == null || typeof err !== "object" || depth > 3) return null;
  const e = err as { responseHeaders?: unknown; headers?: unknown; retryAfter?: unknown };
  for (const headers of [e.responseHeaders, e.headers]) {
    const ms = Number(headerValue(headers, "retry-after-ms"));
    if (headerValue(headers, "retry-after-ms") !== undefined && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
    const parsed = parseRetryAfterHeader(headerValue(headers, "retry-after"), now);
    if (parsed != null) return parsed;
  }
  if (typeof e.retryAfter === "number" && Number.isFinite(e.retryAfter) && e.retryAfter >= 0) return e.retryAfter;
  if (typeof e.retryAfter === "string") {
    const parsed = parseRetryAfterHeader(e.retryAfter, now);
    if (parsed != null) return parsed;
  }
  for (const inner of innerErrors(err)) {
    const hint = retryAfterMsFromError(inner, now, depth + 1);
    if (hint != null) return hint;
  }
  return null;
}

/**
 * Thrown when a call is STILL rate-limited after its whole wait budget. Carries
 * `statusCode: 429` (so existing status-based surfaces still say "HTTP 429") and
 * the marker {@link isRateLimitRetryExhausted} reads, so outer retry layers do
 * not stack another full budget on top of one already spent — the transient
 * classifier treats it as non-transient.
 *
 * The message is written for the AGENT that reads it (a background delegation's
 * error text lands verbatim in the main agent's context): what happened, that
 * the budget is shared, and what to do instead of retrying immediately.
 */
export class ProviderRateLimitError extends Error {
  readonly statusCode = 429;
  readonly rateLimitRetryExhausted = true;
  readonly provider: string | undefined;
  readonly attempts: number;
  readonly waitedMs: number;
  readonly retryAfterMs: number | null;
  constructor(opts: {
    provider?: string;
    attempts: number;
    waitedMs: number;
    retryAfterMs?: number | null;
    cause: unknown;
  }) {
    const providerText = opts.provider ? `the "${opts.provider}" provider account` : "the provider account";
    const original = opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
    const hint =
      opts.retryAfterMs != null && opts.retryAfterMs > 0
        ? ` The provider asked to wait ${Math.ceil(opts.retryAfterMs / 1000)}s more.`
        : "";
    super(
      `Rate-limited by ${providerText} (HTTP 429): still refused after ${opts.attempts} attempt(s) and ` +
        `${Math.round(opts.waitedMs / 1000)}s of backoff.${hint} The limit is the account's budget, shared by ` +
        `every muonroi agent on this machine (the main agent and all background delegations). Do not retry ` +
        `immediately: wait for running agents to finish, retry later, or launch fewer agents in parallel. ` +
        `Provider said: ${original}`,
    );
    this.name = "ProviderRateLimitError";
    this.provider = opts.provider;
    this.attempts = opts.attempts;
    this.waitedMs = opts.waitedMs;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** Whether `err` (or something it wraps) already spent a full rate-limit wait budget. */
export function isRateLimitRetryExhausted(err: unknown, depth = 0): boolean {
  if (err == null || typeof err !== "object" || depth > 3) return false;
  if ((err as { rateLimitRetryExhausted?: unknown }).rateLimitRetryExhausted === true) return true;
  return innerErrors(err).some((inner) => isRateLimitRetryExhausted(inner, depth + 1));
}

// ── "A provider backoff is in progress" hold ────────────────────────────────
//
// A rate-limit wait inside a call produces no stream chunk for up to a minute
// at a time, and several in a row. The stall watchdogs (stall-watchdog.ts,
// turn-watchdog.ts) would read that silence as a dead provider and abort a call
// that is doing exactly what it should. Like the interactive-pause counter, the
// hold tells them "this silence is a known, announced wait" so they re-arm
// instead of firing. Kept SEPARATE from the interactive pause on purpose: that
// counter also means "a human is being waited on" (sprint-runner accounts human
// pause time from it), which a provider backoff is not.
//
// Process-global and coarse by design: while one call backs off, a concurrent
// stream's stall check is deferred too. That deferral is bounded by the wait
// budget and the stalled stream is judged the moment the hold ends.

let backoffDepth = 0;

export function beginProviderBackoff(): void {
  backoffDepth += 1;
}

export function endProviderBackoff(): void {
  backoffDepth = Math.max(0, backoffDepth - 1);
}

/** True while at least one call is waiting out a provider rate limit. */
export function isProviderBackoffActive(): boolean {
  return backoffDepth > 0;
}

/** Test-only. */
export function __resetProviderBackoffForTests(): void {
  backoffDepth = 0;
}

function abortError(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason;
  if (reason instanceof Error || reason instanceof DOMException) return reason;
  return new DOMException("Aborted during rate-limit backoff", "AbortError");
}

/** Sleep that rejects as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One planned rate-limit retry, announced BEFORE the wait starts. */
export interface RateLimitRetryInfo {
  /** 1-based retry number. */
  attempt: number;
  /** Planned total attempts for the budget (see {@link plannedRateLimitAttempts}). */
  maxAttempts: number;
  /** How long this wait will be, in ms. */
  waitMs: number;
  /** True when the wait came from the provider's Retry-After. */
  hinted: boolean;
  error: unknown;
}

export interface ProviderRateLimitRetryOpts {
  /** Provider account (catalog id) the call went to — named in the exhausted error. */
  provider?: string;
  signal?: AbortSignal;
  /** Total wait budget; default {@link rateLimitRetryBudgetMs}. */
  budgetMs?: number;
  /** Called before each wait. Must not throw (guarded anyway). */
  onRetry?: (info: RateLimitRetryInfo) => void;
  /**
   * Turn this process's proposed wait into the wait to actually take, and share
   * it. The gate uses the machine-wide ledger here: it records a provider
   * cooldown every process honours and returns how long until it lifts (which
   * another process may already have pushed further out). Resolves to ms.
   */
  coordinate?: (proposal: { attempt: number; proposedMs: number; hintMs: number | null }) => Promise<number>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * Run `attempt`, waiting out provider rate limits between tries.
 *
 * Only a rate-limit rejection is retried here (anything else propagates at
 * once, untouched, to whatever retry layer sits above). Safe to re-run because
 * the caller hands in a function that issues a FRESH request and has produced
 * nothing yet — the gate wraps the request initiation (`doStream` /
 * `doGenerate`), which rejects before any chunk exists.
 *
 * When the next wait would overrun the budget, throws
 * {@link ProviderRateLimitError} (actionable, marked exhausted).
 */
export async function withProviderRateLimitRetry<T>(
  attempt: () => Promise<T>,
  opts: ProviderRateLimitRetryOpts = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const start = now();
  let retries = 0;
  let waitedMs = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (opts.signal?.aborted || !isRateLimitError(err) || isRateLimitRetryExhausted(err)) throw err;
      const budgetMs = opts.budgetMs ?? rateLimitRetryBudgetMs();
      // Budget 0 = feature off: hand the original error to the generic retry path.
      if (budgetMs <= 0) throw err;
      retries += 1;
      const hintMs = retryAfterMsFromError(err, now());
      const proposedMs = hintMs ?? rateLimitBackoffMs(retries);
      let waitMs = proposedMs;
      if (opts.coordinate) {
        try {
          waitMs = Math.max(0, await opts.coordinate({ attempt: retries, proposedMs, hintMs }));
        } catch (coordErr) {
          // Coordination is an optimisation; this process can still wait alone.
          console.error(`[rate-limit] could not share provider cooldown: ${(coordErr as Error)?.message}`);
        }
      }
      const remaining = budgetMs - (now() - start);
      if (waitMs > remaining) {
        throw new ProviderRateLimitError({
          provider: opts.provider,
          attempts: retries,
          waitedMs,
          retryAfterMs: hintMs,
          cause: err,
        });
      }
      try {
        opts.onRetry?.({
          attempt: retries,
          maxAttempts: Math.max(retries + 1, plannedRateLimitAttempts(budgetMs)),
          waitMs,
          hinted: hintMs != null,
          error: err,
        });
      } catch (notifyErr) {
        console.error(`[rate-limit] retry announcement failed: ${(notifyErr as Error)?.message}`);
      }
      beginProviderBackoff();
      try {
        await sleep(waitMs, opts.signal);
      } finally {
        endProviderBackoff();
      }
      waitedMs += waitMs;
    }
  }
}
