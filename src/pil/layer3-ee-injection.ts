/**
 * src/pil/layer3-ee-injection.ts
 *
 * PIL Layer 3 — Experience Engine injection.
 * Queries the EE brain for relevant experience points and injects them
 * into the prompt context as hints.
 */

import type { PipelineContext } from "./types.js";
import { truncateToBudget } from "./budget.js";

const EE_URL = process.env.EE_URL || "http://localhost:8082";
const EE_TIMEOUT_MS = 100;

interface EePoint {
  id: string;
  text: string;
  score: number;
  collection: string;
}

interface EeSearchResponse {
  points: EePoint[];
}

async function queryEe(query: string, taskType: string): Promise<{ points: EePoint[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EE_TIMEOUT_MS);

  try {
    const res = await fetch(`${EE_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, taskType, limit: 5 }),
      signal: controller.signal,
    });

    if (!res.ok) return { points: [], error: `http-${res.status}` };
    const data = (await res.json()) as EeSearchResponse;
    return { points: data.points ?? [] };
  } catch (err) {
    return { points: [], error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function formatExperienceHints(points: EePoint[]): string {
  if (points.length === 0) return "";
  const lines = points.map((p) => `- ${p.text} [id:${p.id} col:${p.collection}]`);
  return `[experience: Relevant patterns from past work]\n${lines.join("\n")}`;
}

export async function layer3EeInjection(ctx: PipelineContext): Promise<PipelineContext> {
  const result = await queryEe(ctx.raw, ctx.taskType ?? "unknown");
  const { points } = result;

  if (result.error) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: "ee-experience-injection", applied: false, delta: `error=${result.error}` },
      ],
    };
  }

  if (points.length === 0) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: "ee-experience-injection", applied: false, delta: "no-points" },
      ],
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
      {
        name: "ee-experience-injection",
        applied: true,
        delta: `points=${points.length} chars=${trimmed.length}`,
      },
    ],
  };
}
