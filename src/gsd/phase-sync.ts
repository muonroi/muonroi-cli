import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../utils/slugify.js";
import { logGsdNativeEvent } from "./ee-closure.js";
import {
  dispatchPhaseAdd,
  dispatchPhaseComplete,
  dispatchRoadmapAnalyze,
  dispatchRoadmapPlanProgress,
  type PhaseAddResult,
} from "./gsd-dispatch.js";
import { phaseDirPath, planningArtifact, planningPhasesRoot } from "./paths.js";
import { readWorkflowKind, setStateField } from "./workflow-engine.js";

export interface PhaseSyncStep {
  op: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface PhaseSyncResult {
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  phaseNumber?: string;
  phaseDirName?: string;
  error?: string;
  steps: PhaseSyncStep[];
}

const MILESTONE_PHASE_DIR_FIELD = "Milestone Phase Dir";

export function extractPlanTitle(planBody: string): string {
  const h1 = planBody.match(/^#\s+(.+)$/m);
  if (h1?.[1]?.trim()) return h1[1].trim().slice(0, 120);
  const first = planBody.split("\n").find((l) => l.trim().length > 0);
  return (first?.trim() ?? "Task").slice(0, 120);
}

export function derivePhaseSlug(title: string): string {
  return slugify(title).slice(0, 60) || "task";
}

export function findPhaseDirBySlug(cwd: string, slug: string): string | null {
  if (!existsSync(planningPhasesRoot(cwd))) return null;
  const needle = slug.toLowerCase();
  for (const dir of readdirSync(planningPhasesRoot(cwd))) {
    if (dir.toLowerCase().includes(needle)) return dir;
  }
  return null;
}

export function readMilestonePhaseDir(cwd: string): string | null {
  const statePath = planningArtifact(cwd, "STATE.md");
  if (!existsSync(statePath)) return null;
  try {
    const raw = readFileSync(statePath, "utf8");
    const row = raw.match(/^\|\s*Milestone Phase Dir\s*\|\s*([^|\n]+?)\s*\|/im);
    const val = row?.[1]?.trim();
    return val && val !== "—" && val.length > 0 ? val : null;
  } catch (err) {
    console.error(`[gsd-phase-sync] readMilestonePhaseDir failed: ${(err as Error).message}`);
    return null;
  }
}

function storeMilestonePhaseDir(cwd: string, dirName: string): void {
  setStateField(cwd, MILESTONE_PHASE_DIR_FIELD, dirName);
}

/** Minimal gsd-compatible ROADMAP required before `phase add`. */
export function ensureTaskRoadmap(cwd: string, milestoneTitle: string): void {
  const roadmapPath = planningArtifact(cwd, "ROADMAP.md");
  if (existsSync(roadmapPath)) return;
  const title = milestoneTitle.slice(0, 80) || "Task";
  const stub = [
    `# Roadmap: ${title}`,
    "",
    "## Overview",
    "",
    "Task-level GSD milestone — phases sync from native gsd_* workflow.",
    "",
    "## Phases",
    "",
    `- [ ] **Phase 1: ${title}** - In progress`,
    "",
    "## Phase Details",
    "",
    `### Phase 1: ${title}`,
    "**Goal:** Ship scoped task via gsd-native workflow",
    "**Depends on:** Nothing (first phase)",
    "**Plans**: TBD",
    "",
    "Plans:",
    "- [ ] 01-01: Task plan",
    "",
  ].join("\n");
  writeFileSync(roadmapPath, `${stub}\n`, "utf8");
}

function resolvePhaseDirName(cwd: string, addResult: PhaseAddResult): string | null {
  const padded = addResult.phaseNumber.padStart(2, "0");
  const dirs = readdirSync(planningPhasesRoot(cwd));
  const match = dirs.find((d) => d.startsWith(`${padded}-`) || d.startsWith(`${addResult.phaseNumber}-`));
  return match ?? null;
}

export function copyPlanToPhaseDir(cwd: string, phaseDirName: string, planBody: string): void {
  const dest = phaseDirPath(cwd, phaseDirName, "PLAN.md");
  mkdirSync(join(planningPhasesRoot(cwd), phaseDirName), { recursive: true });
  writeFileSync(dest, planBody.trim(), "utf8");
}

export function writePhaseVerificationPassed(
  cwd: string,
  phaseDirName: string,
  phaseNumber: string,
  evidence?: string,
): string {
  const padded = phaseNumber.padStart(2, "0");
  const fileName = `${padded}-VERIFICATION.md`;
  const path = phaseDirPath(cwd, phaseDirName, fileName);
  const body = [
    "---",
    "status: passed",
    "---",
    "",
    "# Verification",
    "",
    evidence?.trim() || "Verified via gsd_verify (muonroi-cli native host).",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  return path;
}

export function writePhaseSummaryStub(cwd: string, phaseDirName: string, evidence?: string): string {
  const path = phaseDirPath(cwd, phaseDirName, "SUMMARY.md");
  const body = ["# Summary", "", evidence?.trim() || "Task verify passed — see VERIFY.md in .planning/.", ""].join(
    "\n",
  );
  writeFileSync(path, body, "utf8");
  return path;
}

function resolvePhaseNumberForComplete(cwd: string, phaseDirName: string): string {
  const analyze = dispatchRoadmapAnalyze(cwd);
  if (analyze.ok && analyze.data?.current_phase) {
    return String(analyze.data.current_phase).replace(/^0+/, "") || analyze.data.current_phase;
  }
  const token = phaseDirName.match(/^(\d+)/);
  return token ? token[1]!.replace(/^0+/, "") || token[1]! : "1";
}

/** After gsd_plan writes PLAN.md — task workflow only. */
export function syncTaskPhaseOnPlan(
  cwd: string,
  opts: { planTitle: string; planBody: string; sessionId?: string },
): PhaseSyncResult {
  const steps: PhaseSyncStep[] = [];
  if (readWorkflowKind(cwd) === "product") {
    return { ok: true, skipped: true, skipReason: "product", steps };
  }

  const slug = derivePhaseSlug(opts.planTitle);
  let phaseDirName = readMilestonePhaseDir(cwd) ?? findPhaseDirBySlug(cwd, slug);

  if (!phaseDirName) {
    ensureTaskRoadmap(cwd, opts.planTitle);
    const add = dispatchPhaseAdd(cwd, opts.planTitle);
    steps.push({
      op: "phase-add",
      ok: add.ok,
      detail: add.data?.phaseNumber,
      error: add.error,
    });
    if (!add.ok || !add.data) {
      return { ok: false, skipped: false, steps, error: add.error };
    }
    phaseDirName = resolvePhaseDirName(cwd, add.data);
    if (!phaseDirName) {
      return { ok: false, skipped: false, steps, error: "phase add succeeded but phase dir not found" };
    }
    storeMilestonePhaseDir(cwd, phaseDirName);
    logGsdNativeEvent(opts.sessionId ?? "gsd-native", {
      phase: "plan",
      depth: null,
      loopPoint: "phase-sync:plan",
      phaseNumber: add.data.phaseNumber,
    });
  } else {
    steps.push({ op: "phase-add", ok: true, detail: "skipped-existing-dir" });
  }

  try {
    copyPlanToPhaseDir(cwd, phaseDirName, opts.planBody);
    steps.push({ op: "copy-plan", ok: true, detail: phaseDirName });
  } catch (err) {
    steps.push({ op: "copy-plan", ok: false, error: (err as Error).message });
    return { ok: false, skipped: false, phaseDirName, steps };
  }

  return { ok: true, skipped: false, phaseDirName, steps };
}

/** After gsd_verify pass — task workflow only. */
export function syncTaskPhaseOnVerifyPass(
  cwd: string,
  opts?: { evidence?: string; sessionId?: string },
): PhaseSyncResult {
  const steps: PhaseSyncStep[] = [];
  if (readWorkflowKind(cwd) === "product") {
    return { ok: true, skipped: true, skipReason: "product", steps };
  }

  const phaseDirName = readMilestonePhaseDir(cwd) ?? latestPhaseDirName(cwd);
  if (!phaseDirName) {
    steps.push({ op: "phase-complete", ok: false, error: "no milestone phase dir" });
    return { ok: false, skipped: false, steps };
  }

  const phaseNum = resolvePhaseNumberForComplete(cwd, phaseDirName);
  try {
    writePhaseVerificationPassed(cwd, phaseDirName, phaseNum, opts?.evidence);
    writePhaseSummaryStub(cwd, phaseDirName, opts?.evidence);
    steps.push({ op: "write-verification", ok: true });
  } catch (err) {
    steps.push({ op: "write-verification", ok: false, error: (err as Error).message });
    return { ok: false, skipped: false, phaseDirName, steps };
  }

  const complete = dispatchPhaseComplete(cwd, phaseNum);
  steps.push({ op: "phase-complete", ok: complete.ok, error: complete.error });
  if (!complete.ok) {
    return { ok: false, skipped: false, phaseNumber: phaseNum, phaseDirName, steps };
  }

  const progress = dispatchRoadmapPlanProgress(cwd, phaseNum);
  steps.push({ op: "roadmap-progress", ok: progress.ok, detail: progress.raw?.trim(), error: progress.error });

  logGsdNativeEvent(opts?.sessionId ?? "gsd-native", {
    phase: "verify",
    depth: null,
    loopPoint: "phase-sync:verify",
    phaseNumber: phaseNum,
  });

  return {
    ok: progress.ok,
    skipped: false,
    phaseNumber: phaseNum,
    phaseDirName,
    steps,
  };
}

function latestPhaseDirName(cwd: string): string | null {
  if (!existsSync(planningPhasesRoot(cwd))) return null;
  const dirs = readdirSync(planningPhasesRoot(cwd)).sort();
  return dirs.length ? dirs[dirs.length - 1]! : null;
}

/** Copy root VERIFY.md into phase dir when present (best-effort). */
export function mirrorVerifyMdToPhaseDir(cwd: string, phaseDirName: string): void {
  const src = planningArtifact(cwd, "VERIFY.md");
  if (!existsSync(src)) return;
  const dest = phaseDirPath(cwd, phaseDirName, "VERIFY.md");
  try {
    copyFileSync(src, dest);
  } catch (err) {
    console.error(`[gsd-phase-sync] mirror VERIFY.md failed: ${(err as Error).message}`);
  }
}
