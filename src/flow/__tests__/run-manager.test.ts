import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSections } from "../parser.js";
import { createRun, getActiveRunId, loadRun, setActiveRunId, updateRunFile } from "../run-manager.js";
import { ensureFlowDir } from "../scaffold.js";

describe("run-manager", () => {
  let tmpDir: string;
  let flowDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-"));
    flowDir = await ensureFlowDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("createRun", () => {
    it("creates runs/<id>/ with roadmap.md, state.md, delegations.md, gray-areas.md", async () => {
      const run = await createRun(flowDir);
      const runDir = path.join(flowDir, "runs", run.id);

      const roadmap = await fs.stat(path.join(runDir, "roadmap.md"));
      expect(roadmap.isFile()).toBe(true);
      const state = await fs.stat(path.join(runDir, "state.md"));
      expect(state.isFile()).toBe(true);
      const delegations = await fs.stat(path.join(runDir, "delegations.md"));
      expect(delegations.isFile()).toBe(true);
      const grayAreas = await fs.stat(path.join(runDir, "gray-areas.md"));
      expect(grayAreas.isFile()).toBe(true);
    });

    it("returns RunState with id matching Date.now().toString(36) + 4-char hex suffix", async () => {
      const run = await createRun(flowDir);
      // ID should be base36 timestamp (7-8 chars) + 4-char hex suffix
      expect(run.id).toMatch(/^[a-z0-9]+[a-f0-9]{4}$/);
      expect(run.id.length).toBeGreaterThanOrEqual(11);
      expect(run.id.length).toBeLessThanOrEqual(13);
    });

    it("initializes state.md with Resume Digest and Experience Snapshot headings", async () => {
      const run = await createRun(flowDir);
      const stateContent = await fs.readFile(path.join(flowDir, "runs", run.id, "state.md"), "utf8");
      expect(stateContent).toContain("## Resume Digest");
      expect(stateContent).toContain("## Experience Snapshot");
    });
  });

  describe("loadRun", () => {
    it("reads all 4 files and returns RunState with SectionMaps", async () => {
      const created = await createRun(flowDir);
      const loaded = await loadRun(flowDir, created.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(created.id);
      expect(loaded!.state.sections).toBeInstanceOf(Map);
      expect(loaded!.roadmap.sections).toBeInstanceOf(Map);
      expect(loaded!.delegations.sections).toBeInstanceOf(Map);
      expect(loaded!.grayAreas.sections).toBeInstanceOf(Map);
    });

    it("returns null for non-existent run", async () => {
      const result = await loadRun(flowDir, "nonexistent123");
      expect(result).toBeNull();
    });
  });

  describe("setActiveRunId / getActiveRunId", () => {
    it("writes and reads active run ID from state.md", async () => {
      const run = await createRun(flowDir);
      await setActiveRunId(flowDir, run.id);
      const activeId = await getActiveRunId(flowDir);
      expect(activeId).toBe(run.id);
    });

    it("returns null when no active run is set", async () => {
      const activeId = await getActiveRunId(flowDir);
      expect(activeId).toBeNull();
    });
  });

  describe("updateRunFile", () => {
    it("writes atomically to runs/<runId>/<filename>", async () => {
      const run = await createRun(flowDir);
      const sections = parseSections("## Test\n\nupdated content");
      await updateRunFile(flowDir, run.id, "roadmap.md", sections);

      const content = await fs.readFile(path.join(flowDir, "runs", run.id, "roadmap.md"), "utf8");
      expect(content).toContain("updated content");
    });
  });
});
