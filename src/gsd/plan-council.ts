import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolvePlanCouncilLeader } from "../council/leader.js";
import type { ToolResult } from "../types/index.js";
import { buildCouncilContextBundle, renderCouncilContextBlock } from "./council-context.js";
import { buildGsdPerspectiveTaskRequest } from "./model-tier.js";
import { planningArtifact } from "./paths.js";
import {
  buildPerspectivePrompt,
  type PlanPerspective,
  type PlanPerspectiveId,
  perspectivesForDepth,
} from "./plan-council-prompts.js";
import { advancePhase, setStateField } from "./workflow-engine.js";

export type PerspectiveVerdict = "approve" | "revise" | "block";

export interface PerspectiveResult {
  id: PlanPerspectiveId;
  role: string;
  verdict: PerspectiveVerdict;
  concerns: string[];
  evidence: string[];
  raw?: string;
}

export interface PlanCouncilResult {
  skipped: boolean;
  perspectives: PerspectiveResult[];
  planReviewPath?: string;
  planVerifyPath?: string;
  verdict: PerspectiveVerdict | "pass";
  leaderModelId?: string;
  revisionRequired: boolean;
  /** Chars of GSD context fed to council (telemetry — surfaces grounding quality). */
  contextBundleChars?: number;
  /** True when prior PLAN-REVIEW concerns were surfaced to council. */
  hadPriorConcerns?: boolean;
}

export type RunPerspectiveFn = (prompt: string, perspective: PlanPerspective) => Promise<string>;

export interface PlanCouncilOpts {
  cwd: string;
  sessionModelId: string;
  depth: string;
  /** Optional LLM runner for perspective sub-agents (tests use heuristic when omitted). */
  runPerspectiveFn?: RunPerspectiveFn;
  revisionCycle?: number;
  runDebate?: (topic: string) => Promise<string>;
}

