/**
 * native-roadmap.ts — Native replacements for the ROADMAP-oriented gsd-tools
 * subcommands that are read-only or additive: `roadmap analyze` (read-only) and
 * `phase add` (create dir + append a phase block).
 *
 * Part B (staged, step 1). The two DESTRUCTIVE multi-file mutations — `phase
 * complete` and `roadmap update-plan-progress` — are intentionally NOT
 * reimplemented here: they rewrite ROADMAP/REQUIREMENTS/STATE with dozens of
 * regex edge cases and are TASK-workflow-only + low-frequency, so they stay on
 * the subprocess until the dedicated soak sprint (the exact risk the debate
 * flagged). See gsd-dispatch.ts.
 *
 * Contracts verified against the real subprocess in the native-roadmap tests.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config-loader.js";
import { planningArtifact, planningPhasesRoot } from "./paths.js";

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
