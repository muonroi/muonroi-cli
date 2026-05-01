/**
 * src/pil/layer3-ee-injection.ts
 *
 * PIL Layer 3 — Experience Engine injection.
 * Uses in-process bridge.getEmbeddingRaw + bridge.searchCollection.
 * Eliminates network overhead and EE server dependency for vector
 * search (PIL-02). HTTP-based approach removed in Phase 06.
 */

import { getEmbeddingRaw, searchCollection } from "../ee/bridge.js";
import type { EEPoint } from "../ee/bridge.js";
import { truncateToBudget } from "./budget.js";
import type { PipelineContext } from "./types.js";

async function queryEeBridge(raw: string): Promise<{ points: EEPoint[]; error?: string }> {
  try {
    const vector = await getEmbeddingRaw(raw, AbortSignal.timeout(60));
    if (!vector) return { points: [], error: "no-embedding" };
    const points = await searchCollection("experience-behavioral", vector, 5, AbortSignal.timeout(40));
    return { points };
  } catch (err) {
    return { points: [], error: String(err) };
  }
}

function formatExperienceHints(points: EEPoint[]): string {
  if (points.length === 0) return "";
  const lines = points.map((p) => {
    const payload = p.payload ?? {};
    const text =
      (payload["text"] as string) ||
      (() => {
        try {
          return (JSON.parse((payload["json"] as string) || "{}") as { solution?: string }).solution || "";
        } catch {
          return "";
        }
      })();
    return `- ${text} [id:${p.id}]`;
  });
  return `[experience: Relevant patterns from past work]\n${lines.join("\n")}`;
}

export async function layer3EeInjection(ctx: PipelineContext): Promise<PipelineContext> {
  const result = await queryEeBridge(ctx.raw);
  const { points } = result;

  if (result.error) {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "ee-experience-injection", applied: false, delta: `error=${result.error}` }],
    };
  }

  if (points.length === 0) {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "ee-experience-injection", applied: false, delta: "no-points" }],
    };
  }

  const hint = formatExperienceHints(points);
  const budgetShare = Math.floor(ctx.tokenBudget * 0.3);
  const trimmed = truncateToBudget(hint, budgetShare);

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      { name: "ee-experience-injection", applied: true, delta: `points=${points.length} chars=${trimmed.length}` },
    ],
  };
}
