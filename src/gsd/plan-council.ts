import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolvePlanCouncilLeader } from "../council/leader.js";
import type { ToolResult } from "../types/index.js";
import { buildCouncilContextBundle, type CouncilContextBundle } from "./council-context.js";
import { buildGsdPerspectiveTaskRequest } from "./model-tier.js";
import { planningArtifact } from "./paths.js";
import {
  buildDebateTopic,
  buildPerspectivePrompt,
  type PlanPerspective,
  type PlanPerspectiveId,
  perspectivesForDepth,
} from "./plan-council-prompts.js";
import { extractStructuredVerdict, type PlanCouncilVerdict } from "./verdict-schema.js";
import { advancePhase, setStateField } from "./workflow-engine.js";

export type PerspectiveVerdict = "approve" | "revise" | "block";
export type VerdictSource = "structured" | "heuristic-fallback" | "parse-failed";

export interface PerspectiveResult {
  id: PlanPerspectiveId;
  role: string;
  verdict: PerspectiveVerdict;
  concerns: string[];
  evidence: string[];
  /** Where the verdict came from — model-emitted JSON or heuristic fallback. */
  source: VerdictSource;
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
  /** Where the merged verdict came from. */
  verdictSource?: VerdictSource;
  /** True when no structured verdict could be extracted (debate path). */
  verdictParseFailed?: boolean;
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
  return { id: perspective.id, role: perspective.role, verdict, concerns, evidence, source: "heuristic-fallback" };
}

function fromStructured(perspective: PlanPerspective, parsed: PlanCouncilVerdict, raw?: string): PerspectiveResult {
  return {
    id: perspective.id,
    role: perspective.role,
    verdict: parsed.verdict,
    concerns: parsed.concerns.map(String),
    evidence: parsed.evidence.map(String),
    source: "structured",
    raw,
  };
}

async function runPerspective(
  planBody: string,
  perspective: PlanPerspective,
  runFn: RunPerspectiveFn | undefined,
  bundle?: CouncilContextBundle,
): Promise<PerspectiveResult> {
  // No runner — heuristic path (test scaffolding / offline runs).
  if (!runFn) {
    return heuristicReview(planBody, perspective);
  }
  try {
    const raw = await runFn(buildPerspectivePrompt(perspective, planBody, bundle), perspective);
    const parsed = extractStructuredVerdict(raw);
    if (!parsed) {
      // Tolerant parse failed — DO NOT silently approve. Fall back to heuristic
      // so the perspective still contributes a verdict, and flag the source so
      // telemetry can detect prompt-compliance regressions.
      console.error(
        `[gsd] plan-council perspective ${perspective.id} emitted no structured verdict — using heuristic fallback`,
      );
      const fallback = heuristicReview(planBody, perspective);
      return { ...fallback, source: "heuristic-fallback", raw };
    }
    return fromStructured(perspective, parsed, raw);
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
    return `## ${r.role} (${r.id})\n\n**Verdict:** ${r.verdict} (source: ${r.source})\n\n**Concerns:**\n${concerns}\n\n**Evidence:**\n${evidence}\n`;
  });
  return ["# PLAN-REVIEW", "", `Leader: \`${leaderModelId}\``, `Revision cycle: ${cycle}`, "", ...sections].join("\n");
}

