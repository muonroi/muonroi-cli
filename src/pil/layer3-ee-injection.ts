/**
 * src/pil/layer3-ee-injection.ts
 *
 * PIL Layer 3 — Experience Engine injection.
 *
 * Thin-client aware: when `serverBaseUrl` is configured in ~/.experience/config.json
 * `searchByText` issues a single `/api/search` round-trip (server embeds + Qdrant
 * search server-side). Otherwise falls back to in-process embed + Qdrant.
 *
 * ## BB dedup (shared contract with src/ee/bb-retrieval.ts)
 * Before appending any EE hit this layer scans `ctx.enriched` for
 * `<!-- bb-context-injected:<sha16> -->` markers written by bb-retrieval.ts.
 * When the computed sha of an EE hit payload matches a marker already present,
 * the hit is skipped — preventing double-injection when both CB-1 (loop-driver)
 * and PIL Layer 3 are active on the same pipeline run.
 */

import { createHash } from "node:crypto";
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

// T0 principles use a lower floor because they are pre-validated abstractions
// from the evolution engine (cluster → abstract lifecycle). They are less
// prompt-specific than behavioral patterns, so a lower cosine threshold is
// acceptable — relevance comes from the principle's generality, not from
// exact wording matching the current prompt.
const PIL_PRINCIPLES_FLOOR = Math.max(0, PIL_SCORE_FLOOR - 0.15);

// hitCount threshold for promoting a behavioral point to T1 "proven" reflex.
// Mirrors the EE evolution promotion rule (3 confirmed hits → T1).
const T1_HIT_THRESHOLD = 3;

/**
 * Extract all sha16 values from `<!-- bb-context-injected:<sha16> -->` markers
 * already present in the enriched context string.
 */
function extractBBMarkerShas(enriched: string): Set<string> {
  const shas = new Set<string>();
  const regex = /<!-- bb-context-injected:([0-9a-f]{16}) -->/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(enriched)) !== null) {
    shas.add(m[1]);
  }
  return shas;
}

/**
 * Compute sha16 for a payload text (mirrors bbContextMarker in bb-retrieval.ts).
 * Used to check whether an EE hit payload was already injected by the BB path.
 */
function payloadSha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Server-side `/api/search` whitelist (experience-engine/server.js):
//   experience-behavioral  — extracted behavioral patterns (T1/T2, seeded by evolve/extract)
//   experience-principles  — abstracted principles (T0, seeded by evolution-abstraction)
// experience-routes / experience-selfqa are intentionally NOT exposed.

function extractPointText(p: EEPoint): string {
  const payload = p.payload ?? {};
  const text = (payload["text"] as string) ?? "";
  if (text) return text;
  try {
    const parsed = JSON.parse((payload["json"] as string) || "{}") as {
      solution?: string;
      principle?: string;
      judgment?: string;
    };
    return parsed.solution ?? parsed.principle ?? parsed.judgment ?? "";
  } catch {
    return "";
  }
}

function isT1Proven(p: EEPoint): boolean {
  try {
    const parsed = JSON.parse(((p.payload ?? {})["json"] as string) || "{}") as {
      tier?: string;
      hitCount?: number;
    };
    return parsed.tier === "proven" || (parsed.hitCount ?? 0) >= T1_HIT_THRESHOLD;
  } catch {
    return false;
  }
}

interface BridgeResult {
  principlePoints: EEPoint[];
  behavioralPoints: EEPoint[];
  t1Rules: string[];
  error?: string;
  filtered?: number;
}

async function queryEeBridge(raw: string): Promise<BridgeResult> {
  try {
    // Parallel queries: T0 principles (lower floor, pre-validated abstractions)
    // and T1/T2 behavioral (standard floor, contextual patterns). Running both
    // concurrently keeps total latency at ~1500ms rather than ~3000ms.
    const signal = AbortSignal.timeout(PIL_SEARCH_TIMEOUT_MS);
    const [principleRaw, behavioralRaw] = await Promise.all([
      searchByText(raw, ["experience-principles"], 3, signal),
      searchByText(raw, ["experience-behavioral"], 4, signal),
    ]);

    const principlePoints = principleRaw.filter((p) => (p.score ?? 0) >= PIL_PRINCIPLES_FLOOR);
    const behavioralPoints = behavioralRaw.filter((p) => (p.score ?? 0) >= PIL_SCORE_FLOOR);
    const filtered = principleRaw.length - principlePoints.length + (behavioralRaw.length - behavioralPoints.length);

    // T1 rules = proven-tier points from either collection. These get stored on
    // ctx and appended as MANDATORY RULES by Layer 6 — they're behavioral
    // reflexes, not hints.
    const t1Rules = [...principlePoints, ...behavioralPoints].filter(isT1Proven).map(extractPointText).filter(Boolean);

    return { principlePoints, behavioralPoints, t1Rules, filtered };
  } catch (err) {
    return { principlePoints: [], behavioralPoints: [], t1Rules: [], error: String(err) };
  }
}

