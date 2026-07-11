/**
 * native-roadmap.ts — Native replacements for the ROADMAP-oriented gsd-tools
 * subcommands: `roadmap analyze` (read-only), `phase add` (create dir + append),
 * and — Part B step 2 — the two mutating commands `roadmap update-plan-progress`
 * and `phase complete`.
 *
 * The mutating commands rewrite ROADMAP.md (checkbox/table/plan-count) and, for
 * phase-complete, STATE.md. muonroi's only callers (phase-sync, task workflow)
 * read just `ok` + a cosmetic `raw` line — they do NOT consume the rich JSON —
 * so native parity is about performing the FILE mutations correctly, verified
 * against the subprocess oracle in the native-roadmap contract tests.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config-loader.js";
import { planningArtifact, planningPhasesRoot } from "./paths.js";
import { normalizeStateStatus, stateReplaceField } from "./state-document.js";

export interface RoadmapAnalyzePhase {
  number: string;
  name: string;
  depends_on: string | null;
  disk_status: string;
}

export interface RoadmapAnalyzeData {
  error?: string;
  milestones: Array<{ heading: string; version?: string }>;
  phases: RoadmapAnalyzePhase[];
  phase_count: number;
  current_phase: string | null;
  next_phase: string | null;
}

const PHASE_HEADING_RE = /#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+(\d+[A-Za-z]?(?:[.-]\d+)*)\s*:\s*([^\n]+)/gi;

function isSentinel(num: string): boolean {
  return num === "0" || num.startsWith("999");
}

/** Slugify per gsd-core core-utils: lowercase, non-alnum→'-', trim, cap 60. */
export function phaseSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

/** Disk status for a phase dir given plan/summary/context/research presence. */
function diskStatusFor(cwd: string, number: string): string {
  const root = planningPhasesRoot(cwd);
  if (!existsSync(root)) return "no_directory";
  let dir: string | undefined;
  try {
    dir = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .find(
        (name) => new RegExp(`(^|[^0-9])0*${number}-`).test(name) || name.startsWith(`${number.padStart(2, "0")}-`),
      );
  } catch {
    return "no_directory";
  }
  if (!dir) return "no_directory";
  let plans = 0;
  let summaries = 0;
  let hasResearch = false;
  try {
    for (const f of readdirSync(join(root, dir))) {
      if (/PLAN.*\.md$/i.test(f)) plans += 1;
      if (/SUMMARY.*\.md$/i.test(f)) summaries += 1;
      if (/RESEARCH.*\.md$/i.test(f)) hasResearch = true;
    }
  } catch {
    return "empty";
  }
  if (plans > 0 && summaries >= plans) return "complete";
  if (summaries > 0) return "partial";
  if (plans > 0) return "planned";
  if (hasResearch) return "researched";
  return "empty";
}

/**
 * Native `roadmap analyze` — parse ROADMAP.md phase headings (current milestone)
 * + per-phase Depends-on + disk status. Read-only. Returns {error} when
 * ROADMAP.md is absent (mirrors subprocess, exit 0).
 */
