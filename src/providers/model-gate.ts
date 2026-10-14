/**
 * src/providers/model-gate.ts
 *
 * Bước 2 — The Metered Gate (skeleton, meter-only phase).
 *
 * Every LLM call resolves its model through `resolveModelRuntime`, and every
 * `streamText`/`generateText` ultimately invokes `model.doStream`/`doGenerate`
 * with `options.prompt` = the FULLY-assembled input for THAT call (post
 * prepareStep, post compaction/steer — verified against ai@6.0.169). Wrapping
 * the resolved model with `wrapLanguageModel` gives ONE point through which every
 * AI-SDK call's final input passes.
 *
 * This module is the METER half only (design §3.1): it walks `options.prompt`,
 * estimates per-segment input tokens, and writes one `call_accounting`
 * interaction-log row per call. It does NOT enforce a ceiling and does NOT stub
 * content — that is the ENFORCE phase, gated behind `MUONROI_GATE_CEILING`, and
 * lands only after per-(model,stage) calibration exists (design §5, D9).
 *
 * Red-team (Fable-5) constraints honored here:
 *   - H6: wrap by returning a NEW object (`wrapLanguageModel`), never mutate
 *     `doStream` in place — the shared mock model would otherwise stack wrappers.
 *   - H9: `chars/4` is unsafe both ways (CJK/Vietnamese undercount, long-word
 *     English overcount) and meaningless over base64 file parts — so it is
 *     meter-only here and file parts are counted as bytes, NOT chars/4.
 *   - H3: NO content-dedup at this layer. Dedup enforcement stays at C3
 *     tool-execute time where content is raw and the cache prefix is stable.
 *   - H8: `stage` has no ambient carrier, so missing stage is logged as
 *     `"unattributed"` (fail-loud), never silently defaulted to `"main"`.
 *
 * Disable entirely with `MUONROI_GATE=0`.
 */

import { wrapLanguageModel } from "ai";
import { logInteraction } from "../storage/interaction-log.js";
import type { ModelInfo, ModelRateLimits } from "../types/index.js";
import { isIdealRunUnlimited } from "../utils/ideal-run-scope.js";
import { reportRetryNotice } from "../utils/visible-retry.js";
import {
  acquireLedgerSlot,
  noteProviderRateLimited,
  TPM_ESTIMATE_CALIBRATION,
  usageTotalTokens,
} from "./rate-ledger.js";
import { type RateLimitRetryInfo, withProviderRateLimitRetry } from "./rate-limit-backoff.js";
import { acquireRateLimitSlot, type RateLimitLease, type RateLimitWait } from "./rate-limiter.js";

/**
 * The combined pacing lease: the in-process pacer's slot plus the machine-wide
 * ledger's (rate-ledger.ts). `settle` corrects the ledger's TPM reservation with
 * the provider-reported usage once the call ends.
 */
interface PaceLease extends RateLimitLease {
  settle: (usage: unknown) => void;
}

const UNPACED: PaceLease = { waits: [], holdsSlot: false, release: () => {}, settle: () => {} };

/**
 * The pipeline stage a call belongs to. `unattributed` means the resolve site
 * has not yet been migrated to pass a stage — the meter records it honestly
 * rather than guessing `main`.
 */
export type GateStage = "main" | "subagent" | "council" | "compaction" | "pil" | "title" | "vision" | "unattributed";

export interface GateContext {
  stage: GateStage;
  modelId: string;
  sessionId?: string;
  /** Per-call context ceiling in tokens (catalog contextWindow). Recorded, not enforced. */
  ceiling?: number;
  /**
   * The provider this model talks to. Used as the request-pacing key: a
   * `requests_per_minute` budget is an ACCOUNT-level counter (the provider's own
   * 429 names no model), so all models of one provider must share one window.
   * Absent → no pacing, exactly as before.
   */
  providerId?: string;
  /**
   * Declared provider limits for this model, from `catalog.json` via
   * `ModelInfo.rateLimits`. Enforced — unlike `ceiling`, which is recorded only.
   */
  rateLimits?: ModelRateLimits;
  /**
   * Arm the REACTIVE half of rate limiting for this model: when the provider
   * answers 429, wait it out (Retry-After honoured, else backoff up to a time
   * budget — see rate-limit-backoff.ts) and share the pushback with every other
   * muonroi process as a ledger cooldown. Independent of `rateLimits`: a model
   * whose catalog declares no limits can still be refused, and still needs both.
   * Needs `providerId` (the cooldown is per account). `resolveModelRuntime` sets
   * it for every real model and leaves it off for the mock model, which has no
   * account to protect and must not make tests sleep on the real clock.
   */
  providerBackpressure?: boolean;
}

