import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolvePlanCouncilLeader } from "../council/leader.js";
import type { ToolResult } from "../types/index.js";
import { buildCouncilContextBundle, type CouncilContextBundle } from "./council-context.js";
import { getPlanReviewDebateRetries } from "./flags.js";
import { buildFlowPerspectiveTaskRequest } from "./model-tier.js";
import { planningArtifact } from "./paths.js";
import {
  buildDebateTopic,
  buildPerspectivePrompt,
  type PlanPerspective,
  type PlanPerspectiveId,
  perspectivesForDepth,
} from "./plan-council-prompts.js";
import { currentPlanDigest, recordReviewRound } from "./plan-review-convergence.js";
import {
  FINDING_LEDGER,
  type MainReviewAssessment,
  readFindingLedger,
  reconcileFindings,
  verdictFindings,
} from "./review-findings.js";
import { extractStructuredVerdict, type PlanCouncilVerdict, VERDICT_OUTPUT_CONTRACT } from "./verdict-schema.js";
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
  reviewId?: string;
  concerns?: string[];
  skipped: boolean;
  perspectives: PerspectiveResult[];
  planReviewPath?: string;
  planVerifyPath?: string;
  verdict: PerspectiveVerdict | "pass";
  leaderModelId?: string;
  revisionRequired: boolean;
  /** Chars of FLOW context fed to council (telemetry — surfaces grounding quality). */
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
  mainAssessment?: MainReviewAssessment;
  beforePersist?: () => void | Promise<void>;
  reviewId?: string;
  cwd: string;
  sessionModelId: string;
  depth: string;
  /** Optional LLM runner for perspective sub-agents (tests use heuristic when omitted). */
  runPerspectiveFn?: RunPerspectiveFn;
  revisionCycle?: number;
  runDebate?: (topic: string, synthesisOutputContract?: string) => Promise<string>;
  abortSignal?: AbortSignal;
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
        `[flow] plan-council perspective ${perspective.id} emitted no structured verdict — using heuristic fallback`,
      );
      const fallback = heuristicReview(planBody, perspective);
      return { ...fallback, source: "heuristic-fallback", raw };
    }
    return fromStructured(perspective, parsed, raw);
  } catch (err) {
    console.error(`[flow] plan-council perspective ${perspective.id} failed: ${(err as Error).message}`);
    return heuristicReview(planBody, perspective);
  }
}

function mergeVerdict(results: PerspectiveResult[]): PerspectiveVerdict | "pass" {
  if (results.some((r) => r.verdict === "block")) return "block";
  if (results.some((r) => r.verdict === "revise")) return "revise";
  return "pass";
}

function formatPlanReview(
  results: PerspectiveResult[],
  leaderModelId: string,
  cycle: number,
  reviewId: string,
): string {
  const sections = results.map((r) => {
    const concerns = r.concerns.length ? r.concerns.map((c) => `- ${c}`).join("\n") : "- (none)";
    const evidence = r.evidence.length ? r.evidence.map((e) => `- ${e}`).join("\n") : "- (none)";
    return `## ${r.role} (${r.id})\n\n**Verdict:** ${r.verdict} (source: ${r.source})\n\n**Concerns:**\n${concerns}\n\n**Evidence:**\n${evidence}\n`;
  });
  return [
    "# PLAN-REVIEW",
    "",
    `Leader: \`${leaderModelId}\``,
    `Revision cycle: ${cycle}`,
    `reviewId: ${reviewId}`,
    "",
    ...sections,
  ].join("\n");
}