function formatPrincipleRules(points: EEPoint[]): string {
  if (points.length === 0) return "";
  const lines = points.map((p) => `- ${extractPointText(p)} [id:${p.id}]`).filter((l) => l !== "- ");
  if (lines.length === 0) return "";
  return `[rules: Generalized principles from past work]\n${lines.join("\n")}`;
}

function formatExperienceHints(points: EEPoint[]): string {
  if (points.length === 0) return "";
  const lines = points.map((p) => `- ${extractPointText(p)} [id:${p.id}]`).filter((l) => l !== "- ");
  if (lines.length === 0) return "";
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
  const { principlePoints, behavioralPoints, t1Rules } = result;
  const totalPoints = principlePoints.length + behavioralPoints.length;

  if (result.error) {
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

  if (totalPoints === 0) {
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

  // BB dedup: skip any EE hit whose payload text sha16 is already marked in ctx.enriched.
  // This prevents double-injection when loop-driver CB-1 already injected BB context
  // via bb-retrieval.ts on the same pipeline run.
  const bbMarkerShas = extractBBMarkerShas(ctx.enriched);
  const deduplicatedPrinciples = bbMarkerShas.size > 0
    ? principlePoints.filter((p) => {
        const text = extractPointText(p);
        return text.length === 0 || !bbMarkerShas.has(payloadSha16(text));
      })
    : principlePoints;
  const deduplicatedBehavioral = bbMarkerShas.size > 0
    ? behavioralPoints.filter((p) => {
        const text = extractPointText(p);
        return text.length === 0 || !bbMarkerShas.has(payloadSha16(text));
      })
    : behavioralPoints;

  const allPoints = [...deduplicatedPrinciples, ...deduplicatedBehavioral];

  // STALE-01: Register injected point IDs for prompt-stale reconciliation.
  updateLastSurfacedState(allPoints.map((p) => String(p.id)));

  // CQ-16b: Emit experience_injected StreamChunk so TUI can show collapsible block.
  try {
    const injectedChunk = {
      type: "experience_injected" as const,
      experienceInjected: {
        pointCount: totalPoints,
        pointIds: allPoints.map((p) => String(p.id)),
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

  // T0 principles get 15% of budget (pre-validated, always-relevant abstractions).
  // T1/T2 behavioral get 15% of budget (contextual patterns).
  // Total EE injection stays within the original 30% budget share.
  const principlesBudget = Math.floor(ctx.tokenBudget * 0.15);
  const behavioralBudget = Math.floor(ctx.tokenBudget * 0.15);

  const parts: string[] = [];
  const rulesText = formatPrincipleRules(deduplicatedPrinciples);
  if (rulesText) parts.push(truncateToBudget(rulesText, principlesBudget));
  const hintsText = formatExperienceHints(deduplicatedBehavioral);
  if (hintsText) parts.push(truncateToBudget(hintsText, behavioralBudget));
  const injected = parts.join("\n");

  try {
    if (ctx.sessionId) {
      logInteraction(ctx.sessionId, "ee_injection", {
        eventSubtype: "injected",
        data: {
          phase: "pil_enrichment",
          role: "knowledge_retriever",
          principleCount: principlePoints.length,
          behavioralCount: behavioralPoints.length,
          t1RuleCount: t1Rules.length,
          pointIds: allPoints.map((p) => String(p.id)),
          injectedChars: injected.length,
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
    enriched: `${ctx.enriched}\n${injected}`,
    t1Rules: t1Rules.length > 0 ? t1Rules : ctx.t1Rules,
    layers: [
      ...ctx.layers,
      {
        name: "ee-experience-injection",
        applied: true,
        delta: `principles=${deduplicatedPrinciples.length} behavioral=${deduplicatedBehavioral.length} t1=${t1Rules.length} chars=${injected.length}${bbMarkerShas.size > 0 ? ` bb-dedup=${bbMarkerShas.size}` : ""}`,
      },
    ],
  };
}