export interface CallComposition {
  estInputTokens: number;
  bySegment: { system: number; history: number; toolResults: number };
  /** File/image parts are billed by the provider per-image, not chars/4 (H9). */
  fileParts: number;
  fileBytes: number;
  chars: number;
}

function gateDisabled(): boolean {
  return process.env.MUONROI_GATE === "0";
}

/** chars/4 — deliberately rough. Meter-only; NEVER the basis for a throw (H9). */
function estTokens(chars: number): number {
  return Math.round(chars / 4);
}

/**
 * Walk the AI SDK prompt (ordered role-tagged messages) and attribute character
 * counts to segments. `prompt` is `LanguageModelV2Prompt`: an array of
 * `{ role, content }` where content is a string (system) or an array of parts.
 */
export function analyzePrompt(prompt: unknown): CallComposition {
  const comp: CallComposition = {
    estInputTokens: 0,
    bySegment: { system: 0, history: 0, toolResults: 0 },
    fileParts: 0,
    fileBytes: 0,
    chars: 0,
  };
  if (!Array.isArray(prompt)) return comp;

  for (const msg of prompt as Array<{ role?: string; content?: unknown }>) {
    const role = msg?.role;
    const content = msg?.content;

    if (typeof content === "string") {
      const n = content.length;
      comp.chars += n;
      if (role === "system") comp.bySegment.system += n;
      else comp.bySegment.history += n;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const part of content as Array<Record<string, unknown>>) {
      const type = part?.type;
      if (type === "text" || type === "reasoning") {
        const n = typeof part.text === "string" ? (part.text as string).length : 0;
        comp.chars += n;
        if (role === "system") comp.bySegment.system += n;
        else comp.bySegment.history += n;
      } else if (type === "tool-result") {
        // Attribute the serialized tool output to the tool-results segment —
        // this is the blob C3 targets and the biggest re-serve source.
        const n = JSON.stringify(part.output ?? part.result ?? "").length;
        comp.chars += n;
        comp.bySegment.toolResults += n;
      } else if (type === "tool-call") {
        const n = JSON.stringify(part.input ?? part.args ?? "").length;
        comp.chars += n;
        comp.bySegment.history += n;
      } else if (type === "file" || type === "image") {
        // H9: base64/Uint8Array — chars/4 is meaningless. Count bytes; providers
        // bill images by dimensions, so this feeds a separate estimate later.
        comp.fileParts += 1;
        const data = part.data ?? part.image;
        if (typeof data === "string") comp.fileBytes += data.length;
        else if (data instanceof Uint8Array) comp.fileBytes += data.byteLength;
      }
    }
  }
  comp.estInputTokens = estTokens(comp.chars);
  return comp;
}

/**
 * Thrown when a call's estimated input exceeds its ceiling AND the ceiling mode
 * is `throw`. Typed so the orchestrator's overflow-recovery path can recognize
 * it (H4) — it is NOT a provider APICallError, so a message regex would miss it.
 */
export class InputCeilingExceededError extends Error {
  readonly stage: GateStage;
  readonly est: number;
  readonly ceiling: number;
  readonly topSegments: CallComposition["bySegment"];
  constructor(stage: GateStage, est: number, ceiling: number, topSegments: CallComposition["bySegment"]) {
    super(
      `Input ceiling exceeded on '${stage}' call: est ${est} tokens > ceiling ${ceiling}. ` +
        `Segments — system:${topSegments.system} history:${topSegments.history} tool_results:${topSegments.toolResults} chars.`,
    );
    this.name = "InputCeilingExceededError";
    this.stage = stage;
    this.est = est;
    this.ceiling = ceiling;
    this.topSegments = topSegments;
  }
}

export type CeilingMode = "off" | "warn" | "throw";