function readPlanBody(cwd: string): string {
  const path = planningArtifact(cwd, "PLAN.md");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function heuristicReview(planBody: string, perspective: PlanPerspective): PerspectiveResult {
  const concerns: string[] = [];
  const evidence: string[] = [];
  const lower = planBody.toLowerCase();
  const hasStructure = /\d+\.|step|acceptance|criteria|verify/i.test(planBody);

  if (planBody.trim().length < 80 && !hasStructure) {
    concerns.push("Plan is too short — lacks concrete steps.");
  }
  if (!hasStructure) {
    concerns.push("Missing numbered steps or acceptance criteria.");
  }
  if (perspective.id === "security" && /rm\s+-rf|chmod\s+777|eval\(/i.test(planBody)) {
    concerns.push("Plan mentions dangerous shell patterns.");
    evidence.push("security: dangerous command pattern detected in plan text");
  }
  if (perspective.id === "research" && !/file:|src\/|\.ts|\.tsx/i.test(planBody)) {
    concerns.push("No codebase file references — plan may be ungrounded.");
  }
  if (perspective.id === "skeptic" && /rewrite|refactor entire|migrate all/i.test(lower)) {
    concerns.push("Scope may be larger than necessary (YAGNI risk).");
  }

  const verdict: PerspectiveVerdict = concerns.length >= 3 ? "block" : concerns.length >= 1 ? "revise" : "approve";
  return { id: perspective.id, role: perspective.role, verdict, concerns, evidence };
}

async function runPerspective(
  planBody: string,
  perspective: PlanPerspective,
  runFn: RunPerspectiveFn | undefined,
  bundle?: import("./council-context.js").CouncilContextBundle,
): Promise<PerspectiveResult> {
  if (!runFn) {
    return heuristicReview(planBody, perspective);
  }
  try {
    const raw = await runFn(buildPerspectivePrompt(perspective, planBody, bundle), perspective);
    const parsed = JSON.parse(raw) as {
      verdict?: string;
      concerns?: string[];
      evidence?: string[];
    };
    const verdict = (
      ["approve", "revise", "block"].includes(parsed.verdict ?? "") ? parsed.verdict : "revise"
    ) as PerspectiveVerdict;
    return {
      id: perspective.id,
      role: perspective.role,
      verdict,
      concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
      raw,
    };
  } catch (err) {
    console.error(`[gsd] plan-council perspective ${perspective.id} failed: ${(err as Error).message}`);
    return heuristicReview(planBody, perspective);
  }
}

function mergeVerdict(results: PerspectiveResult[]): PerspectiveVerdict | "pass" {
  if (results.some((r) => r.verdict === "block")) return "block";
  if (results.some((r) => r.verdict === "revise")) return "revise";
  return "pass";
}

function formatPlanReview(results: PerspectiveResult[], leaderModelId: string, cycle: number): string {
  const sections = results.map((r) => {
    const concerns = r.concerns.length ? r.concerns.map((c) => `- ${c}`).join("\n") : "- (none)";
    const evidence = r.evidence.length ? r.evidence.map((e) => `- ${e}`).join("\n") : "- (none)";
    return `## ${r.role} (${r.id})\n\n**Verdict:** ${r.verdict}\n\n**Concerns:**\n${concerns}\n\n**Evidence:**\n${evidence}\n`;
  });
  return ["# PLAN-REVIEW", "", `Leader: \`${leaderModelId}\``, `Revision cycle: ${cycle}`, "", ...sections].join("\n");
}

function formatPlanVerify(verdict: PerspectiveVerdict | "pass", results: PerspectiveResult[]): string {
  const allConcerns = results.flatMap((r) => r.concerns);
  return [
    "# PLAN-VERIFY",
    "",
    `verdict: ${verdict}`,
    `revisionRequired: ${verdict === "revise" ? "yes" : "no"}`,
    "",
    "## Summary",
    verdict === "pass"
      ? "All perspectives approved — execute gate unlocked."
      : `Council raised ${allConcerns.length} concern(s) — ${verdict === "block" ? "blocked" : "revision required"}.`,
    "",
    "## Concerns",
    allConcerns.length ? allConcerns.map((c) => `- ${c}`).join("\n") : "- (none)",
  ].join("\n");
}

export async function runPlanCouncil(opts: PlanCouncilOpts): Promise<PlanCouncilResult> {
  const { cwd, sessionModelId, depth, runPerspectiveFn, revisionCycle = 0 } = opts;
  const perspectives = perspectivesForDepth(depth);

  if (perspectives.length === 0) {
    return { skipped: true, perspectives: [], verdict: "pass", revisionRequired: false };
  }

  const planBody = readPlanBody(cwd);
  if (!planBody.trim()) {
    return {
      skipped: false,
      perspectives: [],
      verdict: "block",
      revisionRequired: true,
    };
  }

  if (opts.runDebate) {
    const leader = await resolvePlanCouncilLeader(sessionModelId);
    const bundle = buildCouncilContextBundle(cwd, { depth, revisionCycle });

    const topicLines = [
      "Review and debate the proposed plan to determine if it is complete, correct, safe, and optimal for the task.",
      "",
      renderCouncilContextBlock(bundle),
      "",
      "### Proposed PLAN.md:",
      planBody.trim(),
    ];

    const topic = topicLines.join("\n");
    let synthesis = "";
    try {
      synthesis = await opts.runDebate(topic);
    } catch (err) {
      console.error(`[gsd] plan review debate failed: ${(err as Error).message}`);
    }

    let verdict: PerspectiveVerdict | "pass" = "pass";
    if (/revision\s+required|should\s+revise|must\s+revise/i.test(synthesis)) {
      verdict = "revise";
    } else if (/block/i.test(synthesis)) {
      verdict = "block";
    }

    const planReviewPath = planningArtifact(cwd, "PLAN-REVIEW.md");
    const planVerifyPath = planningArtifact(cwd, "PLAN-VERIFY.md");

    const reviewContent = [
      "# PLAN-REVIEW",
      "",
      `Leader: \`${leader.modelId}\``,
      `Revision cycle: ${revisionCycle}`,
      "",
      "## Council Debate Synthesis",
      "",
      synthesis || "No synthesis generated.",
    ].join("\n");

    const verifyContent = [
      "# PLAN-VERIFY",
      "",
      `verdict: ${verdict}`,
      `revisionRequired: ${verdict === "revise" ? "yes" : "no"}`,
      "",
      "## Summary",
      verdict === "pass"
        ? "All perspectives approved via native council debate."
        : `Council requested revision/block: ${verdict}.`,
    ].join("\n");

    writeFileSync(planReviewPath, reviewContent, "utf8");
    writeFileSync(planVerifyPath, verifyContent, "utf8");

    if (verdict === "pass") {
      setStateField(cwd, "Plan Verified", "yes");
      advancePhase(cwd, "execute");
    } else {
      setStateField(cwd, "Plan Verified", "no");
      if (verdict === "revise") {
        advancePhase(cwd, "plan");
      }
    }

    return {
      skipped: false,
      perspectives: [],
      planReviewPath,
      planVerifyPath,
      verdict,
      leaderModelId: leader.modelId,
      revisionRequired: verdict === "revise" || verdict === "block",
      contextBundleChars: bundle.totalChars,
      hadPriorConcerns: bundle.hadPriorConcerns,
    };
  }

  const leader = await resolvePlanCouncilLeader(sessionModelId);
  const bundle = buildCouncilContextBundle(cwd, { depth, revisionCycle });
  const results: PerspectiveResult[] = [];
  for (const p of perspectives) {
    results.push(await runPerspective(planBody, p, runPerspectiveFn, bundle));
  }

  const verdict = mergeVerdict(results);
  const planReviewPath = planningArtifact(cwd, "PLAN-REVIEW.md");
  const planVerifyPath = planningArtifact(cwd, "PLAN-VERIFY.md");

  writeFileSync(planReviewPath, formatPlanReview(results, leader.modelId, revisionCycle), "utf8");
  writeFileSync(planVerifyPath, formatPlanVerify(verdict, results), "utf8");

  if (verdict === "pass") {
    setStateField(cwd, "Plan Verified", "yes");
    advancePhase(cwd, "execute");
  } else {
    setStateField(cwd, "Plan Verified", "no");
    if (verdict === "revise") {
      advancePhase(cwd, "plan");
    }
  }

  return {
    skipped: false,
    perspectives: results,
    planReviewPath,
    planVerifyPath,
    verdict,
    leaderModelId: leader.modelId,
    revisionRequired: verdict === "revise" || verdict === "block",
    contextBundleChars: bundle.totalChars,
    hadPriorConcerns: bundle.hadPriorConcerns,
  };
}

/** Adapter: wrap orchestrator runTask as perspective runner. */
export function taskToPerspectiveRunner(
  runTask: (request: import("../types/index.js").TaskRequest) => Promise<ToolResult>,
  sessionModelId: string,
): RunPerspectiveFn {
  return async (prompt, perspective) => {
    const result = await runTask(buildGsdPerspectiveTaskRequest(prompt, perspective, sessionModelId));
    return result.output ?? "";
  };
}
