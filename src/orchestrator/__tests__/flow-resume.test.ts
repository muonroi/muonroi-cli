/**
 * Tests for flow-resume.ts — loadFlowResumeDigest reads .muonroi-flow/
 * state before chat transcript on cold start.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

import { loadFlowResumeDigest } from "../flow-resume.js";
import { ensureFlowDir } from "../../flow/scaffold.js";
import { createRun, setActiveRunId, updateRunFile } from "../../flow/run-manager.js";
import { parseSections } from "../../flow/parser.js";

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

describe("loadFlowResumeDigest", () => {
  it("returns Resume Digest content from active run state.md", async () => {
    const cwd = await makeTempDir("resume-digest-");
    const flowDir = await ensureFlowDir(cwd);
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    // Write Resume Digest content
    const stateMap = parseSections("");
    stateMap.sections.set("Resume Digest", "Working on feature X. File: src/foo.ts modified.");
    stateMap.sections.set("Experience Snapshot", "");
    await updateRunFile(flowDir, run.id, "state.md", stateMap);

    const digest = await loadFlowResumeDigest(cwd);
    expect(digest).toBe("Working on feature X. File: src/foo.ts modified.");
  });

  it("returns null when .muonroi-flow/ does not exist", async () => {
    const cwd = await makeTempDir("no-flow-");
    const digest = await loadFlowResumeDigest(cwd);
    expect(digest).toBeNull();
  });

  it("returns null when no active run is set", async () => {
    const cwd = await makeTempDir("no-active-");
    await ensureFlowDir(cwd);
    // Don't set active run
    const digest = await loadFlowResumeDigest(cwd);
    expect(digest).toBeNull();
  });

  it("returns null when active run has empty Resume Digest", async () => {
    const cwd = await makeTempDir("empty-digest-");
    const flowDir = await ensureFlowDir(cwd);
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);
    // createRun initializes state.md with empty Resume Digest — don't write content

    const digest = await loadFlowResumeDigest(cwd);
    expect(digest).toBeNull();
  });
});