/**
 * Ceiling enforcement mode from `MUONROI_GATE_CEILING`.
 *
 * Default is **`warn`** (log-only, never throws) so multi-dimensional ceiling
 * stats are collected on every run without anyone remembering to opt in — a warn
 * is a pure diagnostic and changes nothing about the call. `throw` (raises
 * `InputCeilingExceededError` for throw-eligible stages) stays explicit opt-in,
 * armed only after per-(model,stage) calibration (D9). `off` fully silences the
 * ceiling path (still records the row, just no warn/throw).
 */
export function ceilingMode(stage?: GateStage): CeilingMode {
  const raw = process.env.MUONROI_GATE_CEILING;
  let mode: CeilingMode;
  if (raw !== undefined && raw !== "") {
    // Explicit global override wins for every stage.
    const v = raw.toLowerCase();
    mode = v === "warn" || v === "throw" || v === "off" ? v : "warn";
  } else {
    // No explicit setting: per-stage DEFAULT. The sub-agent tool loop (and its
    // vision variant) is the documented runaway source and is already bounded by
    // the cumulative cap (~60k est), so a `throw` backstop there is safe (only an
    // escapee past the cap trips it) and worth having on by default. Every other
    // stage defaults to `warn` (log-only stats) — a user's own long turn or a
    // council/compaction call is never hard-killed without an explicit opt-in.
    mode = stage && THROW_ELIGIBLE.has(stage) ? "throw" : "warn";
  }
  // `/ideal` has no limits (user decision). The throw line is an ABSOLUTE token
  // budget (`throwCeilingTokens`, not derived from the model's context window),
  // so inside an `/ideal` run it is not enforced: `throw` becomes `warn`. The
  // call is still metered and a crossing is still logged. The provider's real
  // window stays guarded by compaction and by overflow recovery, which read it.
  if (mode === "throw" && isIdealRunUnlimited()) return "warn";
  return mode;
}

/**
 * Stages where a `throw` ceiling is armed. D1: enforce only where a runaway is
 * most costly — the sub-agent tool loop (and its vision variant), whose growing
 * history is the documented leak. `main` stays advisory (warn) even in throw
 * mode so a user's own long turn is never hard-killed mid-flight; compaction/pil
 * are never enforced (compaction IS the recovery mechanism — H4).
 */
const THROW_ELIGIBLE: ReadonlySet<GateStage> = new Set<GateStage>(["subagent", "vision"]);

/** Default absolute est-token throw cap (calibrated). See throwCeilingTokens. */
const DEFAULT_THROW_MAX_TOKENS = 100_000;

/**
 * How long a single stream may hold a rate-limit concurrency slot before the
 * slot is force-released with a logged error.
 *
 * This is a deadlock backstop, not a timeout: it never cancels the stream, it
 * only stops one un-drained stream from stranding a slot forever and wedging
 * every later call to that provider. Deliberately far longer than any real
 * completion — a long reasoning turn plus tool round-trips is minutes, not
 * fifteen of them — so a legitimate stream can never trip it.
 */
const STREAM_SLOT_WATCHDOG_MS = 15 * 60_000;

/**
 * The absolute est-token ceiling above which a throw-eligible stage THROWS.
 *
 * Calibrated (2026-07-19, live measurement): `chars/4` under-estimates real
 * provider tokens by ~2× for muonroi's token-dense system prompts (a 1:1
 * chitchat call measured est 20,563 vs real 45,171 = 2.2×). So this est cap of
 * 100k ≈ ~200k REAL tokens — decisively a runaway. It sits ABOVE the sub-agent
 * cumulative cap budget (240k chars ≈ 60k est), so normal capped work can never
 * trip it; only a call that ESCAPED the cap (a new bypass / regression) does.
 * This is deliberately absolute, NOT window×ratio: a single ratio collides with
 * the 60k cap budget on small-window models. Tune via `MUONROI_GATE_THROW_MAX_TOKENS`.
 */
