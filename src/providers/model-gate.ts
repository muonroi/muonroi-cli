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
import type { ModelInfo } from "../types/index.js";

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
export function ceilingMode(): CeilingMode {
  const raw = process.env.MUONROI_GATE_CEILING;
  if (raw === undefined || raw === "") return "warn";
  const v = raw.toLowerCase();
  return v === "warn" || v === "throw" || v === "off" ? v : "warn";
}

/**
 * Stages where a `throw` ceiling is armed. D1: enforce only where a runaway is
 * most costly — the sub-agent tool loop (and its vision variant), whose growing
 * history is the documented leak. `main` stays advisory (warn) even in throw
 * mode so a user's own long turn is never hard-killed mid-flight; compaction/pil
 * are never enforced (compaction IS the recovery mechanism — H4).
 */
const THROW_ELIGIBLE: ReadonlySet<GateStage> = new Set<GateStage>(["subagent", "vision"]);

/**
 * Write one `call_accounting` row for a metered call. Fail-open: logging must
 * never break a turn (a call with no sessionId is skipped — nowhere to attribute).
 */
export function meterCall(prompt: unknown, ctx: GateContext, op: "stream" | "generate"): void {
  try {
    if (!ctx.sessionId) return;
    const comp = analyzePrompt(prompt);
    const ceilingHit = typeof ctx.ceiling === "number" ? comp.estInputTokens > ctx.ceiling : false;
    logInteraction(ctx.sessionId, "call_accounting", {
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
        ceilingMode: ceilingMode(),
      },
    });
  } catch {
    // Fail-open — the meter must never break the call it measures.
  }
}

/**
 * Enforce the per-call ceiling per the current mode. Throws
 * `InputCeilingExceededError` in `throw` mode for a throw-eligible stage; logs a
 * warning in `warn` mode. Never throws for `off`, a non-eligible stage, or when
 * the ceiling is unknown. `analyzePrompt` is passed in so the prompt is walked
 * once by the caller (no double walk).
 */
export function enforceCeiling(comp: CallComposition, ctx: GateContext): void {
  if (typeof ctx.ceiling !== "number") return;
  if (comp.estInputTokens <= ctx.ceiling) return;
  const mode = ceilingMode();
  if (mode === "off") return;
  if (mode === "throw" && THROW_ELIGIBLE.has(ctx.stage)) {
    throw new InputCeilingExceededError(ctx.stage, comp.estInputTokens, ctx.ceiling, comp.bySegment);
  }
  // warn (or throw on a non-eligible stage): visibility only, never kill the call.
  console.warn(
    `[model-gate] ceiling ${mode === "throw" ? "warn (stage not throw-eligible)" : "warn"}: ` +
      `stage=${ctx.stage} est=${comp.estInputTokens} > ceiling=${ctx.ceiling} model=${ctx.modelId}`,
  );
}

/**
 * Meter + enforce a single call. Walks the prompt ONCE, records the accounting
 * row, then applies the ceiling policy (which may throw before delegating).
 */
function gateCall(prompt: unknown, ctx: GateContext, op: "stream" | "generate"): void {
  let comp: CallComposition | undefined;
  try {
    comp = analyzePrompt(prompt);
    if (ctx.sessionId) {
      const ceilingHit = typeof ctx.ceiling === "number" ? comp.estInputTokens > ctx.ceiling : false;
      logInteraction(ctx.sessionId, "call_accounting", {
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
          ceilingMode: ceilingMode(),
        },
      });
    }
  } catch {
    // Metering is fail-open — but enforcement must still run below if we got a
    // composition (a DB write failure must not disarm the ceiling).
  }
  // Enforce OUTSIDE the fail-open catch so a genuine ceiling throw propagates.
  if (comp) enforceCeiling(comp, ctx);
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
  if (!model || gateDisabled()) return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ doStream, params }) => {
        gateCall((params as { prompt?: unknown }).prompt, ctx, "stream");
        return doStream();
      },
      wrapGenerate: async ({ doGenerate, params }) => {
        gateCall((params as { prompt?: unknown }).prompt, ctx, "generate");
        return doGenerate();
      },
    },
  });
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
