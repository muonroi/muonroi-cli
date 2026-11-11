/**
 * src/orchestrator/worker-stream-recovery.ts
 *
 * Host-side recovery for delegated worker (sub-agent) streams. Each helper
 * answers one failure class measured in the TCIS.MCP.Docs run (sessions
 * 8a5bd89c2be0 and 4edc02516a92, 2026-11-02..04; 20 of the session's worker
 * jobs ended in `error`):
 *
 * - {@link withTransientProviderRetry} — job `lively-amber-owl` died on
 *   "HTTP 503: The engine is currently overloaded" after one tool call. The
 *   metered gate retries only rate limits, and `StreamRunner.run()` refuses to
 *   re-run a whole worker once a tool ran (it would replay the tool), so a 503
 *   on step 2 was terminal. Here the retried unit is a single `doStream` whose
 *   promise REJECTED — the provider answered with an error status before any
 *   chunk existed — so a retry cannot duplicate output or tools.
 *
 * - {@link wrapToolsWithActivity} — five "no final answer" jobs
 *   (steady-violet-badger, eager-amber-otter, keen-silver-wolf,
 *   brisk-white-heron, gentle-indigo-falcon) ended with their last tool result
 *   reading "[Cancelled]" 120-134 s after the previous tool result: a bash
 *   command (`dotnet test …` with `timeout: 600000`, a repo-wide grep) was
 *   still running when the worker's 120 s provider-stall watchdog fired. No
 *   chunk flows while a tool executes, so tool time was counted as provider
 *   silence. The top-level loop already brackets tools with
 *   `beginToolActivity` (tool-engine.ts); worker tools did not.
 *
 * - {@link LENGTH_CONTINUATION_PROMPT} / {@link REASONING_OVERFLOW_PROMPT} —
 *   five "final answer reached the output limit" jobs: four ended a step with
 *   finishReason=length, zero text and no tool call (calm-copper-otter,
 *   clever-blue-falcon, lively-violet-panda, gentle-copper-fox — the whole
 *   16384-token budget went to reasoning), one with 53141 chars of answer cut
 *   off mid-JSON (keen-blue-lynx). Neither got a second turn.
 */

import { APICallError } from "@ai-sdk/provider";
import { type ToolSet, wrapLanguageModel } from "ai";
import { abortableSleep, isRateLimitError, retryAfterMsFromError } from "../providers/rate-limit-backoff.js";
import { logger } from "../utils/logger.js";
import { reportRetryNotice } from "../utils/visible-retry.js";
import { STALL_ABORT_REASON } from "./stall-watchdog.js";
import { beginToolActivity, endToolActivity, withToolActivity } from "./tool-activity.js";

/** Backoff before retry N (1-based) when the provider sends no Retry-After. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/** Longest provider-hinted wait honoured for a transient (non-rate-limit) error. */
export const TRANSIENT_RETRY_MAX_HINT_MS = 30_000;

const NETWORK_RE =
  /ECONNREFUSED|ETIMEDOUT|ECONNRESET|ECONNABORTED|EAI_AGAIN|EPIPE|fetch failed|socket hang up|socket connection was closed|premature close|connection closed|connection error/i;

function statusOf(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) return err.statusCode;
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  const s = e?.statusCode ?? e?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * True for a provider error that is worth re-issuing the SAME request for:
 * an HTTP 5xx / 408, or a transport drop before any response. Rate limits are
 * excluded on purpose — the metered gate (model-gate.ts) already owns their
 * time-budgeted, ledger-coordinated retry, and stacking a second schedule on
 * top would spend the account budget twice. Aborts (user, stall watchdog) are
 * never transient: a stalled provider just stalls again.
 */
export function isTransientWorkerProviderError(err: unknown, depth = 0): boolean {
  if (err == null || depth > 2) return false;
  const e = err as { name?: unknown; message?: unknown; cause?: unknown; code?: unknown };
  if (e.name === "AbortError" || e.message === STALL_ABORT_REASON) return false;
  if (isRateLimitError(err)) return false;
  const status = statusOf(err);
  if (status !== undefined) return status === 408 || (status >= 500 && status <= 599);
  const text = `${typeof e.message === "string" ? e.message : ""} ${typeof e.code === "string" ? e.code : ""}`;
  if (NETWORK_RE.test(text)) return true;
  return isTransientWorkerProviderError(e.cause, depth + 1);
}

export interface TransientRetryOptions {
  /** Label for logs/notices (model id); never used for routing. */
  label: string;
  /** Backoff schedule; its length is the retry count. */
  delaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before each wait. Must not throw (guarded anyway). */
  onRetry?: (info: { attempt: number; maxAttempts: number; waitMs: number; error: unknown }) => void;
}

/**
 * Run `attempt`, re-running it after a transient provider rejection
 * ({@link isTransientWorkerProviderError}) with a short bounded backoff that
 * honours the provider's Retry-After (capped). Any other error, an abort, or an
 * exhausted schedule propagates the ORIGINAL error unchanged.
 */
