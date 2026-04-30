/**
 * Kill-and-restart integration test proving FLOW-04:
 * .muonroi-flow/ state survives simulated crash and is restored on cold start.
 *
 * Module-level test — directly exercises flow state read/write + resume pipeline
 * without requiring OpenTUI boot.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

import { ensureFlowDir } from "../../src/flow/scaffold.js";
import {
  createRun,
  setActiveRunId,
  getActiveRunId,
  loadRun,
  updateRunFile,
} from "../../src/flow/run-manager.js";
import { parseSections, getSection } from "../../src/flow/parser.js";
import { loadFlowResumeDigest } from "../../src/orchestrator/flow-resume.js";

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

describe("kill-restart continuity (FLOW-04)", { timeout: 15000 }, () => {
  it("restores .muonroi-flow/ state after simulated crash", async () => {
    // 1. Create temp dir with .muonroi-flow/ scaffold
    const cwd = await makeTempDir("kill-restart-");
    const flowDir = await ensureFlowDir(cwd);

    // 2. Simulate /discuss creating a run
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    // 3. Write state to run's state.md (simulate mid-task state)
    const stateMap = parseSections("");
    stateMap.sections.set(
      "Resume Digest",
      "Working on feature X. File: src/foo.ts modified.",
    );
    stateMap.sections.set("Status", "executing");
    stateMap.sections.set(
      "Experience Snapshot",
      "[2026-04-30T12:00:00Z] Warning about Y",
    );
    await updateRunFile(flowDir, run.id, "state.md", stateMap);

    // 4. Simulate crash (no cleanup — just abandon the "process")
    // The point: state.md was written atomically, so it survives

    // 5. Simulate cold restart: loadFlowResumeDigest should find state
    const digest = await loadFlowResumeDigest(cwd);
    expect(digest).toContain("Working on feature X");
    expect(digest).toContain("src/foo.ts");

    // 6. Verify active run ID survived
    const activeId = await getActiveRunId(flowDir);
    expect(activeId).toBe(run.id);

    // 7. Verify Experience Snapshot survived
    const restored = await loadRun(flowDir, run.id);
    expect(restored).not.toBeNull();
    const snapshot = getSection(restored!.state, "Experience Snapshot");
    expect(snapshot).toContain("Warning about Y");
  });

  it("handles missing .muonroi-flow/ gracefully on restart", async () => {
    const cwd = await makeTempDir("no-flow-");
    const digest = await loadFlowResumeDigest(cwd);
    expect(digest).toBeNull();
  });

  it("atomic writes survive — no .tmp files left behind", async () => {
    const cwd = await makeTempDir("atomic-");
    const flowDir = await ensureFlowDir(cwd);
    const run = await createRun(flowDir);

    // Write valid state
    const stateMap = parseSections("");
    stateMap.sections.set("Resume Digest", "Valid state");
    await updateRunFile(flowDir, run.id, "state.md", stateMap);

    // Verify .tmp file does NOT exist (atomic rename completed)
    const tmpPath = path.join(flowDir, "runs", run.id, "state.md.tmp");
    await expect(fs.access(tmpPath)).rejects.toThrow();

    // Verify state.md exists and is valid
    const loaded = await loadRun(flowDir, run.id);
    expect(loaded).not.toBeNull();
    expect(getSection(loaded!.state, "Resume Digest")).toBe("Valid state");
  });
});
