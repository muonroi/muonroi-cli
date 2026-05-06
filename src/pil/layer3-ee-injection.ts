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
import { updateLastSurfacedState } from "../ee/intercept.js";
import { logInteraction } from "../storage/interaction-log.js";
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
    // EE detail log: injection failed
    try {
      if (ctx.sessionId) {
        logInteraction(ctx.sessionId, "ee_injection", {
          eventSubtype: "error",
          data: {
            phase: "pil_enrichment",
            role: "knowledge_retriever",
            error: result.error,
            queryLength: ctx.raw.length,
          },
        });
      }
    } catch { /* fail-open */ }
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "ee-experience-injection", applied: false, delta: `error=${result.error}` }],
    };
  }

  if (points.length === 0) {
    // EE detail log: no relevant experience found
    try {
      if (ctx.sessionId) {
        logInteraction(ctx.sessionId, "ee_injection", {
          eventSubtype: "no_match",
          data: {
            phase: "pil_enrichment",
            role: "knowledge_retriever",
            queryLength: ctx.raw.length,
            taskType: ctx.taskType ?? null,
          },
        });
      }
    } catch { /* fail-open */ }
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "ee-experience-injection", applied: false, delta: "no-points" }],
    };
  }

  // STALE-01: Register injected point IDs for prompt-stale reconciliation.
  // Use String(p.id) since EEPoint.id is string | number from Qdrant.
  updateLastSurfacedState(points.map((p) => String(p.id)));

  const hint = formatExperienceHints(points);
  const budgetShare = Math.floor(ctx.tokenBudget * 0.3);
  const trimmed = truncateToBudget(hint, budgetShare);

  // EE detail log: experience points injected into agent context
  try {
    if (ctx.sessionId) {
      logInteraction(ctx.sessionId, "ee_injection", {
        eventSubtype: "injected",
        data: {
          phase: "pil_enrichment",
          role: "knowledge_retriever",
          pointCount: points.length,
          pointIds: points.map((p) => String(p.id)),
          budgetShare,
          injectedChars: trimmed.length,
          taskType: ctx.taskType ?? null,
          domain: ctx.domain ?? null,
        },
      });
    }
  } catch { /* fail-open */ }

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      { name: "ee-experience-injection", applied: true, delta: `points=${points.length} chars=${trimmed.length}` },
    ],
  };
}
