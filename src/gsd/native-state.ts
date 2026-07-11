/**
 * native-state.ts — Native replacements for the STATE.md-oriented gsd-tools
 * subcommands (`state update`, `state json`, `init progress`).
 *
 * Part B (staged, step 1): these replace the `@opengsd/gsd-core` subprocess on
 * the hot read/write paths. The subprocess (`runGsdTools`) is kept as the
 * contract-test ORACLE + rollback fallback while `MUONROI_GSD_NATIVE` is on.
 * Contracts verified against the real subprocess in native-state contract tests.
 *
 * Output shapes mirror gsd-tools `--raw`/JSON contract (see research in
 * SPRINT-2 plan): state update → {updated:boolean, reason?}, state json →
 * frontmatter object, init progress → progress projection.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { planningArtifact, planningPhasesRoot, planningRoot } from "./paths.js";
import {
  computeProgressPercent,
  normalizeStateStatus,
  stateExtractField,
  stateReplaceField,
} from "./state-document.js";

export interface StateUpdateResult {
  updated: boolean;
  reason?: string;
}

/** Split a STATE.md into (frontmatter, body). Frontmatter is the text between
 * the leading `---` fences (exclusive); body is everything after. */
function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: m[1], body: m[2] };
}

/**
 * Native `state update <field> <value>`.
 * Mirrors gsd-core updateCore: strip frontmatter, `stateReplaceField` on the
 * BODY only, reassemble. Returns {updated:false, reason} when the field is not
 * present or STATE.md is missing (never throws). Caller invalidates cache.
 */
export function nativeStateUpdate(cwd: string, field: string, value: string): StateUpdateResult {
  const path = planningArtifact(cwd, "STATE.md");
  if (!existsSync(path)) return { updated: false, reason: "STATE.md not found" };
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { updated: false, reason: "STATE.md not found" };
  }
  const { frontmatter, body } = splitFrontmatter(content);
  const replaced = stateReplaceField(body, field, value);
  if (replaced === null) {
    return { updated: false, reason: `Field "${field}" not found in STATE.md` };
  }
  const next = frontmatter !== null ? `---\n${frontmatter}\n---\n\n${replaced.replace(/^\n+/, "")}` : replaced;
  try {
    // gsd-core writes under lock; a plain write matches the prior subprocess
    // behavior for the single-writer product loop.
    writeFileSync(path, next, "utf8");
  } catch (err) {
    return { updated: false, reason: (err as Error).message };
  }
  return { updated: true };
}

/** Count digit-prefixed phase headings in a ROADMAP.md milestone body. */
function countRoadmapPhases(cwd: string): number {
  const roadmap = planningArtifact(cwd, "ROADMAP.md");
  if (!existsSync(roadmap)) return 0;
  try {
    const text = readFileSync(roadmap, "utf8");
    const re = /#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+(\d+[A-Za-z]?(?:[.-]\d+)*)\s*:/gi;
    const seen = new Set<string>();
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const n = m[1];
      if (n === "0" || n.startsWith("999")) continue;
      seen.add(n);
    }
    return seen.size;
  } catch {
    return 0;
  }
}

/** List phase directories with lightweight disk counts. */
function scanPhaseDirs(cwd: string): Array<{ dir: string; plan_count: number; summary_count: number }> {
  const root = planningPhasesRoot(cwd);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        let plan_count = 0;
        let summary_count = 0;
        try {
          for (const f of readdirSync(`${root}/${e.name}`)) {
            if (/PLAN.*\.md$/i.test(f)) plan_count += 1;
            if (/SUMMARY.*\.md$/i.test(f)) summary_count += 1;
          }
        } catch {
          /* unreadable phase dir — count as empty */
        }
        return { dir: e.name, plan_count, summary_count };
      })
      .sort((a, b) => a.dir.localeCompare(b.dir));
  } catch {
    return [];
  }
}

/**
 * Native `state json` — frontmatter snapshot derived from STATE.md body fields
 * + roadmap phase count. Note: gsd-core emits a fresh `last_updated` ISO stamp;
 * we OMIT that non-deterministic field so consumers/tests get a stable object
 * (workflow-engine only reads it loosely as `state_frontmatter`).
 */
