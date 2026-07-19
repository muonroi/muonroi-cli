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
      },
    });
  } catch {
    // Fail-open — the meter must never break the call it measures.
  }
}

/**
 * Wrap a resolved model so every doStream/doGenerate call is metered.
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
        meterCall((params as { prompt?: unknown }).prompt, ctx, "stream");
        return doStream();
      },
      wrapGenerate: async ({ doGenerate, params }) => {
        meterCall((params as { prompt?: unknown }).prompt, ctx, "generate");
        return doGenerate();
      },
    },
  });
}

/**
 * Per-call context ceiling for a model, in tokens.
 *
 * H7: the per-call ceiling derives honestly from catalog `contextWindow`. The
 * per-STAGE multiplier is deliberately NOT applied here — catalog carries no
 * per-stage ceiling; stage budgets are settings/env policy and belong to the
 * ENFORCE phase, not this meter. Returns undefined when the catalog has no
 * context window (nothing to compare against).
 */
export function ceilingForCall(modelInfo: ModelInfo | undefined): number | undefined {
  const ctxWindow = modelInfo?.contextWindow;
  return typeof ctxWindow === "number" && ctxWindow > 0 ? ctxWindow : undefined;
}
