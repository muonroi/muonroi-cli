// src/product-loop/discovery-triage.ts
//
// Model-decided interview triage.
//
// The discover/gather interview used to size itself off `computePromptSpecificity`
// — a hardcoded word-count + keyword-list heuristic. That misclassifies precise-
// but-trivial ideas: "build a Python script hello.py that prints … and a pytest
// test" is ~18 words with no keyword hit → "moderate" → the user is dragged
// through 6 generic cards (productType/platform/audience/architecture/stack/db)
// and the productType recommender falls back to "other". That is the "hời hợt /
// hardcode" UX users complained about, and it violates the project's
// agent-first-no-regex principle (interview depth must be model-decided).
//
// This module asks the leader model to triage the idea into a complexity tier and,
// for genuinely complex ideas, name which of the fixed required questions actually
// shape the build. The interview then:
//   - trivial → auto-fill every required answer → ONE summary confirm card
//   - complex → keep only the model-relevant questions as cards, auto-fill the rest
//   - standard → unchanged per-question flow
//
// Fail-safe: any parse/LLM failure returns a `fallback` triage derived from the
// old specificity heuristic, so the interview degrades to today's behaviour rather
// than breaking. Pure decision + one bounded LLM call → unit-testable.

import type { LeaderLike } from "./discovery-prompt-parser.js";
import { computePromptSpecificity } from "./discovery-recommender.js";
import { type DiscoveryQuestion, REQUIRED_QUESTION_IDS } from "./discovery-schema.js";

export type ComplexityTier = "trivial" | "standard" | "complex";

export interface InterviewTriage {
  complexity: ComplexityTier;
  /**
   * Required question ids (subset of REQUIRED_QUESTION_IDS) whose answers
   * genuinely shape THIS build and must stay interactive cards. Only meaningful
   * for `complexity === "complex"`; empty for trivial (auto-fill all) and ignored
   * for standard (keep all cards).
   */
  relevant: string[];
  rationale: string;
  source: "model" | "fallback";
}

const TRIAGE_SYSTEM =
  "You triage a software build request to decide how much of an interview it warrants. " +
  "Output ONE JSON object, no prose, no code fences: " +
  '{"complexity":"trivial"|"standard"|"complex","relevant":[<question-id>...],"rationale":"<short>"}.\n\n' +
  "Tiers:\n" +
  '- "trivial": a self-contained script, snippet, one-off tool, or exercise with ONE obvious stack and NO ' +
  "persistence / scale / architecture / integration decisions. Examples: a hello-world script + a test, " +
  "a regex to validate an email, a bash one-liner, a single pure function + unit test. The user should just " +
  "confirm sensible defaults — asking about audience scale, backend architecture, or database strategy is noise.\n" +
  '- "standard": a real but conventional app with a few genuine but well-trodden choices. Examples: a todo web ' +
  "app, a CRUD REST API, a small CLI with a couple of subcommands.\n" +
  '- "complex": multiple non-obvious architecture / scale / integration / security decisions. Examples: a ' +
  "multi-tenant SaaS, an OAuth / SSO service, an event-driven pipeline, anything naming enterprise scale.\n\n" +
  'For "complex" ONLY, set `relevant` to the question ids (from the provided list) whose answers genuinely ' +
  "shape this build and MUST be asked; auto-filled defaults are fine for the rest. For trivial/standard, " +
  "set `relevant` to []. Bias toward FEWER questions: every card the user accepts by reflex becomes locked-in spec.";

function buildTriagePrompt(idea: string, requiredQuestions: DiscoveryQuestion[]): string {
  const qList = requiredQuestions.map((q) => `- ${q.id}: ${q.prompt}`).join("\n");
  return [
    `Build request: ${JSON.stringify(idea)}`,
    "",
    "Required question ids you may cite in `relevant`:",
    qList,
  ].join("\n");
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
}

const TIERS: ReadonlySet<string> = new Set<ComplexityTier>(["trivial", "standard", "complex"]);

/** Graceful-degrade triage derived from the legacy specificity heuristic. */
export function fallbackTriage(idea: string): InterviewTriage {
  const specificity = computePromptSpecificity(idea);
  // minimal prompt → treat as trivial (collapse to one confirm card, matching the
  // old minimal-autofill path); everything else stays "standard" so the current
  // per-question behaviour is preserved when the model is unavailable.
  const complexity: ComplexityTier = specificity === "minimal" ? "trivial" : "standard";
  return { complexity, relevant: [], rationale: `fallback from specificity=${specificity}`, source: "fallback" };
}

function parseTriage(raw: string): { complexity: ComplexityTier; relevant: string[]; rationale: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  const obj = parsed as { complexity?: unknown; relevant?: unknown; rationale?: unknown };
  if (typeof obj?.complexity !== "string" || !TIERS.has(obj.complexity)) return null;
  const requiredSet = new Set(REQUIRED_QUESTION_IDS);
  const relevant = Array.isArray(obj.relevant)
    ? (obj.relevant.filter((r) => typeof r === "string" && requiredSet.has(r)) as string[])
    : [];
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  return { complexity: obj.complexity as ComplexityTier, relevant, rationale };
}

/**
 * Triage the interview depth for `idea` via one leader call. Never throws —
 * returns a fallback triage on any LLM/parse failure. Skips the call entirely
 * (and returns the fallback) when the idea is empty.
 */
export async function triageInterview(
  idea: string,
  leader: LeaderLike,
  requiredQuestions: DiscoveryQuestion[],
): Promise<InterviewTriage> {
  if (!idea || idea.trim().length === 0) return fallbackTriage(idea);
  try {
    const res = await leader.generate({
      system: TRIAGE_SYSTEM,
      prompt: buildTriagePrompt(idea, requiredQuestions),
      maxTokens: 1024,
    });
    const parsed = parseTriage(res?.content ?? "");
    if (!parsed) return fallbackTriage(idea);
    // `relevant` is only meaningful for complex; normalize the others to [].
    const relevant = parsed.complexity === "complex" ? parsed.relevant : [];
    return { complexity: parsed.complexity, relevant, rationale: parsed.rationale, source: "model" };
  } catch {
    return fallbackTriage(idea);
  }
}
