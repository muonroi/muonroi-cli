import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { detectLegacyFlow, migrateQuickCodexFlow } from "../migration.js";

describe("migration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-migrate-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("detectLegacyFlow", () => {
    it("returns true when .quick-codex-flow/ exists", async () => {
      await fs.mkdir(path.join(tmpDir, ".quick-codex-flow"), { recursive: true });
      expect(await detectLegacyFlow(tmpDir)).toBe(true);
    });

    it("returns false when .quick-codex-flow/ does not exist", async () => {
      expect(await detectLegacyFlow(tmpDir)).toBe(false);
    });
  });

  describe("migrateQuickCodexFlow", () => {
    it("copies STATE.md -> state.md, PROJECT-ROADMAP.md -> roadmap.md, BACKLOG.md -> backlog.md", async () => {
      const qcDir = path.join(tmpDir, ".quick-codex-flow");
      await fs.mkdir(qcDir, { recursive: true });
      await fs.writeFile(path.join(qcDir, "STATE.md"), "## Active Run\n\nmy-run", "utf8");
      await fs.writeFile(path.join(qcDir, "PROJECT-ROADMAP.md"), "## Milestones\n\nv1.0", "utf8");
      await fs.writeFile(path.join(qcDir, "BACKLOG.md"), "## Deferred\n\nitem 1", "utf8");

      await migrateQuickCodexFlow(tmpDir);

      const flowDir = path.join(tmpDir, ".muonroi-flow");
      const state = await fs.readFile(path.join(flowDir, "state.md"), "utf8");
      expect(state).toContain("my-run");

      const roadmap = await fs.readFile(path.join(flowDir, "roadmap.md"), "utf8");
      expect(roadmap).toContain("v1.0");

      const backlog = await fs.readFile(path.join(flowDir, "backlog.md"), "utf8");
      expect(backlog).toContain("item 1");
    });

    it("splits monolithic QC run file into runs/<id>/{roadmap,state,delegations,gray-areas}.md", async () => {
      const qcDir = path.join(tmpDir, ".quick-codex-flow");
      await fs.mkdir(qcDir, { recursive: true });
      // Top-level files needed for migration not to fail
      await fs.writeFile(path.join(qcDir, "STATE.md"), "", "utf8");
      await fs.writeFile(path.join(qcDir, "PROJECT-ROADMAP.md"), "", "utf8");
      await fs.writeFile(path.join(qcDir, "BACKLOG.md"), "", "utf8");

      // Monolithic run file
      const runContent = [
        "## Delivery Roadmap\n\nPhase 1 done",
        "## Resume Digest\n\nLast worked on X",
        "## Experience Snapshot\n\nLearned Y",
        "## Delegation State\n\nAgent A owns task 1",
        "## Gray Area Register\n\nG1: unclear requirement",
        "## Decision Register\n\nD1: chose option A",
      ].join("\n\n");
      await fs.writeFile(path.join(qcDir, "my-feature-run.md"), runContent, "utf8");

      const result = await migrateQuickCodexFlow(tmpDir);
      expect(result.runsCreated).toBe(1);

      const flowDir = path.join(tmpDir, ".muonroi-flow");

      // Find the created run directory
      const runs = await fs.readdir(path.join(flowDir, "runs"));
      expect(runs.length).toBe(1);
      const runDir = path.join(flowDir, "runs", runs[0]);

      const roadmap = await fs.readFile(path.join(runDir, "roadmap.md"), "utf8");
      expect(roadmap).toContain("Phase 1 done");

      const state = await fs.readFile(path.join(runDir, "state.md"), "utf8");
      expect(state).toContain("Last worked on X");
      expect(state).toContain("Learned Y");

      const delegations = await fs.readFile(path.join(runDir, "delegations.md"), "utf8");
      expect(delegations).toContain("Agent A owns task 1");

      const grayAreas = await fs.readFile(path.join(runDir, "gray-areas.md"), "utf8");
      expect(grayAreas).toContain("unclear requirement");

      // Decision Register appended to top-level decisions.md
      const decisions = await fs.readFile(path.join(flowDir, "decisions.md"), "utf8");
      expect(decisions).toContain("chose option A");
    });

    it("preserves unknown sections as-is in state.md (tolerant)", async () => {
      const qcDir = path.join(tmpDir, ".quick-codex-flow");
      await fs.mkdir(qcDir, { recursive: true });
      await fs.writeFile(path.join(qcDir, "STATE.md"), "", "utf8");
      await fs.writeFile(path.join(qcDir, "PROJECT-ROADMAP.md"), "", "utf8");
      await fs.writeFile(path.join(qcDir, "BACKLOG.md"), "", "utf8");

      const runContent = [
        "## Resume Digest\n\nresume info",
        "## Custom Unknown Section\n\ncustom content here",
      ].join("\n\n");
      await fs.writeFile(path.join(qcDir, "custom-run.md"), runContent, "utf8");

      await migrateQuickCodexFlow(tmpDir);

      const flowDir = path.join(tmpDir, ".muonroi-flow");
      const runs = await fs.readdir(path.join(flowDir, "runs"));
      const state = await fs.readFile(
        path.join(flowDir, "runs", runs[0], "state.md"),
        "utf8",
      );
      expect(state).toContain("custom content here");
    });

    it("does NOT delete original .quick-codex-flow/ after migration", async () => {
      const qcDir = path.join(tmpDir, ".quick-codex-flow");
      await fs.mkdir(qcDir, { recursive: true });
      await fs.writeFile(path.join(qcDir, "STATE.md"), "original", "utf8");
      await fs.writeFile(path.join(qcDir, "PROJECT-ROADMAP.md"), "", "utf8");
      await fs.writeFile(path.join(qcDir, "BACKLOG.md"), "", "utf8");

      await migrateQuickCodexFlow(tmpDir);

      // Original still exists
      const stat = await fs.stat(qcDir);
      expect(stat.isDirectory()).toBe(true);
      const content = await fs.readFile(path.join(qcDir, "STATE.md"), "utf8");
      expect(content).toBe("original");
    });
  });
});
