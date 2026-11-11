import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensurePlanningWorkspace } from "./config-bridge.js";
import { dispatchInitProgress, dispatchStateJson, dispatchStateUpdate, invalidateFlowCache } from "./flow-dispatch.js";
import { loadStateDocument } from "./flow-runtime.js";
import { latestPhaseDir, planningArtifact } from "./paths.js";
import type { FlowPhase } from "./types.js";

export interface WorkflowState {
  phase: FlowPhase | null;
  depth: string | null;
  planVerified: boolean;
  raw: string;
}

export interface WorkflowProgress {
  milestone_version?: string;
  milestone_name?: string;
  phases?: unknown[];
  phase_count?: number;
  completed_count?: number;
  state_exists?: boolean;
  project_exists?: boolean;
}

export interface WorkflowCompletionScope {
  declaredPlanScope: string | null;
  planReview: ReturnType<typeof readPlanVerifyVerdict>;
  implementationVerification: "missing" | "unstructured" | "recorded_pass" | "recorded_fail";
  wholeTaskCompletion: "unverified";
  evidenceBoundary: string;
}

/** Artifact facts only: planning approval is never implementation evidence. */
export function readCompletionScope(cwd: string): WorkflowCompletionScope {
  const plan = planningArtifact(cwd, "PLAN.md");
  const verify = planningArtifact(cwd, "VERIFY.md");
  const planText = existsSync(plan) ? readFileSync(plan, "utf8") : "";
  const verification = existsSync(verify) ? readFileSync(verify, "utf8") : "";
  const verdicts = [...verification.matchAll(/^verdict:\s*(pass|fail)\s*$/gim)].map((match) => match[1]!.toLowerCase());
  return {
    declaredPlanScope: /^#\s+(.+)$/m.exec(planText)?.[1]?.trim().slice(0, 200) ?? null,
    planReview: readPlanVerifyVerdict(cwd),
    implementationVerification: !existsSync(verify)
      ? "missing"
      : verdicts.includes("fail")
        ? "recorded_fail"
        : verdicts.includes("pass")
          ? "recorded_pass"
          : "unstructured",
    wholeTaskCompletion: "unverified",
    evidenceBoundary:
      "Workflow metadata does not prove whole-goal completion. A plan pass authorizes implementation; a worker/preflight result covers only its assigned scope. Even a recorded VERIFY verdict requires checking acceptance coverage, actual evidence and freshness.",
  };
}

function readStateFile(cwd: string): string {
  const path = planningArtifact(cwd, "STATE.md");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function writeStateFile(cwd: string, content: string): void {
  writeFileSync(planningArtifact(cwd, "STATE.md"), content, "utf8");
}

function mapPhaseField(value: string | null): FlowPhase | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const allowed: FlowPhase[] = ["discuss", "plan", "execute", "verify", "review", "debug"];
  const exact = allowed.find((p) => p === normalized);
  if (exact) return exact;
  // flow-core prose uses "discuss of 0 (task)" — take task-level token before " of ".
  const taskToken = normalized.split(/\s+of\s+/)[0]?.trim();
  return taskToken ? (allowed.find((p) => p === taskToken) ?? null) : null;
}

/** Muonroi task fields live in the extension table; prose Phase: lines are flow milestone position. */
function extractExtensionTableField(raw: string, fieldName: string): string | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = raw.match(new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|\\n]+?)\\s*\\|`, "im"));
  return row?.[1]?.trim() ?? null;
}

function replaceExtensionTableField(raw: string, fieldName: string, value: string): string | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^\\|\\s*${escaped}\\s*\\|\\s*)([^|\\n]*?)(\\s*\\|)`, "im");
  if (!pattern.test(raw)) return null;
  return raw.replace(pattern, `$1${value}$3`);
}

function appendExtensionTableField(raw: string, fieldName: string, value: string): string {
  return `${raw.trimEnd()}\n| ${fieldName} | ${value} |\n`;
}

export type WorkflowKind = "task" | "product";

export function readExtensionField(cwd: string, fieldName: string): string | null {
  const raw = readStateFile(cwd);
  if (!raw) return null;
  return extractExtensionTableField(raw, fieldName);
}

export function readWorkflowKind(cwd: string): WorkflowKind | null {
  const kind = readExtensionField(cwd, "Workflow Kind")?.toLowerCase();
  if (kind === "product") return "product";
  if (kind === "task") return "task";
  return kind ? (kind as WorkflowKind) : "task";
}

export function readVerifyOutcome(cwd: string): "pass" | "fail" | null {
  const path = planningArtifact(cwd, "VERIFY.md");
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  if (/verdict:\s*fail/i.test(content) || /status:\s*fail/i.test(content)) return "fail";
  if (content.trim().length > 0) return "pass";
  return null;
}

