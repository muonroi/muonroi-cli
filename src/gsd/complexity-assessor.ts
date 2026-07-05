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
  bundle?: import("./pil-gate-context.js").GateContextBundle;
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
  quality?: { verdict: "adequate" | "enriched" | "needs-user"; missing: string[]; noiseRisk: "low" | "med" | "high" };
  enrichedPrompt: string;
}

const CONFIDENCE_FLOOR = 0.7;

/**
 * Continuation turns get a HIGHER confidence bar before a `quick` verdict is
 * trusted enough to skip the leader check. A terse follow-up ("làm tiếp", "từ
 * các phần đó ...") can point at heavy prior work yet read as trivially simple
 * in isolation, so the fast classifier's `quick` is less reliable here even
 * with the recent-conversation digest now fed to it (defense in depth). Default
 * 0.85; env MUONROI_GSD_CONTINUATION_CONF_FLOOR overrides (clamped to
 * [CONFIDENCE_FLOOR, 1]). Set it to CONFIDENCE_FLOOR to disable the extra bar.
 */
function continuationConfidenceFloor(): number {
  const raw = Number.parseFloat(process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR ?? "");
  if (!Number.isFinite(raw)) return 0.85;
  return Math.min(1, Math.max(CONFIDENCE_FLOOR, raw));
}

/**
 * Run the leader-tier assessor only when the fast layer1 call is uncertain or
 * the task is non-trivial. `hasPriorContext` = there is a recent-conversation
 * digest (a continuation turn); such turns raise the skip bar so a
 * context-dependent follow-up mis-scored as `quick` still gets the
 * context-aware leader check rather than silently skipping it.
 */
export function shouldAssess(priorDepth: string, confidence: number, hasPriorContext = false): boolean {
  if (priorDepth === "standard" || priorDepth === "heavy") return true;
  const floor = hasPriorContext ? continuationConfidenceFloor() : CONFIDENCE_FLOOR;
  return confidence < floor; // low-confidence quick → double-check
}

function buildAssessorPrompt(input: AssessInput): string {
  const digest = input.bundle?.conversationDigest || input.conversationDigest || "";
  const ee = input.bundle?.eeContext || input.eeContext || "";
  const plan = input.bundle?.priorPlan || "";
  return [
    "You are the complexity assessor — the highest-tier router for an autonomous coding agent.",
    "Judge how much rigor this task needs, whether it warrants multi-perspective debate, and enrich an under-specified prompt.",
    "Be decisive: over-tiering wastes time, under-tiering ships unreviewed risk, over-enriching adds noise.",
    "",
    `Fast classifier's first-pass depth: ${input.priorDepth} (confidence ${input.confidence.toFixed(2)}).`,
    digest ? `\nRecent conversation:\n${digest}` : "",
    ee ? `\nPrior experience (EE recall):\n${ee}` : "",
    plan ? `\nPrior plan (this task):\n${plan}` : "",
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
  const hasPriorContext = !!(input.bundle?.conversationDigest || input.conversationDigest || "").trim();
  if (!shouldAssess(input.priorDepth, input.confidence, hasPriorContext)) {
    return {
      depth: input.priorDepth,
      autoCouncil: false,
      rationale: "",
      assessed: false,
      source: "prefilter-skip",
      enrichedPrompt: "",
    };
  }
  if (!input.runAssessor) {
    // No runner (offline/test path without a fixture) — keep priorDepth, do not fabricate.
    return {
      depth: input.priorDepth,
      autoCouncil: false,
      rationale: "",
      assessed: false,
      source: "prefilter-skip",
      enrichedPrompt: "",
    };
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
      enrichedPrompt: "",
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
      enrichedPrompt: "",
    };
  }
  try {
    const leader = await resolvePlanCouncilLeader(input.sessionModelId);
    const path = writeAssessment(input.cwd, verdict, leader.modelId);
    const brief = (verdict.enrichedPrompt ?? "").slice(0, 1500);
    return {
      depth: verdict.depth,
      autoCouncil: verdict.autoCouncil,
      rationale: verdict.rationale,
      assessed: true,
      source: "assessor",
      assessmentPath: path,
      quality: verdict.quality,
      enrichedPrompt: brief,
    };
  } catch (err) {
    console.error(`[gsd] complexity assessor finalize failed, keeping priorDepth: ${(err as Error).message}`);
    return {
      depth: input.priorDepth,
      autoCouncil: false,
      rationale: "",
      assessed: false,
      source: "parse-failed-fallback",
      enrichedPrompt: "",
    };
  }
}