export function nativeRoadmapAnalyze(cwd: string): RoadmapAnalyzeData {
  const roadmapPath = planningArtifact(cwd, "ROADMAP.md");
  if (!existsSync(roadmapPath)) {
    return {
      error: "ROADMAP.md not found",
      milestones: [],
      phases: [],
      phase_count: 0,
      current_phase: null,
      next_phase: null,
    };
  }
  const text = readFileSync(roadmapPath, "utf8");

  const milestones: Array<{ heading: string; version?: string }> = [];
  const msRe = /##\s*(.*v(\d+(?:\.\d+)+)[^(\n]*)/gi;
  for (let m = msRe.exec(text); m; m = msRe.exec(text)) {
    milestones.push({ heading: m[1].trim(), version: m[2] });
  }

  const checkboxDone = new Set<string>();
  const cbRe = /-\s*\[([ xX])\]\s*\*\*Phase\s+(\d+[A-Za-z]?(?:[.-]\d+)*)/gi;
  for (let m = cbRe.exec(text); m; m = cbRe.exec(text)) {
    if (m[1].toLowerCase() === "x") checkboxDone.add(m[2]);
  }

  const phases: RoadmapAnalyzePhase[] = [];
  const seen = new Set<string>();
  PHASE_HEADING_RE.lastIndex = 0;
  const matches = [...text.matchAll(PHASE_HEADING_RE)];
  for (let i = 0; i < matches.length; i++) {
    const number = matches[i][1];
    if (isSentinel(number) || seen.has(number)) continue;
    seen.add(number);
    const name = matches[i][2].trim();
    // Depends-on: scan the section body between this heading and the next.
    const sectionStart = matches[i].index ?? 0;
    const sectionEnd = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const section = text.slice(sectionStart, sectionEnd);
    const depMatch = section.match(/\*\*Depends on:\*\*\s*([^\n]+)/i);
    const depends_on = depMatch ? depMatch[1].trim() : null;
    const diskStatus = checkboxDone.has(number) ? "complete" : diskStatusFor(cwd, number);
    phases.push({ number, name, depends_on, disk_status: diskStatus });
  }

  // "current" = the first phase that is STARTED but not complete (matches the
  // subprocess: a phase with no directory is "not started" → null, not current).
  const inProgress = new Set(["partial", "planned", "researched", "discussed"]);
  const current = phases.find((p) => inProgress.has(p.disk_status)) ?? null;
  const currentIdx = current ? phases.indexOf(current) : -1;
  // next = the first not-complete phase after the last complete one.
  const firstIncomplete = phases.find((p) => p.disk_status !== "complete") ?? null;
  const next = current ? (currentIdx + 1 < phases.length ? phases[currentIdx + 1] : null) : firstIncomplete;

  return {
    milestones,
    phases,
    phase_count: phases.length,
    current_phase: current?.number ?? null,
    next_phase: next?.number ?? null,
  };
}

export interface PhaseAddData {
  phase_number: number;
  padded: string;
  name: string;
  slug: string;
  directory: string;
  naming_mode: string;
}

/** Highest phase number used across headings + roadmap bullets + phase dirs. */
function maxUsedPhaseNumber(cwd: string, roadmapText: string): number {
  let max = 0;
  const collect = (n: string) => {
    const v = Number.parseInt(n, 10);
    if (Number.isFinite(v) && v !== 999 && v > max) max = v;
  };
  for (const m of roadmapText.matchAll(/#{2,4}\s*Phase\s+(\d+)[A-Za-z]?(?:\.\d+)*:/gi)) collect(m[1]);
  for (const m of roadmapText.matchAll(/^[ \t]*-[ \t]*\[[^\]]*\][ \t]*\*{0,2}Phase[ \t]+(\d+)(?=[:.\s*]|$)/gim))
    collect(m[1]);
  const root = planningPhasesRoot(cwd);
  if (existsSync(root)) {
    try {
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dm = e.name.match(/^(?:[A-Z][A-Z0-9]*-)?(\d+)-/);
        if (dm) collect(dm[1]);
      }
    } catch {
      /* ignore unreadable phases dir */
    }
  }
  return max;
}

/**
 * Native `phase add <description>` — sequential naming mode only (custom `--id`
 * mode is not used by muonroi's callers). Creates `.planning/phases/<NN>-<slug>/`
 * + `.gitkeep`, and appends a phase block to ROADMAP.md before the trailing
 * `---` separator. Returns {error} when ROADMAP.md is absent (matching the
 * subprocess exit-1 contract via ok:false at the dispatch layer).
 */