export function throwCeilingTokens(): number {
  const raw = Number(process.env.MUONROI_GATE_THROW_MAX_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THROW_MAX_TOKENS;
}

/**
 * Write one `call_accounting` row for a metered call. Fail-open: logging must
 * never break a turn (a call with no sessionId is skipped — nowhere to attribute).
 */
export function meterCall(prompt: unknown, ctx: GateContext, op: "stream" | "generate"): void {
  try {
    if (!ctx.sessionId) return;
    logInteraction(ctx.sessionId, "call_accounting", buildAccountingRow(analyzePrompt(prompt), ctx, op));
  } catch {
    // Fail-open — the meter must never break the call it measures.
  }
}

/** Shape the `call_accounting` row from a walked composition (shared by meterCall + gateCall). */
function buildAccountingRow(
  comp: CallComposition,
  ctx: GateContext,
  op: "stream" | "generate",
): Parameters<typeof logInteraction>[2] {
  const ceilingHit = typeof ctx.ceiling === "number" ? comp.estInputTokens > ctx.ceiling : false;
  // Inside an `/ideal` run no throw line is armed (see ceilingMode), so the row
  // must not claim one; a normal chat row is unchanged.
  const eligible = THROW_ELIGIBLE.has(ctx.stage) && !isIdealRunUnlimited();
  const throwCeiling = eligible ? throwCeilingTokens() : null;
  return {
    eventSubtype: ctx.stage,
    model: ctx.modelId,
    inputTokens: comp.estInputTokens,
    data: {
      op,
      stage: ctx.stage,
      estInputTokens: comp.estInputTokens,
      chars: comp.chars,
      bySegment: comp.bySegment,
      fileParts: comp.fileParts,
      fileBytes: comp.fileBytes,
      ceiling: ctx.ceiling ?? null,
      ceilingHit,
      ceilingMode: ceilingMode(ctx.stage),
      throwCeiling,
      throwHit: throwCeiling !== null && comp.estInputTokens > throwCeiling,
    },
  };
}

/**
 * Enforce the ceiling. Two distinct lines:
 *  - THROW line (absolute `throwCeilingTokens()`, eligible stages only): a hard
 *    backstop for a runaway that escaped the cumulative cap. Raises
 *    `InputCeilingExceededError`, which the orchestrator recovers via
 *    compact-and-retry-once (H4).
 *  - WARN line (`ctx.ceiling` = catalog window × ratio): visibility only, logs a
 *    warning, never kills the call.
 * `off` mode silences both. `comp` is passed in so the prompt is walked once.
 */
export function enforceCeiling(comp: CallComposition, ctx: GateContext): void {
  const mode = ceilingMode(ctx.stage);
  if (mode === "off") return;
  const est = comp.estInputTokens;

  // Hard throw line first — absolute, eligible stages, only when armed.
  if (mode === "throw" && THROW_ELIGIBLE.has(ctx.stage)) {
    const throwAt = throwCeilingTokens();
    if (est > throwAt) {
      throw new InputCeilingExceededError(ctx.stage, est, throwAt, comp.bySegment);
    }
  }

  // Soft warn line — window×ratio, visibility only.
  if (typeof ctx.ceiling === "number" && est > ctx.ceiling) {
    console.warn(
      `[model-gate] ceiling warn: stage=${ctx.stage} est=${est} > ceiling=${ctx.ceiling} model=${ctx.modelId}`,
    );
  }
}

/**
 * Meter + enforce a single call. Walks the prompt ONCE, records the accounting
 * row, then applies the ceiling policy (which may throw before delegating).
 */
function gateCall(prompt: unknown, ctx: GateContext, op: "stream" | "generate"): CallComposition | undefined {
  let comp: CallComposition | undefined;
  try {
    comp = analyzePrompt(prompt);
    if (ctx.sessionId) {
      logInteraction(ctx.sessionId, "call_accounting", buildAccountingRow(comp, ctx, op));
    }
  } catch {
    // Metering is fail-open — but enforcement must still run below if we got a
    // composition (a DB write failure must not disarm the ceiling).
  }
  // Enforce OUTSIDE the fail-open catch so a genuine ceiling throw propagates.
  if (comp) enforceCeiling(comp, ctx);
  return comp;
}

/**
 * Real-token estimate of a call's input, for the ledger's TPM reservation.
 * Reuses the gate's composition when the meter already walked the prompt.
 */
function estimateCallTokens(prompt: unknown, comp: CallComposition | undefined, ctx: GateContext): number {
  if (!ctx.rateLimits?.tokensPerMinute) return 0;
  try {
    return (comp ?? analyzePrompt(prompt)).estInputTokens * TPM_ESTIMATE_CALIBRATION;
  } catch {
    // An unwalkable prompt reserves nothing; settle() records the real usage.
    return 0;
  }
}

/**
 * Wrap a resolved model so every doStream/doGenerate call is metered and, when
 * armed, ceiling-enforced.
 *
 * Returns a NEW model instance (H6) — the input model is never mutated. When the
 * gate is disabled or the model is falsy, returns the model untouched so callers
 * need no branching.
 */
// biome-ignore lint/suspicious/noExplicitAny: AI SDK model handle is provider-shaped (any) across the codebase
export function wrapModelWithGate(model: any, ctx: GateContext): any {
  // Pacing and metering are INDEPENDENT switches. `MUONROI_GATE=0` turns off the
  // meter; it must not silently also turn off rate limiting, or a user disabling
  // cost telemetry would quietly re-arm the 429 that killed a run.
  const paces = pacingApplies(ctx);
  if (!model || (gateDisabled() && !paces && !backpressureApplies(ctx))) return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ doStream, params }) => {
        const prompt = (params as { prompt?: unknown }).prompt;
        const comp = gateDisabled() ? undefined : gateCall(prompt, ctx, "stream");
        const estTokens = estimateCallTokens(prompt, comp, ctx);
        // Each attempt re-paces: a retry after a 429 waits behind the shared
        // cooldown and the declared budget exactly like a first call does.
        return retryOnRateLimit(ctx, params.abortSignal, async () => {
          const lease = await paceCall(ctx, estTokens);
          let result: Awaited<ReturnType<typeof doStream>>;
          try {
            result = await doStream();
          } catch (err) {
            lease.release();
            throw err;
          }
          // A stream is in flight until it ENDS, not until its promise resolves —
          // so a held concurrency slot spans the whole stream. When no slot is held
          // there is nothing to release, and the stream is returned untouched: a
          // model that declares no `concurrency` must not pay a pipeThrough.
          if (!lease.holdsSlot) return result;
          return { ...result, stream: releaseOnStreamEnd(result.stream, lease, ctx) };
        });
      },
      wrapGenerate: async ({ doGenerate, params }) => {
        const prompt = (params as { prompt?: unknown }).prompt;
        const comp = gateDisabled() ? undefined : gateCall(prompt, ctx, "generate");
        const estTokens = estimateCallTokens(prompt, comp, ctx);
        return retryOnRateLimit(ctx, params.abortSignal, async () => {
          const lease = await paceCall(ctx, estTokens);
          try {
            const result = await doGenerate();
            lease.settle((result as { usage?: unknown }).usage);
            return result;
          } finally {
            lease.release();
          }
        });
      },
    },
  });
}