function formatPlanVerify(
  verdict: PerspectiveVerdict | "pass",
  results: PerspectiveResult[],
  opts: { source: VerdictSource; parseFailed: boolean; reviewId: string },
): string {
  const allConcerns = results.flatMap((r) => r.concerns);
  return [
    "# PLAN-VERIFY",
    `reviewId: ${opts.reviewId}`,
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

function claimId(claim: string): string {
  return createHash("sha256").update(claim.trim()).digest("hex").slice(0, 12);
}

/** Bookkeeping only — a failure to record history must never fail the review itself. */
function recordConvergenceRound(
  cwd: string,
  reviewId: string,
  verdict: PerspectiveVerdict | "pass",
  openBlocking: Array<{ id: string; claim: string }>,
): void {
  try {
    recordReviewRound(cwd, {
      reviewId,
      planDigest: currentPlanDigest(cwd),
      verdict: verdict === "approve" ? "pass" : verdict,
      openBlocking,
    });
  } catch (err) {
    console.error(`[flow] plan-review round ${reviewId} not recorded for convergence: ${(err as Error).message}`);
  }
}

export async function runPlanCouncil(opts: PlanCouncilOpts): Promise<PlanCouncilResult> {
  opts.abortSignal?.throwIfAborted();
  const { cwd, sessionModelId, depth, runPerspectiveFn, revisionCycle = 0 } = opts;
  const reviewId = opts.reviewId ?? randomUUID();
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

    // The council debate returns an EMPTY synthesis on any of its fail-open
    // paths (provider unreachable, sub-phase catch, user/watchdog abort) — a
    // silent null we must NOT collapse into a permanent forced-`revise`. Retry
    // the debate on empty (covers transient aborts), then fall back to the
    // perspective path so an autonomous /ideal run never bricks with 0 code.
    const maxRetries = getPlanReviewDebateRetries();
    let synthesis = "";
    let lastDebateError: string | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      opts.abortSignal?.throwIfAborted();
      try {
        synthesis = (await opts.runDebate(topic, VERDICT_OUTPUT_CONTRACT)) ?? "";
      } catch (err) {
        lastDebateError = (err as Error).message;
        console.error(`[flow] plan-review debate threw (attempt ${attempt + 1}/${maxRetries + 1}): ${lastDebateError}`);
        opts.abortSignal?.throwIfAborted();
        synthesis = "";
      }
      opts.abortSignal?.throwIfAborted();
      if (synthesis.trim()) break;
      if (attempt < maxRetries) {
        console.error(
          `[flow] plan-review debate returned empty synthesis ` +
            `(attempt ${attempt + 1}/${maxRetries + 1}) — provider unreachable / aborted / ` +
            `sub-phase fail-open; retrying`,
        );
      }
    }

    // Persistent empty synthesis after retries — this is a DEBATE FAILURE, not
    // a plan defect. Do NOT write a misleading "leader did not emit a verdict"
    // forced-revise (which would brick the run). Log the real reason
    // (No-Silent-Catch) and fall through to the perspective path below, which
    // produces a genuine verdict from parallel sub-agent reviewers (heuristic
    // last resort) so the loop can proceed.
    if (!synthesis.trim()) {
      console.error(
        `[flow] plan-review debate produced no synthesis after ${maxRetries + 1} attempt(s)` +
          `${lastDebateError ? ` (last error: ${lastDebateError})` : ""} — ` +
          `falling back to perspective review`,
      );
    } else {
      const parsed = extractStructuredVerdict(synthesis);
      const parseFailed = parsed === null;
      // Model-first: if we could not extract structured verdict, DO NOT regex
      // the prose. Force a conservative revise so the loop iterates and the
      // leader gets another chance to emit valid JSON (the prior-concerns
      // directive re-states the contract).
      // Map "approve" → "pass" so the merged verdict matches the union the rest
      // of the pipeline expects (applyVerdict keys the gate on `=== "pass"`).
      const rawVerdict = parseFailed ? "revise" : parsed!.verdict;
      let verdict: PerspectiveVerdict | "pass" = rawVerdict === "approve" ? "pass" : rawVerdict;
      const source: VerdictSource = parseFailed ? "parse-failed" : "structured";
      let concerns = parsed?.concerns.map(String) ?? [
        "Council leader did not emit a structured verdict block — forcing revision.",
      ];
      const rationale = parsed?.rationale ?? "";
      const raised = parsed ? verdictFindings(parsed) : [];
      const ledger = parsed
        ? reconcileFindings(readFindingLedger(cwd), raised, reviewId, opts.mainAssessment)
        : undefined;
      if (ledger) {
        const openBlockers = ledger.entries.filter((e) => e.state === "open" && e.finding.severity === "blocking");
        concerns = ledger.entries.filter((e) => e.state === "open").map((e) => `[${e.finding.id}] ${e.finding.claim}`);
        if (opts.mainAssessment) verdict = openBlockers.length ? (rawVerdict === "block" ? "block" : "revise") : "pass";
        else if (openBlockers.length && verdict === "pass") verdict = "revise";
      }

      const planReviewPath = planningArtifact(cwd, "PLAN-REVIEW.md");
      const planVerifyPath = planningArtifact(cwd, "PLAN-VERIFY.md");

      const reviewContent = [
        "# PLAN-REVIEW",
        "",
        `Leader: \`${leader.modelId}\``,
        `Revision cycle: ${revisionCycle}`,
        `reviewId: ${reviewId}`,
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
        ...(opts.mainAssessment
          ? [
              "",
              "## Main evidence adjudication",
              "",
              JSON.stringify(opts.mainAssessment, null, 2),
              "Council verdict is advice. Gate admission below follows main's per-finding decisions; proposed checks are not executed evidence.",
            ]
          : []),
      ].join("\n");

      const verifyContent = [
        "# PLAN-VERIFY",
        `reviewId: ${reviewId}`,
        "",
        `verdict: ${verdict}`,
        `revisionRequired: ${verdict === "revise" || verdict === "block" ? "yes" : "no"}`,
        `verdictSource: ${source}`,
        `verdictParseFailed: ${parseFailed ? "yes" : "no"}`,
        `verdictOwner: ${opts.mainAssessment ? "main" : "council"}`,
        ...(opts.mainAssessment?.revalidation
          ? [
              "admissionMethod: independent-plan-revalidation",
              `sourceCouncilJobId: ${opts.mainAssessment.revalidation.sourceJobId}`,
              `sourceCouncilResultVersion: ${opts.mainAssessment.revalidation.sourceResultVersion}`,
              `verificationJobId: ${opts.mainAssessment.revalidation.jobId}`,
              `verificationResultVersion: ${opts.mainAssessment.revalidation.resultVersion}`,
              `currentInputsDigest: ${opts.mainAssessment.revalidation.inputsDigest}`,
            ]
          : []),
        "",
        "## Summary",
        verdict === "pass"
          ? opts.mainAssessment
            ? "Main adjudicated the bound council dossier; no open blocking finding remains."
            : "Council leader approved via structured verdict."
          : parseFailed
            ? "Structured verdict missing — forced revision so the leader re-emits valid JSON."
            : opts.mainAssessment
              ? "Main retained open blocking findings after independent evidence adjudication."
              : `Council requested ${verdict}.`,
        "",
        "## Concerns",
        concerns.length ? concerns.map((c) => `- ${c}`).join("\n") : "- (none)",
      ].join("\n");

      opts.abortSignal?.throwIfAborted();
      await opts.beforePersist?.();
      // Keep immutable decision snapshots; only the current ledger is replaced.
      // The native completion guard above hashes the prior ledger as an input.
      if (ledger) {
        if (!/^[a-zA-Z0-9_-]+$/.test(reviewId)) throw new Error("Invalid review archive id.");
        const archive = planningArtifact(cwd, `reviews/${reviewId}`);
        mkdirSync(archive, { recursive: true });
        writeFileSync(`${archive}/leader.md`, synthesis, { encoding: "utf8", flag: "wx" });
        writeFileSync(`${archive}/findings.json`, JSON.stringify(ledger, null, 2), { encoding: "utf8", flag: "wx" });
        if (opts.mainAssessment)
          writeFileSync(`${archive}/main-assessment.json`, JSON.stringify(opts.mainAssessment, null, 2), {
            encoding: "utf8",
            flag: "wx",
          });
        writeFileSync(planningArtifact(cwd, FINDING_LEDGER), JSON.stringify(ledger, null, 2), "utf8");
      }
      writeFileSync(planReviewPath, reviewContent, "utf8");
      writeFileSync(planVerifyPath, verifyContent, "utf8");
      // Convergence history: only a structured, recorded review is a round. A
      // parse failure is a reviewer defect, not an objection, and must not look
      // like a repeated blocker. A round lists the blockers THIS reviewer raised
      // (or kept) open — the ledger also carries older unadjudicated findings
      // forward, and those must not read as "re-raised every round".
      if (ledger) {
        const raisedOpen = new Set(raised.filter((f) => f.status === "open").map((f) => f.id));
        recordConvergenceRound(
          cwd,
          reviewId,
          verdict,
          ledger.entries
            .filter((e) => e.state === "open" && e.finding.severity === "blocking" && raisedOpen.has(e.finding.id))
            .map((e) => ({ id: e.finding.id, claim: e.finding.claim })),
        );
      }

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
        reviewId,
        concerns,
      };
    }
  }

  // ---------- Perspective path (parallel sub-agents) ----------
  const leader = await resolvePlanCouncilLeader(sessionModelId);
  const bundle = buildCouncilContextBundle(cwd, { depth, revisionCycle });

  // Perspectives are independent — run in parallel, preserve declared order.
  const settled = await Promise.all(perspectives.map((p) => runPerspective(planBody, p, runPerspectiveFn, bundle)));
  opts.abortSignal?.throwIfAborted();
  const results: PerspectiveResult[] = settled;

  const verdict = mergeVerdict(results);
  const anyParseFailed = results.some((r) => r.source === "heuristic-fallback");
  const source: VerdictSource = anyParseFailed ? "heuristic-fallback" : "structured";

  const planReviewPath = planningArtifact(cwd, "PLAN-REVIEW.md");
  const planVerifyPath = planningArtifact(cwd, "PLAN-VERIFY.md");

  await opts.beforePersist?.();
  writeFileSync(planReviewPath, formatPlanReview(results, leader.modelId, revisionCycle, reviewId), "utf8");
  writeFileSync(planVerifyPath, formatPlanVerify(verdict, results, { source, parseFailed: false, reviewId }), "utf8");
  recordConvergenceRound(
    cwd,
    reviewId,
    verdict,
    results
      .filter((r) => r.verdict !== "approve")
      .flatMap((r) => r.concerns.map((claim) => ({ id: `${r.id}-${claimId(claim)}`, claim }))),
  );

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
    reviewId,
    concerns: results.flatMap((result) => result.concerns),
  };
}

/** Adapter: wrap orchestrator runTask as perspective runner. */
export function taskToPerspectiveRunner(
  runTask: (request: import("../types/index.js").TaskRequest) => Promise<ToolResult>,
  sessionModelId: string,
): RunPerspectiveFn {
  return async (prompt, perspective) => {
    const result = await runTask(buildFlowPerspectiveTaskRequest(prompt, perspective, sessionModelId));
    return result.output ?? "";
  };
}