export function nativeStateJson(cwd: string): Record<string, unknown> {
  const path = planningArtifact(cwd, "STATE.md");
  if (!existsSync(path)) return { error: "STATE.md not found" };
  const content = readFileSync(path, "utf8");
  const get = (f: string) => stateExtractField(content, f);

  const totalPhasesFromRoadmap = countRoadmapPhases(cwd);
  const totalPhases = Number.parseInt(get("Total Phases") ?? "", 10);
  const completedPhases = Number.parseInt(get("Completed Phases") ?? "", 10);
  const totalPlans = Number.parseInt(get("Total Plans in Phase") ?? get("Total Plans") ?? "", 10);
  const completedPlans = Number.parseInt(get("Completed Plans") ?? "", 10);

  const tp = Number.isFinite(totalPhases) ? totalPhases : totalPhasesFromRoadmap || null;
  const cp = Number.isFinite(completedPhases) ? completedPhases : null;
  const tpl = Number.isFinite(totalPlans) ? totalPlans : null;
  const cpl = Number.isFinite(completedPlans) ? completedPlans : null;

  const out: Record<string, unknown> = { gsd_state_version: "1.0" };
  const currentPhase = get("Current Phase") ?? get("Phase");
  if (currentPhase) out.current_phase = currentPhase;
  const currentPlan = get("Current Plan");
  if (currentPlan) out.current_plan = currentPlan;
  out.status = normalizeStateStatus(get("Status") ?? "", get("Paused At") ?? undefined);
  const lastActivity = get("Last Activity");
  if (lastActivity) out.last_activity = lastActivity;

  const progress: Record<string, number> = {};
  if (tp !== null) progress.total_phases = tp;
  if (cp !== null) progress.completed_phases = cp;
  if (tpl !== null) progress.total_plans = tpl;
  if (cpl !== null) progress.completed_plans = cpl;
  const percent = computeProgressPercent(cpl, tpl, cp, tp);
  if (percent !== null) progress.percent = percent;
  if (Object.keys(progress).length > 0) out.progress = progress;

  return out;
}

/**
 * Native `init progress` — the projection consumed by workflow-engine.readProgress.
 * Mirrors the subset of gsd-core's cmdInitProgress that muonroi actually reads:
 * existence flags, phase list + counts, current/next phase.
 */
export function nativeInitProgress(cwd: string): Record<string, unknown> {
  const stateExists = existsSync(planningArtifact(cwd, "STATE.md"));
  const roadmapExists = existsSync(planningArtifact(cwd, "ROADMAP.md"));
  const projectExists = existsSync(planningArtifact(cwd, "PROJECT.md"));
  const phaseDirs = scanPhaseDirs(cwd);
  const phases = phaseDirs.map((p) => {
    const numMatch = p.dir.match(/(\d+)/);
    return {
      number: numMatch ? numMatch[1] : p.dir,
      directory: p.dir,
      plan_count: p.plan_count,
      summary_count: p.summary_count,
      status:
        p.summary_count >= p.plan_count && p.plan_count > 0
          ? "complete"
          : p.plan_count > 0
            ? "in_progress"
            : "not_started",
    };
  });
  const completed = phases.filter((p) => p.status === "complete").length;
  const inProgress = phases.filter((p) => p.status === "in_progress").length;
  const current = phases.find((p) => p.status !== "complete");
  return {
    phases,
    phase_count: Math.max(phases.length, countRoadmapPhases(cwd)),
    completed_count: completed,
    in_progress_count: inProgress,
    current_phase: current?.number ?? null,
    project_exists: projectExists,
    roadmap_exists: roadmapExists,
    state_exists: stateExists,
    state_path: planningArtifact(cwd, "STATE.md"),
    roadmap_path: planningArtifact(cwd, "ROADMAP.md"),
    project_root: planningRoot(cwd),
    has_work_in_progress: inProgress > 0,
  };
}

/** True when STATE.md exists (used by callers to decide native vs. bootstrap). */
export function stateFileMtime(cwd: string): number {
  try {
    const p = planningArtifact(cwd, "STATE.md");
    return existsSync(p) ? statSync(p).mtimeMs : 0;
  } catch {
    return 0;
  }
}