export function nativePhaseAdd(cwd: string, description: string): PhaseAddData | { error: string } {
  const desc = description.trim();
  if (!desc) return { error: "phase add requires a description" };
  const roadmapPath = planningArtifact(cwd, "ROADMAP.md");
  if (!existsSync(roadmapPath)) return { error: "ROADMAP.md not found" };

  const config = loadConfig(cwd);
  const projectCode = typeof config.project_code === "string" && config.project_code ? `${config.project_code}-` : "";
  const roadmapText = readFileSync(roadmapPath, "utf8");
  const id = maxUsedPhaseNumber(cwd, roadmapText) + 1;
  const padded = String(id).padStart(2, "0");
  const slug = phaseSlug(desc);
  const directory = `${projectCode}${padded}-${slug}`;

  // Create phase dir + .gitkeep.
  const phaseDir = join(planningPhasesRoot(cwd), directory);
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, ".gitkeep"), "", "utf8");

  // Append the phase block before the last `---` separator (or at EOF).
  const block = `\n### Phase ${id}: ${desc}\n\n**Goal:** [To be planned]\n**Requirements**: TBD\n**Depends on:** Phase ${id - 1}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run gsd-slash plan-phase ${id} to break down)\n`;
  const sepIdx = roadmapText.lastIndexOf("\n---");
  const nextRoadmap =
    sepIdx >= 0 ? `${roadmapText.slice(0, sepIdx)}${block}${roadmapText.slice(sepIdx)}` : `${roadmapText}${block}`;
  writeFileSync(roadmapPath, nextRoadmap, "utf8");

  return { phase_number: id, padded, name: desc, slug, directory, naming_mode: "sequential" };
}

// ─── Part B step 2: mutating commands ───────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Find the phase directory name for a phase number (unpadded or padded). */
function findPhaseDir(cwd: string, phaseNum: string): string | null {
  const root = planningPhasesRoot(cwd);
  if (!existsSync(root)) return null;
  const n = phaseNum.replace(/^0+/, "") || phaseNum;
  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    return dirs.find((d) => new RegExp(`(^|[^0-9])0*${n}-`).test(d) || d.startsWith(`${n.padStart(2, "0")}-`)) ?? null;
  } catch {
    return null;
  }
}

/** Count PLAN / SUMMARY files (and derive plan ids from summaries) in a phase dir. */
function phasePlanCounts(
  cwd: string,
  dir: string,
): { planCount: number; summaryCount: number; summaryPlanIds: string[] } {
  let planCount = 0;
  let summaryCount = 0;
  const summaryPlanIds: string[] = [];
  try {
    for (const f of readdirSync(join(planningPhasesRoot(cwd), dir))) {
      if (/PLAN.*\.md$/i.test(f)) planCount += 1;
      if (/SUMMARY.*\.md$/i.test(f)) {
        summaryCount += 1;
        summaryPlanIds.push(f.replace(/-?SUMMARY.*\.md$/i, ""));
      }
    }
  } catch {
    /* unreadable dir → zero counts */
  }
  return { planCount, summaryCount, summaryPlanIds };
}

function statusFor(planCount: number, summaryCount: number): "Complete" | "In Progress" | "Planned" {
  if (planCount > 0 && summaryCount >= planCount) return "Complete";
  if (summaryCount > 0) return "In Progress";
  return "Planned";
}

/** Toggle the ROADMAP checkbox for a phase to [x] (+ completed date). */
function checkPhaseBox(text: string, phaseNum: string): string {
  const esc = phaseNum.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(-\\s*\\[)[ ](\\]\\s*.*Phase\\s+${esc}[:\\s][^\\n]*)`, "i");
  if (!re.test(text)) return text;
  return text.replace(re, (_m, a, b) => `${a}x${b} (completed ${today()})`);
}

/** Check each summarized plan's checkbox in the ROADMAP. */
function checkPlanBoxes(text: string, planIds: string[]): string {
  let out = text;
  for (const pid of planIds) {
    const esc = pid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${esc}(?:\\*\\*)?)`, "g");
    out = out.replace(re, (_m, a, b) => `${a}x${b}`);
  }
  return out;
}

/** Update the `**Plans:**` count line in a phase section. */
function updatePlansLine(text: string, summary: number, plan: number, complete: boolean): string {
  const re = /(\*\*Plans:\*\*\s*)([^\n]*)/i;
  if (!re.test(text)) return text;
  const word = complete ? "complete" : "executed";
  return text.replace(re, (_m, pre) => `${pre}${summary}/${plan} plans ${word}`);
}