export function canShip(cwd: string, depth: string): { allowed: boolean; reason?: string } {
  const state = readState(cwd);
  if (state.phase !== "verify" && state.phase !== "review") {
    return { allowed: false, reason: `phase is "${state.phase ?? "none"}" — call flow_verify before flow_ship` };
  }
  const verify = readVerifyOutcome(cwd);
  if (verify === "fail") {
    return { allowed: false, reason: "VERIFY.md indicates failure" };
  }
  if (depth !== "quick" && readPlanVerifyVerdict(cwd) !== "pass") {
    return { allowed: false, reason: "plan-verify must pass before ship at standard/heavy depth" };
  }
  return { allowed: true };
}

export interface FlowStatusPayload {
  completion: WorkflowCompletionScope;
  review: {
    verdict: "pass" | "revise" | "block" | null;
    reviewId: string | null;
    recordedRevisionCycle: number | null;
    revisionRequired: boolean | null;
    parseFailed: boolean | null;
    verdictSource: string | null;
    concerns: string[];
    concernsTruncated: boolean;
    artifactPath: string;
    nextAction: "execute" | "review_plan" | "revise_plan" | "resolve_blockers" | "advance_to_execute";
  };
  state: WorkflowState;
  progress: WorkflowProgress & { phases_remaining?: number | null };
  gates: {
    canExecute: { allowed: boolean; reason?: string };
    canShip: { allowed: boolean; reason?: string };
    planVerifyVerdict: ReturnType<typeof readPlanVerifyVerdict>;
  };
  artifacts: {
    planExists: boolean;
    planVerifyExists: boolean;
    verifyExists: boolean;
    shipExists: boolean;
    phaseDir: string | null;
  };
}

