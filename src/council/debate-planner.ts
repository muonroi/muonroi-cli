import type { StreamChunk } from "../types/index.js";
import type { ClarifiedSpec, CouncilLLM, DebatePlan, DebateStance, OutputSection, OutputShape } from "./types.js";
import { buildDebatePlanPrompt } from "./prompts.js";
import { tracedGenerate } from "./llm.js";

const FALLBACK_PLAN: DebatePlan = {
  intentSummary: "(planner unavailable — using generic stances)",
  stances: [
    { name: "Primary Analyst", lens: "Address the success criteria with concrete reasoning." },
    { name: "Critical Reviewer", lens: "Stress-test claims, surface missing evidence, identify risks." },
  ],
  outputShape: {
    kind: "decision",
    sections: [
      { key: "agreed", heading: "Agreed", prompt: "points participants converged on", shape: "list" },
      { key: "tradeoffs", heading: "Trade-offs", prompt: "real trade-offs identified", shape: "list" },
      { key: "recommendation", heading: "Recommendation", prompt: "decisive verdict", shape: "text" },
    ],
    guardrails: ["Be evidence-grounded; flag any claim that lacks support."],
  },
};

/**
 * Leader-LLM proposes the debate's stances + output shape based on the topic.
 * Falls back to a generic plan if the LLM call or parsing fails.
 */
export async function* planDebate(
  spec: ClarifiedSpec,
  leaderModelId: string,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, DebatePlan, unknown> {
  const { system, prompt } = buildDebatePlanPrompt(spec);
  let raw: string;
  try {
    raw = yield* tracedGenerate(llm, {
      phase: "plan_debate",
      label: "Planning debate (stances + output shape)",
      modelId: leaderModelId,
      system,
      prompt,
      maxTokens: 1500,
    });
  } catch (err) {
    yield { type: "content", content: `[Debate planning error: ${err instanceof Error ? err.message : err}]\n` };
    return FALLBACK_PLAN;
  }

  const parsed = parsePlan(raw);
  return parsed ?? FALLBACK_PLAN;
}

function parsePlan(raw: string): DebatePlan | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]) as Partial<DebatePlan>;

    const stances = sanitizeStances(obj.stances);
    if (stances.length < 2) return null;

    const outputShape = sanitizeShape(obj.outputShape);
    if (!outputShape) return null;

    return {
      intentSummary: typeof obj.intentSummary === "string" && obj.intentSummary.trim()
        ? obj.intentSummary.trim()
        : "(no intent summary provided)",
      stances,
      outputShape,
    };
  } catch {
    return null;
  }
}

function sanitizeStances(raw: unknown): DebateStance[] {
  if (!Array.isArray(raw)) return [];
  const out: DebateStance[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const lens = typeof obj.lens === "string" ? obj.lens.trim() : "";
    if (!name || !lens) continue;
    const focus = typeof obj.focus === "string" && obj.focus.trim() ? obj.focus.trim() : undefined;
    out.push({ name, lens, focus });
    if (out.length >= 4) break;
  }
  return out;
}

function sanitizeShape(raw: unknown): OutputShape | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const sections = sanitizeSections(obj.sections);
  if (sections.length === 0) return null;
  const guardrails = Array.isArray(obj.guardrails)
    ? obj.guardrails.filter((g): g is string => typeof g === "string" && g.trim().length > 0).map((g) => g.trim())
    : [];
  return {
    kind: typeof obj.kind === "string" && obj.kind.trim() ? obj.kind.trim() : "decision",
    sections,
    guardrails,
  };
}

function sanitizeSections(raw: unknown): OutputSection[] {
  if (!Array.isArray(raw)) return [];
  const out: OutputSection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key.trim() : "";
    const heading = typeof obj.heading === "string" ? obj.heading.trim() : "";
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (!key || !heading) continue;
    const shapeRaw = typeof obj.shape === "string" ? obj.shape.trim() : "list";
    const shape: OutputSection["shape"] =
      shapeRaw === "text" ? "text" : shapeRaw === "objectList" ? "objectList" : "list";
    out.push({ key, heading, prompt: prompt || heading.toLowerCase(), shape });
  }
  return out;
}