function formatPlanVerify(
  verdict: PerspectiveVerdict | "pass",
  results: PerspectiveResult[],
  opts: { source: VerdictSource; parseFailed: boolean },
): string {
  const allConcerns = results.flatMap((r) => r.concerns);
  return [
    "# PLAN-VERIFY",
    "",
    `verdict: ${verdict}`,
    `revisionRequired: ${verdict === "revise" || verdict === "block" ? "yes" : "no"}`,
    `verdictSource: ${opts.source}`,
    `verdictParseFailed: ${opts.parseFailed ? "yes" : "no"}`,
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

function applyVerdict(cwd: string, verdict: PerspectiveVerdict | "pass"): void {
  if (verdict === "pass") {
    setStateField(cwd, "Plan Verified", "yes");
    advancePhase(cwd, "execute");
  } else {
    setStateField(cwd, "Plan Verified", "no");
    if (verdict === "revise") {
      advancePhase(cwd, "plan");
    }
  }
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
      verdictSource: "heuristic-fallback",
    };
  }

  // ---------- Debate path (production wiring: runCouncilV2 synthesis) ----------
  if (opts.runDebate) {
    const leader = await resolvePlanCouncilLeader(sessionModelId);
    const bundle = buildCouncilContextBundle(cwd, { depth, revisionCycle });
    const topic = buildDebateTopic(planBody, bundle);

    let synthesis = "";
    try {
      synthesis = await opts.runDebate(topic);
    } catch (err) {
      console.error(`[gsd] plan review debate failed: ${(err as Error).message}`);
    }

    const parsed = extractStructuredVerdict(synthesis);
    const parseFailed = parsed === null;
    // Model-first: if we could not extract structured verdict, DO NOT regex
    // the prose. Force a conservative revise so the loop iterates and the
    // leader gets another chance to emit valid JSON (the prior-concerns
    // directive re-states the contract).
    // Map "approve" → "pass" so the merged verdict matches the union the rest
    // of the pipeline expects (applyVerdict keys the gate on `=== "pass"`).
    const rawVerdict = parseFailed ? "revise" : parsed!.verdict;
    const verdict: PerspectiveVerdict | "pass" = rawVerdict === "approve" ? "pass" : rawVerdict;
    const source: VerdictSource = parseFailed ? "parse-failed" : "structured";
    const concerns = parsed?.concerns.map(String) ?? [
      "Council leader did not emit a structured verdict block — forcing revision.",
    ];
    const evidence = parsed?.evidence.map(String) ?? [];
    const rationale = parsed?.rationale ?? "";

    const planReviewPath = planningArtifact(cwd, "PLAN-REVIEW.md");
    const planVerifyPath = planningArtifact(cwd, "PLAN-VERIFY.md");

    const reviewContent = [
      "# PLAN-REVIEW",
      "",
      `Leader: \`${leader.modelId}\``,
      `Revision cycle: ${revisionCycle}`,
      `Verdict source: ${source}${parseFailed ? " (parse failed — forced revise)" : ""}`,
      "",
      "## Council Debate Synthesis",
      "",
      synthesis.trim() || "No synthesis generated.",
      rationale ? `\n**Rationale:** ${rationale}` : "",
      "",
      "## Merged Concerns",
      "",
      concerns.length ? concerns.map((c) => `- ${c}`).join("\n") : "- (none)",
    ].join("\n");

    const verifyContent = [
      "# PLAN-VERIFY",
      "",
      `verdict: ${verdict}`,
      `revisionRequired: ${verdict === "revise" || verdict === "block" ? "yes" : "no"}`,
      `verdictSource: ${source}`,
      `verdictParseFailed: ${parseFailed ? "yes" : "no"}`,
      "",
      "## Summary",
      verdict === "pass"
        ? "Council leader approved via structured verdict."
        : parseFailed
          ? "Structured verdict missing — forced revision so the leader re-emits valid JSON."
          : `Council requested ${verdict}.`,
      "",
      "## Concerns",
      concerns.length ? concerns.map((c) => `- ${c}`).join("\n") : "- (none)",
    ].join("\n");

    writeFileSync(planReviewPath, reviewContent, "utf8");
    writeFileSync(planVerifyPath, verifyContent, "utf8");

    applyVerdict(cwd, verdict);

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
      verdictSource: source,
      verdictParseFailed: parseFailed,
    };
  }

  // ---------- Perspective path (parallel sub-agents) ----------
  const leader = await resolvePlanCouncilLeader(sessionModelId);
  const bundle = buildCouncilContextBundle(cwd, { depth, revisionCycle });

  // Perspectives are independent — run in parallel, preserve declared order.
  const settled = await Promise.all(perspectives.map((p) => runPerspective(planBody, p, runPerspectiveFn, bundle)));
  const results: PerspectiveResult[] = settled;

  const verdict = mergeVerdict(results);
  const anyParseFailed = results.some((r) => r.source === "heuristic-fallback");
  const source: VerdictSource = anyParseFailed ? "heuristic-fallback" : "structured";

  const planReviewPath = planningArtifact(cwd, "PLAN-REVIEW.md");
  const planVerifyPath = planningArtifact(cwd, "PLAN-VERIFY.md");

  writeFileSync(planReviewPath, formatPlanReview(results, leader.modelId, revisionCycle), "utf8");
  writeFileSync(planVerifyPath, formatPlanVerify(verdict, results, { source, parseFailed: false }), "utf8");

  applyVerdict(cwd, verdict);

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
    verdictSource: source,
    verdictParseFailed: false,
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
