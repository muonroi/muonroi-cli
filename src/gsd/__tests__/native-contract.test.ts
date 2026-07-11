/**
 * Native gsd-tools behavior tests.
 *
 * These began as contract tests comparing the native reimplementations against
 * the `@opengsd/gsd-core` subprocess oracle. In Part B step 2 the subprocess +
 * dep were removed, so the native behavior IS the spec now — these assertions
 * pin it directly (the equivalence they once proved is captured by the fixtures
 * + expected values below).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nativePhaseAdd,
  nativePhaseComplete,
  nativeRoadmapAnalyze,
  nativeRoadmapPlanProgress,
} from "../native-roadmap.js";
import { nativeConfigEnsure, nativeInitProgress, nativeStateJson, nativeStateUpdate } from "../native-state.js";
import { planningArtifact, planningRoot } from "../paths.js";

const ROADMAP = `# Roadmap

## Milestone v1.0

### Phase 1: Bootstrap the core
**Goal:** stand up skeleton
**Depends on:** Phase 0
**Plans:** 1 plans

Plans:
- [x] **01-01: skeleton**

### Phase 2: Add the API
**Goal:** REST surface
**Depends on:** Phase 1
**Plans:** 0 plans

Plans:
- [ ] TBD

---
`;

const STATE = `---
gsd_state_version: '1.0'
status: executing
progress:
  total_phases: 2
  completed_phases: 1
  total_plans: 2
  completed_plans: 1
  percent: 50
---

# Project State

## Current Position

| Field | Value |
| --- | --- |
| Phase | execute |
| Current Phase | 2 |
| Status | Executing |
| Total Phases | 2 |
| Completed Phases | 1 |
| Depth | standard |
`;

function seed(cwd: string) {
  mkdirSync(join(cwd, ".planning", "phases", "01-bootstrap-the-core"), { recursive: true });
  writeFileSync(join(cwd, ".planning", "phases", "01-bootstrap-the-core", "01-01-PLAN.md"), "# plan\n", "utf8");
  writeFileSync(join(cwd, ".planning", "phases", "01-bootstrap-the-core", "01-01-SUMMARY.md"), "# summary\n", "utf8");
  writeFileSync(planningArtifact(cwd, "ROADMAP.md"), ROADMAP, "utf8");
  writeFileSync(planningArtifact(cwd, "STATE.md"), STATE, "utf8");
}

describe("native gsd-tools behavior", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gsd-native-${Date.now().toString(36)}-${Math.floor(process.hrtime()[1] % 1e6)}`);
    seed(cwd);
  });
  afterEach(() => {
    if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it("roadmap analyze: phases in order; current_phase null when none in progress", () => {
    const r = nativeRoadmapAnalyze(cwd);
    expect(r.phases.map((p) => p.number)).toEqual(["1", "2"]);
    expect(r.phase_count).toBe(2);
    // Phase 1 complete (plan+summary), phase 2 not started (no dir) → no phase "in progress".
    expect(r.current_phase).toBeNull();
  });

  it("state json: status normalized + progress derived from STATE.md", () => {
    const r = nativeStateJson(cwd);
    expect(r.status).toBe("executing");
    const progress = r.progress as Record<string, number>;
    expect(progress.total_phases).toBe(2);
    expect(progress.completed_phases).toBe(1);
    expect(progress.percent).toBe(50);
  });

  it("state update: replaces the body table cell, leaves frontmatter", () => {
    const r = nativeStateUpdate(cwd, "Status", "Completed");
    expect(r.updated).toBe(true);
    const after = readFileSync(planningArtifact(cwd, "STATE.md"), "utf8");
    expect(after).toContain("| Status | Completed |");
    expect(after).toContain("status: executing");
  });

  it("state update: missing field → updated:false", () => {
    const r = nativeStateUpdate(cwd, "NonexistentField", "x");
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it("init progress: existence flags + phase count", () => {
    const r = nativeInitProgress(cwd);
    expect(r.state_exists).toBe(true);
    expect(r.roadmap_exists).toBe(true);
    expect(r.phase_count).toBe(2);
  });

  it("phase add: sequential number + slug + created dir", () => {
    const r = nativePhaseAdd(cwd, "Wire the dashboard");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.padded).toBe("03");
    expect(r.slug).toBe("wire-the-dashboard");
    expect(existsSync(join(cwd, ".planning", "phases", r.directory))).toBe(true);
    // The ROADMAP now has a Phase 3 heading.
    expect(readFileSync(planningArtifact(cwd, "ROADMAP.md"), "utf8")).toMatch(/### Phase 3: Wire the dashboard/);
  });
});

// ─── mutating commands ──────────────────────────────────────────────────────

const ROADMAP2 = `# Roadmap

## Milestone v1.0

- [ ] **Phase 1: Bootstrap** - In progress
- [ ] **Phase 2: API** - pending

### Phase 1: Bootstrap the core
**Goal:** skeleton
**Plans:** 1 plans

Plans:
- [ ] **01-01: skeleton**

### Phase 2: Add the API
**Goal:** REST
**Plans:** 0 plans

Plans:
- [ ] TBD
`;

function seedComplete(cwd: string) {
  mkdirSync(join(cwd, ".planning", "phases", "01-bootstrap-the-core"), { recursive: true });
  writeFileSync(join(cwd, ".planning", "phases", "01-bootstrap-the-core", "01-01-PLAN.md"), "# plan\n", "utf8");
  writeFileSync(join(cwd, ".planning", "phases", "01-bootstrap-the-core", "01-01-SUMMARY.md"), "# summary\n", "utf8");
  // Phase 2 dir exists but has NO plan files → the "no plans" (updated:false) path.
  mkdirSync(join(cwd, ".planning", "phases", "02-add-the-api"), { recursive: true });
  writeFileSync(planningArtifact(cwd, "ROADMAP.md"), ROADMAP2, "utf8");
  writeFileSync(planningArtifact(cwd, "STATE.md"), STATE, "utf8");
}

function phaseBoxChecked(cwd: string, phase: number): boolean {
  const t = readFileSync(planningArtifact(cwd, "ROADMAP.md"), "utf8");
  return new RegExp(`-\\s*\\[x\\]\\s*\\*\\*Phase\\s+${phase}`, "i").test(t);
}
function planBoxChecked(cwd: string): boolean {
  const t = readFileSync(planningArtifact(cwd, "ROADMAP.md"), "utf8");
  return /-\s*\[x\]\s*\*\*01-01/i.test(t);
}

describe("native gsd-tools mutating commands", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gsd-mut-${Date.now().toString(36)}-${Math.floor(process.hrtime()[1] % 1e6)}`);
    seedComplete(cwd);
  });
  afterEach(() => {
    if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it("roadmap update-plan-progress: complete phase checks phase + plan boxes", () => {
    const r = nativeRoadmapPlanProgress(cwd, "1");
    expect(r.updated).toBe(true);
    expect(r.status).toBe("Complete");
    expect(phaseBoxChecked(cwd, 1)).toBe(true);
    expect(planBoxChecked(cwd)).toBe(true);
    expect(r.raw).toBe("1/1 Complete");
  });

  it("roadmap update-plan-progress: no-plan phase → updated:false, ok-soft", () => {
    const r = nativeRoadmapPlanProgress(cwd, "2");
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/no plans/i);
  });

  it("phase complete: marks the phase box + plan box, updates STATE status", () => {
    const r = nativePhaseComplete(cwd, "1");
    expect(r.ok).toBe(true);
    expect(r.roadmap_updated).toBe(true);
    expect(phaseBoxChecked(cwd, 1)).toBe(true);
    expect(planBoxChecked(cwd)).toBe(true);
    expect(r.state_updated).toBe(true);
    const state = readFileSync(planningArtifact(cwd, "STATE.md"), "utf8");
    expect(state).toMatch(/\|\s*Status\s*\|\s*completed\s*\|/i);
  });

  it("phase complete: missing phase → ok:false", () => {
    const r = nativePhaseComplete(cwd, "9");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it("config-ensure: creates the planning root (folded for a fresh project), idempotent", () => {
    const fresh = join(tmpdir(), `gsd-cfg-${Date.now().toString(36)}`);
    try {
      const r = nativeConfigEnsure(fresh);
      expect(r.ok).toBe(true);
      expect(r.created).toBe(true);
      // Fresh project → consolidated `.muonroi-flow/planning` (live cutover).
      expect(planningRoot(fresh)).toBe(join(fresh, ".muonroi-flow", "planning"));
      expect(existsSync(planningRoot(fresh))).toBe(true);
      expect(nativeConfigEnsure(fresh).created).toBe(false);
    } finally {
      if (existsSync(fresh)) rmSync(fresh, { recursive: true, force: true });
    }
  });
});
