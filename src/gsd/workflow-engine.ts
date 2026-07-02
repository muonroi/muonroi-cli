import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensurePlanningWorkspace } from "./config-bridge.js";
import { dispatchInitProgress, dispatchStateJson, dispatchStateUpdate, invalidateGsdCache } from "./gsd-dispatch.js";
import { loadStateDocument } from "./gsd-runtime.js";
import { latestPhaseDir, planningArtifact } from "./paths.js";
import type { GsdPhase } from "./types.js";

export interface WorkflowState {
  phase: GsdPhase | null;
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

function readStateFile(cwd: string): string {
  const path = planningArtifact(cwd, "STATE.md");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function writeStateFile(cwd: string, content: string): void {
  writeFileSync(planningArtifact(cwd, "STATE.md"), content, "utf8");
}

function mapPhaseField(value: string | null): GsdPhase | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const allowed: GsdPhase[] = ["discuss", "plan", "execute", "verify", "review", "debug"];
  const exact = allowed.find((p) => p === normalized);
  if (exact) return exact;
  // gsd-core prose uses "discuss of 0 (task)" — take task-level token before " of ".
  const taskToken = normalized.split(/\s+of\s+/)[0]?.trim();
  return taskToken ? (allowed.find((p) => p === taskToken) ?? null) : null;
}

/** Muonroi task fields live in the extension table; prose Phase: lines are gsd milestone position. */
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
    return { allowed: false, reason: `phase is "${state.phase ?? "none"}" — call gsd_verify before gsd_ship` };
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

export interface GsdStatusPayload {
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

export function buildGsdStatusPayload(cwd: string, depth: string): GsdStatusPayload {
  const state = readState(cwd);
  const progressRaw = readProgress(cwd);
  const phaseCount = progressRaw.phase_count;
  const completedCount = progressRaw.completed_count;
  const phasesRemaining =
    typeof phaseCount === "number" && typeof completedCount === "number"
      ? Math.max(0, phaseCount - completedCount)
      : null;
  return {
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
  // gsd-core state-transition for milestone fields only — task Phase/Depth/Plan Verified use extension table.
  const gsdCanonical = new Set(["Status", "status", "current_phase", "Current Phase"]);
  if (gsdCanonical.has(field) && existsSync(planningArtifact(cwd, "STATE.md"))) {
    const gsd = dispatchStateUpdate(cwd, field, value);
    if (gsd.ok && (gsd.data as { updated?: boolean })?.updated) {
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
    console.error(`[gsd] setStateField could not update ${field} in STATE.md`);
    return readState(cwd);
  }
  writeStateFile(cwd, next);
  // STATE.md just changed on disk → drop cached subprocess reads so the next
  // dispatch / readState-with-progress sees the new mtime bucket.
  invalidateGsdCache(cwd);
  return readState(cwd);
}

export function currentPhase(cwd: string): GsdPhase | null {
  return readState(cwd).phase;
}

export function advancePhase(cwd: string, phase: GsdPhase): WorkflowState {
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
        ? `plan-verify verdict is "${verdict}" — call gsd_plan_review before gsd_execute`
        : "plan-verify pending — call gsd_plan_review before gsd_execute",
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
