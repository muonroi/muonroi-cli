import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachRunToPhase,
  createMilestone,
  createPhase,
  ensureRunScoped,
  findPhaseForRun,
  getActivePointer,
  listMilestones,
  listPhases,
  loadMilestone,
  loadPhase,
  setActivePointer,
  updateMilestone,
  updatePhase,
} from "../hierarchy.js";

const NOW = "2026-07-11T00:00:00.000Z";
const LATER = "2026-07-12T00:00:00.000Z";

describe("hierarchy", () => {
  let flowDir: string;

  beforeEach(async () => {
    flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "hierarchy-"));
  });

  afterEach(async () => {
    await fs.rm(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  describe("milestones", () => {
    it("creates a milestone with a sortable slug id + persists json and md", async () => {
      const m = await createMilestone(flowDir, { title: "Native State & EE", goal: "go native" }, NOW);
      expect(m.id).toBe("m01-native-state-ee");
      expect(m.ordinal).toBe(1);
      expect(m.status).toBe("active");
      const json = await fs.readFile(path.join(flowDir, "milestones", m.id, "milestone.json"), "utf8");
      expect(JSON.parse(json).title).toBe("Native State & EE");
      const md = await fs.readFile(path.join(flowDir, "milestones", m.id, "milestone.md"), "utf8");
      expect(md).toContain("# Milestone: Native State & EE");
      expect(md).toContain("_(no phases yet)_");
    });

    it("assigns increasing ordinals and lists sorted", async () => {
      await createMilestone(flowDir, { title: "Beta" }, NOW);
      await createMilestone(flowDir, { title: "Alpha" }, NOW);
      const all = await listMilestones(flowDir);
      expect(all.map((m) => m.ordinal)).toEqual([1, 2]);
      expect(all.map((m) => m.id)).toEqual(["m01-beta", "m02-alpha"]);
    });

    it("updates status + updatedAt", async () => {
      const m = await createMilestone(flowDir, { title: "Ship" }, NOW);
      const updated = await updateMilestone(flowDir, m.id, { status: "done" }, LATER);
      expect(updated?.status).toBe("done");
      expect(updated?.updatedAt).toBe(LATER);
      expect(updated?.createdAt).toBe(NOW);
      expect((await loadMilestone(flowDir, m.id))?.status).toBe("done");
    });

    it("returns [] when no milestones dir exists", async () => {
      expect(await listMilestones(flowDir)).toEqual([]);
    });

    it("returns null loading an unknown milestone", async () => {
      expect(await loadMilestone(flowDir, "m99-nope")).toBeNull();
    });
  });

  describe("phases", () => {
    it("creates phases under a milestone, linking a run", async () => {
      const m = await createMilestone(flowDir, { title: "Core" }, NOW);
      const p = await createPhase(flowDir, m.id, { title: "Scoping", runId: "run-abc" }, NOW);
      expect(p.id).toBe("p01-scoping");
      expect(p.milestoneId).toBe(m.id);
      expect(p.runIds).toEqual(["run-abc"]);
      const md = await fs.readFile(path.join(flowDir, "milestones", m.id, "phases", p.id, "phase.md"), "utf8");
      expect(md).toContain("# Phase: Scoping");
      expect(md).toContain("run-abc");
    });

    it("refreshes the parent milestone.md phase list", async () => {
      const m = await createMilestone(flowDir, { title: "Core" }, NOW);
      await createPhase(flowDir, m.id, { title: "Scoping" }, NOW);
      const md = await fs.readFile(path.join(flowDir, "milestones", m.id, "milestone.md"), "utf8");
      expect(md).toContain("p01-scoping: Scoping");
      expect(md).not.toContain("_(no phases yet)_");
    });

    it("lists phases sorted by ordinal", async () => {
      const m = await createMilestone(flowDir, { title: "Core" }, NOW);
      await createPhase(flowDir, m.id, { title: "First" }, NOW);
      await createPhase(flowDir, m.id, { title: "Second" }, NOW);
      const phases = await listPhases(flowDir, m.id);
      expect(phases.map((p) => p.id)).toEqual(["p01-first", "p02-second"]);
    });

    it("attaches runs idempotently", async () => {
      const m = await createMilestone(flowDir, { title: "Core" }, NOW);
      const p = await createPhase(flowDir, m.id, { title: "Build" }, NOW);
      await attachRunToPhase(flowDir, m.id, p.id, "run-1", LATER);
      await attachRunToPhase(flowDir, m.id, p.id, "run-1", LATER);
      const after = await attachRunToPhase(flowDir, m.id, p.id, "run-2", LATER);
      expect(after?.runIds).toEqual(["run-1", "run-2"]);
    });

    it("updates a phase status", async () => {
      const m = await createMilestone(flowDir, { title: "Core" }, NOW);
      const p = await createPhase(flowDir, m.id, { title: "Build" }, NOW);
      const done = await updatePhase(flowDir, m.id, p.id, { status: "done" }, LATER);
      expect(done?.status).toBe("done");
      expect((await loadPhase(flowDir, m.id, p.id))?.status).toBe("done");
    });

    it("returns [] listing phases for a milestone with none", async () => {
      const m = await createMilestone(flowDir, { title: "Core" }, NOW);
      expect(await listPhases(flowDir, m.id)).toEqual([]);
    });
  });

  describe("ensureRunScoped", () => {
    it("creates milestone + phase + pointers on first call, is idempotent on resume", async () => {
      const first = await ensureRunScoped(
        flowDir,
        { runId: "run-1", milestoneTitle: "Todo App", phaseTitle: "MVP scope" },
        NOW,
      );
      expect(first.milestoneId).toBe("m01-todo-app");
      expect(first.phaseId).toBe("p01-mvp-scope");
      expect(await getActivePointer(flowDir)).toEqual({
        milestoneId: "m01-todo-app",
        phaseId: "p01-mvp-scope",
      });
      // Resume: same run, different clock — must not create a second milestone/phase.
      const again = await ensureRunScoped(
        flowDir,
        { runId: "run-1", milestoneTitle: "Todo App", phaseTitle: "MVP scope" },
        LATER,
      );
      expect(again).toEqual(first);
      expect(await listMilestones(flowDir)).toHaveLength(1);
      expect(await listPhases(flowDir, "m01-todo-app")).toHaveLength(1);
    });

    it("reuses the active milestone for a second run's phase", async () => {
      await ensureRunScoped(flowDir, { runId: "run-1", milestoneTitle: "App", phaseTitle: "First" }, NOW);
      const second = await ensureRunScoped(
        flowDir,
        { runId: "run-2", milestoneTitle: "App", phaseTitle: "Second" },
        NOW,
      );
      expect(second.milestoneId).toBe("m01-app");
      expect(second.phaseId).toBe("p02-second");
      expect(await listMilestones(flowDir)).toHaveLength(1);
      expect(await findPhaseForRun(flowDir, "run-2")).toEqual({ milestoneId: "m01-app", phaseId: "p02-second" });
    });

    it("findPhaseForRun returns null for an unindexed run", async () => {
      expect(await findPhaseForRun(flowDir, "ghost")).toBeNull();
    });
  });

  describe("migrateLegacyRuns", () => {
    it("indexes orphan runs under m00-legacy, is idempotent, skips indexed runs", async () => {
      const { migrateLegacyRuns } = await import("../hierarchy.js");
      // Substantive orphan runs (carry research.md) so they qualify for backfill.
      for (const r of ["run-a", "run-b"]) {
        await fs.mkdir(path.join(flowDir, "runs", r), { recursive: true });
        await fs.writeFile(path.join(flowDir, "runs", r, "research.md"), "# Research\n", "utf8");
      }
      // run-c is already indexed under a real milestone — must not be re-homed.
      const m = await createMilestone(flowDir, { title: "Real" }, NOW);
      await createPhase(flowDir, m.id, { title: "Phase", runId: "run-c" }, NOW);
      await fs.mkdir(path.join(flowDir, "runs", "run-c"), { recursive: true });
      await fs.writeFile(path.join(flowDir, "runs", "run-c", "research.md"), "# Research\n", "utf8");

      const n = await migrateLegacyRuns(flowDir, NOW);
      expect(n).toBe(2);
      const legacy = await listPhases(flowDir, "m00-legacy");
      expect(legacy.map((p) => p.runIds[0])).toEqual(["run-a", "run-b"]);
      const legacyM = await loadMilestone(flowDir, "m00-legacy");
      expect(legacyM?.ordinal).toBe(0);
      expect(legacyM?.status).toBe("archived");
      // run-c stays under the real milestone.
      expect(await findPhaseForRun(flowDir, "run-c")).toEqual({ milestoneId: m.id, phaseId: "p01-phase" });

      // Idempotent: a second call adds nothing.
      expect(await migrateLegacyRuns(flowDir, LATER)).toBe(0);
    });

    it("returns 0 when there is no runs dir", async () => {
      const { migrateLegacyRuns } = await import("../hierarchy.js");
      expect(await migrateLegacyRuns(flowDir, NOW)).toBe(0);
    });

    it("skips skeleton runs (no research/tasks/spec) — F1", async () => {
      const { migrateLegacyRuns } = await import("../hierarchy.js");
      // Skeleton: only base .md files, empty roadmap → must NOT be indexed.
      await fs.mkdir(path.join(flowDir, "runs", "run-skel"), { recursive: true });
      await fs.writeFile(path.join(flowDir, "runs", "run-skel", "roadmap.md"), "", "utf8");
      // Substantive via research.md.
      await fs.mkdir(path.join(flowDir, "runs", "run-research"), { recursive: true });
      await fs.writeFile(path.join(flowDir, "runs", "run-research", "research.md"), "# Research\n", "utf8");
      // Substantive via a Product Specification section in roadmap.md.
      await fs.mkdir(path.join(flowDir, "runs", "run-spec"), { recursive: true });
      await fs.writeFile(path.join(flowDir, "runs", "run-spec", "roadmap.md"), "## Product Specification\n{}", "utf8");

      const n = await migrateLegacyRuns(flowDir, NOW);
      expect(n).toBe(2);
      const legacy = await listPhases(flowDir, "m00-legacy");
      expect(legacy.map((p) => p.runIds[0]).sort()).toEqual(["run-research", "run-spec"]);
      expect(await findPhaseForRun(flowDir, "run-skel")).toBeNull();
    });
  });

  describe("active pointers", () => {
    it("round-trips active milestone + phase through state.md", async () => {
      expect(await getActivePointer(flowDir)).toEqual({ milestoneId: null, phaseId: null });
      await setActivePointer(flowDir, { milestoneId: "m01-core", phaseId: "p01-scoping" });
      expect(await getActivePointer(flowDir)).toEqual({ milestoneId: "m01-core", phaseId: "p01-scoping" });
    });

    it("clears pointers when set to null", async () => {
      await setActivePointer(flowDir, { milestoneId: "m01-core", phaseId: "p01-scoping" });
      await setActivePointer(flowDir, { milestoneId: null, phaseId: null });
      expect(await getActivePointer(flowDir)).toEqual({ milestoneId: null, phaseId: null });
    });
  });
});