/** Whether the provider-429 backstop (retry + shared cooldown) is armed for this context. */
function backpressureApplies(ctx: GateContext): boolean {
  return ctx.providerBackpressure === true && Boolean(ctx.providerId);
}

/**
 * Wait out a provider rate limit around ONE request initiation.
 *
 * This is the one point every real model call passes through, which is why the
 * reactive retry lives here rather than in each caller: `streamText` runs with
 * `maxRetries: 0` everywhere, and the callers' own retry layers can only re-run
 * a WHOLE turn — which they refuse to do once a sub-agent has made a tool call
 * (re-running would replay tools), so a 429 on step 3 of an explore agent was
 * terminal ("Task failed: HTTP 429"), and the background child had no retry
 * layer at all. Here the unit retried is a single `doStream`/`doGenerate`
 * whose promise REJECTED: the provider refused before sending a byte, so a
 * retry cannot duplicate output, on any step.
 *
 * When the budget runs out the error is a `ProviderRateLimitError`, which every
 * outer retry layer classifies non-transient — one budget per call, not one per
 * layer.
 */
function retryOnRateLimit<T>(ctx: GateContext, signal: AbortSignal | undefined, attempt: () => Promise<T>): Promise<T> {
  if (!backpressureApplies(ctx)) return attempt();
  const provider = ctx.providerId!;
  return withProviderRateLimitRetry(attempt, {
    provider,
    signal,
    // Publish the pushback machine-wide and wait for the SHARED deadline, which
    // another process may already have pushed further out.
    coordinate: ({ proposedMs, hintMs }) => noteProviderRateLimited(provider, { proposedMs, hintMs }),
    onRetry: (info) => announceRateLimitRetry(info, ctx),
  });
}

