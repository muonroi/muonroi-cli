/**
 * Part B contract tests — native reimplementations must match the
 * `@opengsd/gsd-core` subprocess (the oracle) on the fields muonroi consumes.
 *
 * The subprocess dep is kept (staged step 1), so we run BOTH the native fn and
 * `runGsdTools(...)` on the same fixture and assert equivalence. Non-deterministic
 * fields (ISO timestamps) and cosmetic extras are excluded — we pin the
 * behavioral contract, not byte-for-byte JSON.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGsdTools } from "../gsd-dispatch.js";
import { nativePhaseAdd, nativeRoadmapAnalyze } from "../native-roadmap.js";
import { nativeInitProgress, nativeStateJson, nativeStateUpdate } from "../native-state.js";
import { planningArtifact } from "../paths.js";

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
  writeFileSync(planningArtifact(cwd, "config.json"), JSON.stringify({ commit_docs: false }, null, 2), "utf8");
}

describe("Part B native contract (native ≡ subprocess oracle)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gsd-contract-${Date.now().toString(36)}-${Math.floor(process.hrtime()[1] % 1e6)}`);
    seed(cwd);
  });
  afterEach(() => {
    if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it("roadmap analyze: phase numbers + current_phase match subprocess", () => {
    const native = nativeRoadmapAnalyze(cwd);
    const sub = runGsdTools(cwd, ["roadmap", "analyze"]);
    expect(sub.ok).toBe(true);
    const subData = sub.data as { phases?: Array<{ number: string }>; current_phase?: string | null };
    expect(native.phases.map((p) => String(p.number))).toEqual((subData.phases ?? []).map((p) => String(p.number)));
    expect(String(native.current_phase)).toBe(String(subData.current_phase));
  });

  it("state json: status + progress match subprocess (ISO stamps excluded)", () => {
    const native = nativeStateJson(cwd);
    const sub = runGsdTools(cwd, ["state", "json"]);
    expect(sub.ok).toBe(true);
    const subData = sub.data as { status?: string; progress?: Record<string, number> };
    expect(native.status).toBe(subData.status);
    const np = native.progress as Record<string, number> | undefined;
    expect(np?.total_phases).toBe(subData.progress?.total_phases);
    expect(np?.completed_phases).toBe(subData.progress?.completed_phases);
    expect(np?.percent).toBe(subData.progress?.percent);
  });

  it("state update: native updates the body table cell like the subprocess", () => {
    // Both native and subprocess mutate the STATE.md BODY only (frontmatter
    // `status:` is left untouched), so we assert on the body table row.
    const r = nativeStateUpdate(cwd, "Status", "Completed");
    expect(r.updated).toBe(true);
    const after = readFileSync(planningArtifact(cwd, "STATE.md"), "utf8");
    expect(after).toContain("| Status | Completed |");
    // Frontmatter untouched (matches subprocess updateCore, which strips+rebuilds fm).
    expect(after).toContain("status: executing");

    // Subprocess on an identical fresh fixture → same body mutation.
    const cwd2 = join(tmpdir(), `gsd-contract-su-${Date.now().toString(36)}`);
    seed(cwd2);
    const sub = runGsdTools(cwd2, ["state", "update", "Status", "Completed"]);
    expect(sub.ok).toBe(true);
    const after2 = readFileSync(planningArtifact(cwd2, "STATE.md"), "utf8");
    expect(after2).toContain("| Status | Completed |");
    rmSync(cwd2, { recursive: true, force: true });
  });

  it("state update: missing field reports updated:false", () => {
    const r = nativeStateUpdate(cwd, "NonexistentField", "x");
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it("init progress: existence flags + counts match subprocess", () => {
    const native = nativeInitProgress(cwd);
    const sub = runGsdTools(cwd, ["init", "progress"]);
    expect(sub.ok).toBe(true);
    const subData = sub.data as { state_exists?: boolean; roadmap_exists?: boolean; phase_count?: number };
    expect(native.state_exists).toBe(subData.state_exists);
    expect(native.roadmap_exists).toBe(subData.roadmap_exists);
    expect(native.phase_count).toBe(subData.phase_count);
  });

  it("phase add: native creates same padded number + phase dir as subprocess", () => {
    // Native adds Phase 3.
    const native = nativePhaseAdd(cwd, "Wire the dashboard");
    expect("error" in native).toBe(false);
    if ("error" in native) return;
    expect(native.padded).toBe("03");
    expect(native.slug).toBe("wire-the-dashboard");
    expect(existsSync(join(cwd, ".planning", "phases", native.directory))).toBe(true);

    // Subprocess on a fresh identical fixture → same padded + a dir with slug.
    const cwd2 = join(tmpdir(), `gsd-contract-pa-${Date.now().toString(36)}`);
    seed(cwd2);
    const sub = runGsdTools(cwd2, ["phase", "add", "Wire the dashboard"]);
    expect(sub.ok).toBe(true);
    const dirs = readdirSync(join(cwd2, ".planning", "phases"));
    expect(dirs.some((d) => d.includes("03") && d.includes("wire-the-dashboard"))).toBe(true);
    rmSync(cwd2, { recursive: true, force: true });
  });
});
