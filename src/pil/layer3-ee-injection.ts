/**
 * src/pil/layer3-ee-injection.ts
 *
 * PIL Layer 3 — Experience Engine injection.
 *
 * Thin-client aware: when `serverBaseUrl` is configured in ~/.experience/config.json
 * `searchByText` issues a single `/api/search` round-trip (server embeds + Qdrant
 * search server-side). Otherwise falls back to in-process embed + Qdrant.
 */

import type { EEPoint } from "../ee/bridge.js";
import { searchByText } from "../ee/bridge.js";
import { updateLastSurfacedState } from "../ee/intercept.js";
import { getRenderSink } from "../ee/render.js";
import { logInteraction } from "../storage/interaction-log.js";
import { truncateToBudget } from "./budget.js";
import type { PipelineContext } from "./types.js";

// Budget for the HTTP/in-process search round-trip. 60ms (legacy) was tuned for
// localhost Ollama and routinely tripped the abort on VPS thin-client setups
// where embedding goes through SiliconFlow.
const PIL_SEARCH_TIMEOUT_MS = 1500;

// Score floor — points scoring below this are treated as noise and dropped
// before injection. Mirrors the server-side `minConfidence` (0.55) used by
// the intercept path so the brain doesn't pollute prompts with weak hits.
// Set MUONROI_PIL_SCORE_FLOOR=<number> to override per-machine.
const PIL_SCORE_FLOOR = (() => {
  const raw = Number(process.env.MUONROI_PIL_SCORE_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.55;
})();

// Server-side `/api/search` whitelist (experience-engine/server.js):
//   experience-behavioral  — extracted behavioral patterns (seeded by evolve/extract)
//   experience-principles  — abstracted principles (seeded by evolution-abstraction)
// experience-routes / experience-selfqa are intentionally NOT exposed.
const PIL_SEARCH_COLLECTIONS = ["experience-behavioral", "experience-principles"];

async function queryEeBridge(raw: string): Promise<{ points: EEPoint[]; error?: string; filtered?: number }> {
  try {
    const points = await searchByText(raw, PIL_SEARCH_COLLECTIONS, 5, AbortSignal.timeout(PIL_SEARCH_TIMEOUT_MS));
    const kept = points.filter((p) => (p.score ?? 0) >= PIL_SCORE_FLOOR);
    return { points: kept, filtered: points.length - kept.length };
  } catch (err) {
    return { points: [], error: String(err) };
  }
}

function formatExperienceHints(points: EEPoint[]): string {
  if (points.length === 0) return "";
  const lines = points.map((p) => {
    const payload = p.payload ?? {};
    let text = (payload["text"] as string) ?? "";
    if (!text) {
      try {
        const parsed = JSON.parse((payload["json"] as string) || "{}") as {
          solution?: string;
          principle?: string;
          judgment?: string;
        };
        // Prefer the most directly actionable field: solution > principle > judgment.
        text = parsed.solution || parsed.principle || parsed.judgment || "";
      } catch {
        text = "";
      }
    }
    return `- ${text} [id:${p.id}]`;
  });
  return `[experience: Relevant patterns from past work]\n${lines.join("\n")}`;
}

export async function layer3EeInjection(ctx: PipelineContext): Promise<PipelineContext> {
  // Formatter mode: when L1 populated ctx._brainData via the unified call,
  // we just render — zero network round-trips.
  if (ctx._brainData) {
    const principlesBudget = Math.floor(ctx.tokenBudget * 0.15);
    const behavioralBudget = Math.floor(ctx.tokenBudget * 0.15);
    const parts: string[] = [];
    const deltas: string[] = [];

    if (ctx._brainData.t0_principles.length > 0) {
      const lines = ctx._brainData.t0_principles.map((p) => `- ${p.text.slice(0, 120)}`);
      const block = truncateToBudget(
        `[principles: Generalized principles from past work]\n${lines.join("\n")}`,
        principlesBudget,
      );
      parts.push(block);
      deltas.push(`principles=${ctx._brainData.t0_principles.length}`);
    }
    if (ctx._brainData.t2_patterns.length > 0) {
      const lines = ctx._brainData.t2_patterns.map((p) => `- ${p.text.slice(0, 120)}`);
      const block = truncateToBudget(
        `[experience: Relevant patterns from past work]\n${lines.join("\n")}`,
        behavioralBudget,
      );
      parts.push(block);
      deltas.push(`behavioral=${ctx._brainData.t2_patterns.length}`);
    }
    deltas.push(`t1=${ctx._brainData.t1_rules.length}`);
    deltas.push(`src=unified`);

    return {
      ...ctx,
      enriched: parts.length > 0 ? `${ctx.enriched}\n${parts.join("\n")}` : ctx.enriched,
      t1Rules: ctx._brainData.t1_rules,
      layers: [
        ...ctx.layers,
        {
          name: "ee-experience-injection",
          applied: parts.length > 0,
          delta: deltas.join(" "),
        },
      ],
    };
  }

  // Legacy path: existing logic continues below — unchanged.
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
    } catch {
      /* fail-open */
    }
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "ee-experience-injection", applied: false, delta: `error=${result.error}` }],
    };
  }

  if (points.length === 0) {
    // EE detail log: no relevant experience found (or all filtered as noise)
    try {
      if (ctx.sessionId) {
        logInteraction(ctx.sessionId, "ee_injection", {
          eventSubtype: result.filtered && result.filtered > 0 ? "filtered_noise" : "no_match",
          data: {
            phase: "pil_enrichment",
            role: "knowledge_retriever",
            queryLength: ctx.raw.length,
            filteredBelowFloor: result.filtered ?? 0,
            scoreFloor: PIL_SCORE_FLOOR,
            taskType: ctx.taskType ?? null,
          },
        });
      }
    } catch {
      /* fail-open */
    }
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "ee-experience-injection", applied: false, delta: "no-points" }],
    };
  }

  // STALE-01: Register injected point IDs for prompt-stale reconciliation.
  // Use String(p.id) since EEPoint.id is string | number from Qdrant.
  updateLastSurfacedState(points.map((p) => String(p.id)));

  // CQ-16b: Emit experience_injected StreamChunk so TUI can show collapsible block
  // showing which experience was applied (id, score, collection, snippet).
  try {
    const injectedChunk = {
      type: "experience_injected" as const,
      experienceInjected: {
        pointCount: points.length,
        pointIds: points.map((p) => String(p.id)),
        scoreFloor: PIL_SCORE_FLOOR,
        taskType: ctx.taskType ?? undefined,
        domain: ctx.domain ?? undefined,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRenderSink()(injectedChunk as any);
  } catch {
    /* fail-open — never break injection path */
  }

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
  } catch {
    /* fail-open */
  }

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      { name: "ee-experience-injection", applied: true, delta: `points=${points.length} chars=${trimmed.length}` },
    ],
  };
}