/**
 * Announce a provider rate-limit wait BEFORE it starts, on both channels a
 * watcher has: the harness `stream-retry` event (an error happened and the same
 * call is being re-attempted — exactly that kind's meaning) and the `[retry] …`
 * notice (TUI toast, a background delegation's job record, or stderr). A 60 s
 * backoff that announced nothing would be indistinguishable from a hang.
 */
function announceRateLimitRetry(info: RateLimitRetryInfo, ctx: GateContext): void {
  const err = info.error;
  const errorName = err instanceof Error ? err.name : "Error";
  const errorMessage = err instanceof Error ? err.message : String(err);
  try {
    const runtime = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    runtime?.emitEvent({
      t: "event",
      kind: "stream-retry",
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      errorName,
      errorMessage,
      nextDelayMs: info.waitMs,
    });
  } catch (emitErr) {
    console.error(`[model-gate] stream-retry emit failed: ${(emitErr as Error)?.message}`, {
      provider: ctx.providerId,
      model: ctx.modelId,
    });
  }
  const source = info.hinted ? "provider Retry-After" : "backoff";
  reportRetryNotice(
    `[retry] rate-limited by ${ctx.providerId ?? "provider"} (429) on ${ctx.stage} call — waiting ` +
      `${Math.ceil(info.waitMs / 1000)}s (${source}) before attempt ${info.attempt + 1}/${info.maxAttempts}`,
    "warn",
  );
}

/** Whether this context declares anything the pacer would act on. */
function pacingApplies(ctx: GateContext): boolean {
  const rl = ctx.rateLimits;
  return Boolean(ctx.providerId && rl && (rl.requestsPerMinute || rl.concurrency || rl.tokensPerMinute));
}

/**
 * Hold the call until it fits the declared budget, and surface any wait.
 *
 * Fail-open on an unexpected pacer fault: a bug in the limiter must never make
 * the app unable to talk to a provider. A 429 is recoverable; a wedged pacer is
 * not.
 */
async function paceCall(ctx: GateContext, estTokens: number): Promise<PaceLease> {
  if (!pacingApplies(ctx)) {
    // Nothing declared to pace against — but the provider may have pushed back
    // recently (a 429 another process recorded). Honour that cooldown; it is a
    // single lock-free read when there is none.
    if (backpressureApplies(ctx)) {
      try {
        await acquireLedgerSlot(ctx.providerId!, undefined, 0, (wait) => emitRateLimitWait(wait, ctx));
      } catch (err) {
        console.error(`[model-gate] provider cooldown check failed (proceeding): ${(err as Error)?.message}`, {
          provider: ctx.providerId,
          model: ctx.modelId,
        });
      }
    }
    return UNPACED;
  }
  let local: RateLimitLease;
  try {
    // Emit through the callback, NOT by walking `lease.waits` afterwards: the
    // lease only resolves once the wait is OVER, so reporting from it would hide
    // the hold for exactly as long as the hold lasts.
    local = await acquireRateLimitSlot(ctx.providerId!, ctx.rateLimits, undefined, (wait) =>
      emitRateLimitWait(wait, ctx),
    );
  } catch (err) {
    console.error(`[model-gate] rate-limit pacing failed (proceeding unpaced): ${(err as Error)?.message}`, {
      provider: ctx.providerId,
      model: ctx.modelId,
      stage: ctx.stage,
    });
    return UNPACED;
  }
  // In-process first (FIFO among this process's callers), then the machine-wide
  // ledger shared with background delegations. The ledger is fail-open itself.
  const waits = local.waits;
  const shared = await acquireLedgerSlot(ctx.providerId!, ctx.rateLimits, estTokens, (wait) => {
    waits.push(wait);
    emitRateLimitWait(wait, ctx);
  });
  return {
    waits,
    // The ledger entry is in flight until the call ends, so its release must
    // ride the stream's end exactly like a local concurrency slot.
    holdsSlot: true,
    release: () => {
      local.release();
      shared.release();
    },
    settle: (usage) => shared.settle(usageTotalTokens(usage)),
  };
}

