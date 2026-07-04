import { writeFileSync } from "node:fs";
import { resolvePlanCouncilLeader } from "../council/leader.js";
import { ASSESSMENT_OUTPUT_CONTRACT, extractComplexityVerdict } from "./assessment-schema.js";
import { ensurePlanningWorkspace } from "./config-bridge.js";
import { planningArtifact } from "./paths.js";

export interface AssessInput {
  cwd: string;
  raw: string;
  priorDepth: "quick" | "standard" | "heavy";
  confidence: number;
  conversationDigest?: string;
  eeContext?: string;
  sessionModelId: string;
  runAssessor?: (prompt: string) => Promise<string>;
}
export interface AssessResult {
  depth: "quick" | "standard" | "heavy";
  autoCouncil: boolean;
  rationale: string;
  assessed: boolean;
  source: "assessor" | "prefilter-skip" | "parse-failed-fallback";
  assessmentPath?: string;
}

const CONFIDENCE_FLOOR = 0.7;

/** Run the leader-tier assessor only when the fast layer1 call is uncertain or the task is non-trivial. */
export function shouldAssess(priorDepth: string, confidence: number): boolean {
  if (priorDepth === "standard" || priorDepth === "heavy") return true;
  return confidence < CONFIDENCE_FLOOR; // low-confidence quick → double-check
}

function buildAssessorPrompt(input: AssessInput): string {
  return [
    "You are the complexity assessor — the highest-tier router for an autonomous coding agent.",
    "Judge how much rigor this task needs and whether it warrants multi-perspective debate.",
    "Be decisive: over-tiering wastes the user's time, under-tiering ships unreviewed risky changes.",
    "",
    `Fast classifier's first-pass depth: ${input.priorDepth} (confidence ${input.confidence.toFixed(2)}).`,
    input.conversationDigest ? `\nRecent conversation:\n${input.conversationDigest}` : "",
    input.eeContext ? `\nPrior experience (EE recall):\n${input.eeContext}` : "",
    "",
    "### Task",
    input.raw,
    ASSESSMENT_OUTPUT_CONTRACT,
  ].join("\n");
}

function writeAssessment(
  cwd: string,
  r: { depth: string; autoCouncil: boolean; rationale: string },
  leaderModelId: string,
): string {
  ensurePlanningWorkspace(cwd, leaderModelId);
  const path = planningArtifact(cwd, "ASSESSMENT.md");
  writeFileSync(
    path,
    [
      "# ASSESSMENT",
      "",
      `depth: ${r.depth}`,
      `autoCouncil: ${r.autoCouncil}`,
      `leader: \`${leaderModelId}\``,
      "",
      "## Rationale",
      "",
      r.rationale || "(none)",
    ].join("\n"),
    "utf8",
  );
  return path;
}

/**
 * Enrich the native depth decision. Pre-filter short-circuits trivial turns (no LLM cost);
 * otherwise a leader-tier call reasons over the task + context and returns a structured
 * verdict that OVERRIDES pilCtx.modelDepthTier. Never throws — degrades to priorDepth.
 */
export async function assessComplexity(input: AssessInput): Promise<AssessResult> {
  if (!shouldAssess(input.priorDepth, input.confidence)) {
    return { depth: input.priorDepth, autoCouncil: false, rationale: "", assessed: false, source: "prefilter-skip" };
  }
  if (!input.runAssessor) {
    // No runner (offline/test path without a fixture) — keep priorDepth, do not fabricate.
    return { depth: input.priorDepth, autoCouncil: false, rationale: "", assessed: false, source: "prefilter-skip" };
  }
  let raw = "";
  try {
    raw = await input.runAssessor(buildAssessorPrompt(input));
  } catch (err) {
    console.error(`[gsd] complexity assessor call failed, keeping priorDepth: ${(err as Error).message}`);
    return {
      depth: input.priorDepth,
      autoCouncil: false,
      rationale: "",
      assessed: false,
      source: "parse-failed-fallback",
    };
  }
  const verdict = extractComplexityVerdict(raw);
  if (!verdict) {
    console.error("[gsd] complexity assessor emitted no structured verdict — keeping priorDepth");
    return {
      depth: input.priorDepth,
      autoCouncil: false,
      rationale: "",
      assessed: false,
      source: "parse-failed-fallback",
    };
  }
  const leader = await resolvePlanCouncilLeader(input.sessionModelId);
  const path = writeAssessment(input.cwd, verdict, leader.modelId);
  return {
    depth: verdict.depth,
    autoCouncil: verdict.autoCouncil,
    rationale: verdict.rationale,
    assessed: true,
    source: "assessor",
    assessmentPath: path,
  };
}