export interface RoadmapPlanProgressData {
  updated: boolean;
  reason?: string;
  phase?: string;
  plan_count?: number;
  summary_count?: number;
  status?: string;
  complete?: boolean;
  /** Plain-text `--raw` line, e.g. "2/3 In Progress". */
  raw?: string;
}

/**
 * Native `roadmap update-plan-progress <N>` — recompute plan/summary counts from
 * the phase dir and sync the ROADMAP: phase checkbox (when complete), plan
 * checkboxes for summarized plans, and the `**Plans:**` count line. Returns
 * {updated:false} (exit-0 semantics) when the phase or ROADMAP is missing.
 */
export function nativeRoadmapPlanProgress(cwd: string, phaseNum: string): RoadmapPlanProgressData {
  const dir = findPhaseDir(cwd, phaseNum);
  if (!dir) return { updated: false, reason: `Phase ${phaseNum} not found`, raw: "no phase" };
  const roadmapPath = planningArtifact(cwd, "ROADMAP.md");
  if (!existsSync(roadmapPath)) return { updated: false, reason: "ROADMAP.md not found", raw: "no roadmap" };

  const { planCount, summaryCount, summaryPlanIds } = phasePlanCounts(cwd, dir);
  if (planCount === 0)
    return { updated: false, reason: "No plans found", phase: phaseNum, plan_count: 0, raw: "no plans" };

  const status = statusFor(planCount, summaryCount);
  const complete = status === "Complete";

  let text = readFileSync(roadmapPath, "utf8");
  text = updatePlansLine(text, summaryCount, planCount, complete);
  text = checkPlanBoxes(text, summaryPlanIds);
  if (complete) text = checkPhaseBox(text, phaseNum);
  writeFileSync(roadmapPath, text, "utf8");

  return {
    updated: true,
    phase: phaseNum,
    plan_count: planCount,
    summary_count: summaryCount,
    status,
    complete,
    raw: `${summaryCount}/${planCount} ${status}`,
  };
}

export interface PhaseCompleteData {
  ok: boolean;
  error?: string;
  completed_phase?: string;
  roadmap_updated?: boolean;
  state_updated?: boolean;
}

/**
 * Native `phase complete <N>` — mark the phase done in ROADMAP.md (checkbox +
 * plan checkboxes + Plans line) and reflect completion in STATE.md (Status). The
 * subprocess gates on a `passed` VERIFICATION; muonroi's caller writes that
 * verification immediately before calling, so the gate is satisfied by
 * construction — we still mark the ROADMAP/STATE so the workflow state is
 * consistent. Returns {ok:false} when the phase / ROADMAP is missing.
 */
export function nativePhaseComplete(cwd: string, phaseNum: string): PhaseCompleteData {
  const dir = findPhaseDir(cwd, phaseNum);
  if (!dir) return { ok: false, error: `Phase ${phaseNum} not found` };
  const roadmapPath = planningArtifact(cwd, "ROADMAP.md");
  if (!existsSync(roadmapPath)) return { ok: false, error: "ROADMAP.md not found" };

  const { planCount, summaryCount, summaryPlanIds } = phasePlanCounts(cwd, dir);

  let text = readFileSync(roadmapPath, "utf8");
  text = checkPhaseBox(text, phaseNum);
  text = checkPlanBoxes(text, summaryPlanIds);
  text = updatePlansLine(text, summaryCount, planCount, true);
  writeFileSync(roadmapPath, text, "utf8");

  // STATE.md — reflect completion on the body Status field (best-effort).
  let stateUpdated = false;
  const statePath = planningArtifact(cwd, "STATE.md");
  if (existsSync(statePath)) {
    const content = readFileSync(statePath, "utf8");
    const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const body = m ? m[2] : content;
    const fm = m ? m[1] : null;
    const nextBody = stateReplaceField(body, "Status", normalizeStateStatus("Phase complete"));
    if (nextBody !== null) {
      const next = fm !== null ? `---\n${fm}\n---\n\n${nextBody.replace(/^\n+/, "")}` : nextBody;
      writeFileSync(statePath, next, "utf8");
      stateUpdated = true;
    }
  }

  return { ok: true, completed_phase: phaseNum, roadmap_updated: true, state_updated: stateUpdated };
}