/**
 * Release the concurrency slot when the stream finishes or is cancelled.
 *
 * Guarded twice. If `TransformStream` cannot be used for any reason the slot is
 * released immediately and the ORIGINAL stream is returned untouched — degrading
 * to "concurrency measured at request initiation" is acceptable; corrupting the
 * model's output stream is not. A watchdog then guarantees that even a stream
 * which is neither drained nor cancelled cannot strand a slot forever, because a
 * stranded slot would deadlock every later call to that provider — a far worse
 * failure than the 429 this module exists to prevent.
 */
function releaseOnStreamEnd<T extends ReadableStream<unknown>>(stream: T, lease: PaceLease, ctx: GateContext): T {
  const watchdog = setTimeout(() => {
    console.error(
      `[model-gate] rate-limit concurrency slot force-released after ${STREAM_SLOT_WATCHDOG_MS}ms — ` +
        `stream neither ended nor cancelled`,
      { provider: ctx.providerId, model: ctx.modelId, stage: ctx.stage },
    );
    lease.release();
  }, STREAM_SLOT_WATCHDOG_MS);
  // Never keep the process alive just to police a slot.
  (watchdog as unknown as { unref?: () => void }).unref?.();
  const done = () => {
    clearTimeout(watchdog);
    lease.release();
  };
  try {
    return stream.pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          // The finish part carries the provider-reported usage — the real TPM cost.
          const part = chunk as { type?: string; usage?: unknown } | null;
          if (part && part.type === "finish") lease.settle(part.usage);
          controller.enqueue(chunk);
        },
        flush: done,
        cancel: done,
      }),
    ) as T;
  } catch (err) {
    console.error(
      `[model-gate] could not wrap stream for concurrency release, releasing early: ${(err as Error)?.message}`,
      { provider: ctx.providerId, model: ctx.modelId, stage: ctx.stage },
    );
    done();
    return stream;
  }
}

/**
 * Surface a pacing wait to a driving agent.
 *
 * A silently stalled run is the exact shape this repo's plan exists to
 * eliminate — "the system reported success for something that did not happen".
 * A paced call looks identical to a hung one unless the wait is announced.
 *
 * Uses the same `globalThis.__muonroiAgentRuntime.emitEvent` channel as the
 * council's model-fallback telemetry (src/council/llm.ts) — no new transport,
 * and no dependency from the provider layer onto the UI. Telemetry must never
 * break a call, so the emit is guarded; per the No-Silent-Catch rule the guard
 * still logs.
 */
function emitRateLimitWait(wait: RateLimitWait, ctx: GateContext): void {
  try {
    const runtime = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    if (!runtime?.emitEvent) return;
    runtime.emitEvent({
      t: "event",
      kind: "rate-limit-wait",
      provider: ctx.providerId ?? "",
      modelId: ctx.modelId,
      stage: ctx.stage,
      limitKind: wait.kind,
      limit: wait.limit,
      waitMs: wait.waitMs,
      ts: Date.now(),
    });
  } catch (err) {
    console.error(`[model-gate] rate-limit-wait emit failed: ${(err as Error)?.message}`, {
      provider: ctx.providerId,
      model: ctx.modelId,
    });
  }
}

/**
 * Fraction of the catalog context window to use as the per-call ceiling.
 *
 * H7: the per-call ceiling derives from catalog `contextWindow` (the honest
 * data), but the per-STAGE budget is settings/env POLICY, not catalog data — a
 * call rarely wants to fill the whole window before we flag it. `MUONROI_GATE_
 * CEILING_RATIO` (0 < r <= 1, default 1.0) scales it: e.g. 0.6 flags a call
 * once it passes 60% of the window. Out-of-range / unparseable values fall back
 * to 1.0 (no scaling). This is the knob calibration will tune before `throw`.
 */
function ceilingRatio(): number {
  const raw = Number(process.env.MUONROI_GATE_CEILING_RATIO);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1;
}

/**
 * Per-call context ceiling for a model, in tokens: catalog `contextWindow`
 * scaled by the env stage-budget ratio (H7). Returns undefined when the catalog
 * has no context window (nothing to compare against).
 */
export function ceilingForCall(modelInfo: ModelInfo | undefined): number | undefined {
  const ctxWindow = modelInfo?.contextWindow;
  if (typeof ctxWindow !== "number" || ctxWindow <= 0) return undefined;
  return Math.floor(ctxWindow * ceilingRatio());
}
