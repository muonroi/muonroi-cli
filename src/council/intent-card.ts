import type { CouncilQuestionOption } from "../types/index.js";
import { ANALYSIS_INTENT_KINDS, coerceIntentKind, IMPLEMENTATION_INTENT_KINDS, type IntentKind } from "./types.js";

/**
 * User-facing copy per intent kind. Keyed by the union (NOT a free-form list) so
 * adding an IntentKind fails to compile until its copy exists. This is UI copy,
 * not a model/provider literal — the Zero-Hardcode rule does not apply.
 */
export const INTENT_COPY: Record<IntentKind, { label: string; description: string }> = {
  implementation_plan: {
    label: "Implement — plan it, review it, then build",
    description: "The council debates, a planner writes a phased plan, the panel reviews it, then it gets built.",
  },
  action_items: {
    label: "Produce action items",
    description: "Converge on a concrete, ordered list of changes to make.",
  },
  decision: { label: "Decide between options", description: "Pick one option and record why the others lose." },
  evaluation: { label: "Evaluate / review", description: "Assess what exists — strengths, failure modes, evidence." },
  investigation: {
    label: "Debug / investigate",
    description: "Find the root cause from evidence before proposing anything.",
  },
  resolve_question: { label: "Answer a question", description: "Settle a specific question the session is stuck on." },
};

/** Union order, implementation kinds first — the deterministic option ordering. */
const KIND_ORDER: IntentKind[] = [...IMPLEMENTATION_INTENT_KINDS, ...ANALYSIS_INTENT_KINDS];

/**
 * Intent options for the launch card. `proposedKind` is the leader's own
 * `debatePlan.outputShape.kind` and leads the list; `intentSummary` is the
 * leader's one-sentence read of the topic, shown on that first option so the
 * recommendation is topic-specific rather than generic.
 */
export function buildIntentOptions(proposedKind: IntentKind, intentSummary: string): CouncilQuestionOption[] {
  const ordered = [proposedKind, ...KIND_ORDER.filter((k) => k !== proposedKind)];
  return ordered.map((kind, i) => ({
    label: i === 0 ? `${INTENT_COPY[kind].label} (recommended)` : INTENT_COPY[kind].label,
    description: i === 0 && intentSummary.trim() ? intentSummary.trim() : INTENT_COPY[kind].description,
    value: kind,
    kind: "choice" as const,
  }));
}

/**
 * Resolve the card answer. Unlike `coerceIntentKind`, junk falls back to the
 * CALLER's kind rather than to "evaluation": the leader's proposal is a better
 * default than a fixed one, and silently rewriting a build run into an analysis
 * run is the failure this whole gate exists to stop.
 */
export function parseIntentAnswer(raw: string, fallback: IntentKind): IntentKind {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  const coerced = coerceIntentKind(trimmed);
  return coerced === "evaluation" && trimmed !== "evaluation" ? fallback : coerced;
}