export async function retryTransientProviderCall<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal | undefined,
  opts: TransientRetryOptions,
): Promise<T> {
  const delays = opts.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? abortableSleep;
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (err) {
      if (signal?.aborted || retry >= delays.length || !isTransientWorkerProviderError(err)) throw err;
      const hint = retryAfterMsFromError(err);
      const waitMs = hint == null ? delays[retry]! : Math.min(Math.max(0, hint), TRANSIENT_RETRY_MAX_HINT_MS);
      const status = statusOf(err);
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("orchestrator", "Worker provider request failed transiently; retrying the same request", {
        model: opts.label,
        attempt: retry + 1,
        maxAttempts: delays.length + 1,
        waitMs,
        statusCode: status,
        message: message.slice(0, 300),
        responseBody:
          APICallError.isInstance(err) && typeof err.responseBody === "string"
            ? err.responseBody.slice(0, 500)
            : undefined,
      });
      try {
        opts.onRetry?.({ attempt: retry + 1, maxAttempts: delays.length + 1, waitMs, error: err });
      } catch (notifyErr) {
        logger.warn("orchestrator", "Worker transient-retry announcement failed", {
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        });
      }
      await sleep(waitMs, signal);
    }
  }
}

function announceTransientRetry(
  label: string,
  info: { attempt: number; maxAttempts: number; waitMs: number; error: unknown },
): void {
  const err = info.error;
  try {
    const runtime = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    runtime?.emitEvent({
      t: "event",
      kind: "stream-retry",
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      errorName: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
      nextDelayMs: info.waitMs,
    });
  } catch (emitErr) {
    logger.warn("orchestrator", "Worker stream-retry event emit failed", {
      model: label,
      error: emitErr instanceof Error ? emitErr.message : String(emitErr),
    });
  }
  const status = statusOf(err);
  reportRetryNotice(
    `[retry] worker request failed${status ? ` (HTTP ${status})` : ""} on ${label} — waiting ` +
      `${Math.ceil(info.waitMs / 1000)}s before attempt ${info.attempt + 1}/${info.maxAttempts}`,
  );
}

/**
 * Wrap a worker's (already gate-wrapped) model so a transient provider
 * rejection of `doStream` is retried in place. Each retry re-enters the inner
 * metered gate, so it is paced against the catalog's declared rate limits and
 * the shared provider cooldown exactly like a first call. Returns a NEW model
 * (never mutates the shared one).
 */
// biome-ignore lint/suspicious/noExplicitAny: AI SDK model handle is provider-shaped (any) across the codebase
export function withTransientProviderRetry(
  model: any,
  opts: Omit<TransientRetryOptions, "onRetry"> & { onRetry?: TransientRetryOptions["onRetry"] },
): any {
  if (!model || typeof model !== "object") return model;
  const onRetry = opts.onRetry ?? ((info) => announceTransientRetry(opts.label, info));
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: ({ doStream, params }) =>
        retryTransientProviderCall(() => Promise.resolve(doStream()), params.abortSignal, { ...opts, onRetry }),
    },
  });
}

/**
 * Bracket every tool's `execute` with {@link beginToolActivity} so the worker's
 * stall watchdog can tell "a tool is still running inside its own deadline"
 * from "the provider went silent". Ids are added to `owned` for the duration of
 * the call; pass the same set to `isToolActivityLive(now, owned)`. Returns new
 * tool objects — the input set is not mutated.
 */
export function wrapToolsWithActivity(tools: ToolSet, owned: Set<number>): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: (input: unknown, ctx: unknown) => unknown }).execute;
    if (typeof execute !== "function") {
      out[name] = tool;
      continue;
    }
    out[name] = {
      ...tool,
      execute: async (input: unknown, ctx: unknown) => {
        // An aborted turn must not START another tool. The AI SDK keeps its
        // internal step loop running after the consumer aborts and breaks out
        // (it only hands the signal to doStream/execute; it checks neither), so
        // a tool call of the NEXT step can still reach here after the
        // failing-tool-loop guard, a stall or a user cancel aborted the turn —
        // ci-matrix run 42131417821 (ubuntu+mac): the failure-loop worker's
        // tool ran a 9th time 50ms after run() had returned at N=8.
        const signal = (ctx as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        if (signal?.aborted) {
          const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
          logger.file("warn", "orchestrator", "Worker tool call refused: the turn was already aborted", {
            tool: name,
            reason,
          });
          throw new Error(`tool_refused_turn_aborted: ${name} was not run because the turn was aborted (${reason}).`);
        }
        const declared = (input as { timeout?: unknown } | undefined)?.timeout;
        const id = beginToolActivity(typeof declared === "number" ? declared : undefined);
        owned.add(id);
        try {
          return await withToolActivity(id, () => execute.call(tool, input, ctx));
        } finally {
          endToolActivity(id);
          owned.delete(id);
        }
      },
    } as ToolSet[string];
  }
  return out;
}

/** Max follow-up turns a worker gets to finish an answer the output limit cut off. */
export const MAX_LENGTH_CONTINUATIONS = 2;

/** Follow-up for a terminal answer truncated by the output limit (text was flowing). */
export const LENGTH_CONTINUATION_PROMPT =
  "Your previous reply was cut off by the output-token limit. Continue it exactly where it stopped: " +
  "do not repeat any earlier text, do not restart, and do not call tools. If the remainder is long, " +
  "finish with a compact summary instead of reproducing raw data.";

/**
 * Follow-up for a terminal step that hit the output limit with NO text and NO
 * tool call — the whole budget went to reasoning. Sent with reasoning minimized.
 */
export const REASONING_OVERFLOW_PROMPT =
  "Your previous turn spent its whole output budget on internal reasoning and produced no reply. " +
  "Do NOT call tools and keep reasoning brief. Write your final report for the parent agent now: lead with " +
  "the answer to the delegated task, cite the concrete file:line or command output behind each claim, list " +
  "files you changed, and state what remains unfinished or unverified.";