export function buildFlowStatusPayload(cwd: string, depth: string): FlowStatusPayload {
  const state = readState(cwd);
  const progressRaw = readProgress(cwd);
  const phaseCount = progressRaw.phase_count;
  const completedCount = progressRaw.completed_count;
  const phasesRemaining =
    typeof phaseCount === "number" && typeof completedCount === "number"
      ? Math.max(0, phaseCount - completedCount)
      : null;
  const verdict = readPlanVerifyVerdict(cwd);
  const verifyPath = planningArtifact(cwd, "PLAN-VERIFY.md");
  const verify = existsSync(verifyPath) ? readFileSync(verifyPath, "utf8") : "";
  const reviewPath = planningArtifact(cwd, "PLAN-REVIEW.md");
  const review = existsSync(reviewPath) ? readFileSync(reviewPath, "utf8") : "";
  const cycle = /^Revision cycle:\s*(\d+)\s*$/im.exec(review)?.[1];
  const concernLines = (verify.split(/^## Concerns\s*$/m)[1]?.split(/^## /m)[0] ?? "")
    .split(/\r?\n/)
    .map((line) => /^-\s+(.+)$/.exec(line)?.[1])
    .filter((line): line is string => !!line && line !== "(none)");
  const parseFailed = /^verdictParseFailed:\s*(yes|no)\s*$/im.exec(verify)?.[1]?.toLowerCase();
  return {
    completion: readCompletionScope(cwd),
    review: {
      verdict,
      reviewId:
        /^reviewId:\s*([\w-]+)\s*$/im.exec(verify)?.[1] ??
        /^(?:Review id|reviewId):\s*([\w-]+)\s*$/im.exec(review)?.[1] ??
        null,
      recordedRevisionCycle: cycle && Number.isSafeInteger(Number(cycle)) ? Number(cycle) : null,
      revisionRequired: verdict ? verdict !== "pass" : null,
      parseFailed: parseFailed ? parseFailed === "yes" : null,
      verdictSource: /^verdictSource:\s*(structured|heuristic-fallback|parse-failed)\s*$/im.exec(verify)?.[1] ?? null,
      concerns: concernLines.slice(0, 12).map((line) => line.slice(0, 500)),
      concernsTruncated: concernLines.length > 12 || concernLines.some((line) => line.length > 500),
      artifactPath: verifyPath,
      nextAction:
        depth === "quick"
          ? "execute"
          : verdict === "revise"
            ? "revise_plan"
            : verdict === "block"
              ? "resolve_blockers"
              : verdict !== "pass"
                ? "review_plan"
                : state.phase === "execute"
                  ? "execute"
                  : "advance_to_execute",
    },
    state,
    progress: { ...progressRaw, phases_remaining: phasesRemaining },
    gates: {
      canExecute: canExecute(cwd, depth),
      canShip: canShip(cwd, depth),
      planVerifyVerdict: readPlanVerifyVerdict(cwd),
    },
    artifacts: {
      planExists: existsSync(planningArtifact(cwd, "PLAN.md")),
      planVerifyExists: existsSync(planningArtifact(cwd, "PLAN-VERIFY.md")),
      verifyExists: existsSync(planningArtifact(cwd, "VERIFY.md")),
      shipExists: existsSync(planningArtifact(cwd, "SHIP.md")),
      phaseDir: latestPhaseDir(cwd),
    },
  };
}

export function readState(cwd: string): WorkflowState {
  const raw = readStateFile(cwd);
  if (!raw) {
    return { phase: null, depth: null, planVerified: false, raw: "" };
  }
  const doc = loadStateDocument();
  const phaseRaw = extractExtensionTableField(raw, "Phase") ?? doc.stateExtractField(raw, "Phase");
  const depth = extractExtensionTableField(raw, "Depth") ?? doc.stateExtractField(raw, "Depth");
  const verifiedRaw = extractExtensionTableField(raw, "Plan Verified") ?? doc.stateExtractField(raw, "Plan Verified");
  const phase = mapPhaseField(phaseRaw);
  const planVerified = verifiedRaw?.toLowerCase() === "yes" || verifiedRaw?.toLowerCase() === "pass";
  return { phase, depth, planVerified, raw };
}

export function setStateField(cwd: string, field: string, value: string): WorkflowState {
  // flow-core state-transition for milestone fields only — task Phase/Depth/Plan Verified use extension table.
  const flowCanonical = new Set(["Status", "status", "current_phase", "Current Phase"]);
  if (flowCanonical.has(field) && existsSync(planningArtifact(cwd, "STATE.md"))) {
    const flow = dispatchStateUpdate(cwd, field, value);
    if (flow.ok && (flow.data as { updated?: boolean })?.updated) {
      return readState(cwd);
    }
  }
  const raw = readStateFile(cwd);
  const doc = loadStateDocument();
  const base = raw || "# STATE\n\n| Field | Value |\n| --- | --- |\n";
  const extensionFields = new Set([
    "Phase",
    "Depth",
    "Plan Verified",
    "Workflow Kind",
    "Ideal Run",
    "Milestone Phase Dir",
  ]);
  let next: string | null = null;
  if (extensionFields.has(field)) {
    next = replaceExtensionTableField(base, field, value);
    if (!next) next = appendExtensionTableField(base, field, value);
  } else {
    next = doc.stateReplaceField(base, field, value);
  }
  if (!next) {
    console.error(`[flow] setStateField could not update ${field} in STATE.md`);
    return readState(cwd);
  }
  writeStateFile(cwd, next);
  // STATE.md just changed on disk → drop cached subprocess reads so the next
  // dispatch / readState-with-progress sees the new mtime bucket.
  invalidateFlowCache(cwd);
  return readState(cwd);
}

export function currentPhase(cwd: string): FlowPhase | null {
  return readState(cwd).phase;
}

export function advancePhase(cwd: string, phase: FlowPhase): WorkflowState {
  return setStateField(cwd, "Phase", phase);
}

export function readProgress(cwd: string): WorkflowProgress {
  const result = dispatchInitProgress(cwd);
  if (result.ok && result.data) {
    return result.data as WorkflowProgress;
  }
  const stateJson = dispatchStateJson(cwd);
  return {
    state_exists: existsSync(planningArtifact(cwd, "STATE.md")),
    ...(stateJson.ok && stateJson.data ? { state_frontmatter: stateJson.data } : {}),
  };
}

export function readPlanVerifyVerdict(cwd: string): "pass" | "revise" | "block" | null {
  const path = planningArtifact(cwd, "PLAN-VERIFY.md");
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  const match = content.match(/verdict:\s*(pass|revise|block)/i);
  return match ? (match[1].toLowerCase() as "pass" | "revise" | "block") : null;
}

export function canExecute(cwd: string, depth: string): { allowed: boolean; reason?: string } {
  if (depth === "quick") return { allowed: true };
  const verdict = readPlanVerifyVerdict(cwd);
  if (verdict !== "pass") {
    return {
      allowed: false,
      reason: verdict
        ? `plan-verify verdict is "${verdict}" — call flow_plan_review before flow_execute`
        : "plan-verify pending — call flow_plan_review before flow_execute",
    };
  }
  const state = readState(cwd);
  if (state.phase && state.phase !== "execute" && depth !== "quick") {
    return { allowed: false, reason: `STATE.md phase is "${state.phase}" — advance to execute after plan-verify pass` };
  }
  return { allowed: true };
}

export function syncWorkflowContext(cwd: string, sessionModelId: string, depth: string): WorkflowState {
  ensurePlanningWorkspace(cwd, sessionModelId);
  setStateField(cwd, "Depth", depth);
  return readState(cwd);
}
