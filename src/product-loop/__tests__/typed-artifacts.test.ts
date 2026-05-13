import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendDecisions,
  appendRisks,
  type DecisionArtifact,
  deriveTasksFromSpec,
  parseDecisionsJson,
  parseRisksJson,
  type RiskArtifact,
  readCriteriaSnapshot,
  readDecisions,
  readRisks,
  readTasks,
  syncCriteriaSnapshot,
  type TaskArtifact,
  updateTaskStatus,
  writeTasks,
} from "../typed-artifacts.js";
import type { Criterion, ProductSpec } from "../types.js";

function makeSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    idea: "Test idea",
    persona: "Test user",
    mvp: ["feature A", "feature B"],
    phase2: ["feature C"],
    architecture: "test",
    ioContract: "test",
    folderStructure: "test",
    sprintEstimate: 2,
    costEstimate: 20,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("typed-artifacts (P8)", () => {
  let flowDir: string;
  const runId = "run-test";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `typed-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
  });

  describe("deriveTasksFromSpec", () => {
    it("creates one task per mvp + phase2 feature with stable ids", () => {
      const tasks = deriveTasksFromSpec(makeSpec());
      expect(tasks.length).toBe(3);
      expect(tasks[0].id).toBe("t_mvp_01");
      expect(tasks[1].id).toBe("t_mvp_02");
      expect(tasks[2].id).toBe("t_p2_01");
      expect(tasks[0].title).toBe("feature A");
      expect(tasks[2].source).toBe("phase2");
    });

    it("links mvp tasks in sequence and phase2 onto last mvp", () => {
      const tasks = deriveTasksFromSpec(makeSpec());
      expect(tasks[0].dependencies).toEqual([]);
      expect(tasks[1].dependencies).toEqual(["t_mvp_01"]);
      expect(tasks[2].dependencies).toEqual(["t_mvp_02"]);
    });

    it("handles empty mvp+phase2 gracefully", () => {
      const tasks = deriveTasksFromSpec(makeSpec({ mvp: [], phase2: [] }));
      expect(tasks).toEqual([]);
    });

    it("re-derivation is idempotent in id space", () => {
      const t1 = deriveTasksFromSpec(makeSpec());
      const t2 = deriveTasksFromSpec(makeSpec());
      expect(t1.map((t) => t.id)).toEqual(t2.map((t) => t.id));
    });
  });

  describe("tasks IO", () => {
    it("writes and reads tasks.json with version envelope", async () => {
      const tasks = deriveTasksFromSpec(makeSpec());
      await writeTasks(flowDir, runId, tasks);
      const file = path.join(flowDir, "runs", runId, "tasks.json");
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      expect(raw.version).toBe(1);
      expect(raw.items.length).toBe(3);
      const read = await readTasks(flowDir, runId);
      expect(read.length).toBe(3);
    });

    it("returns empty array when file missing", async () => {
      const tasks = await readTasks(flowDir, "never-existed");
      expect(tasks).toEqual([]);
    });

    it("updateTaskStatus mutates only the target task", async () => {
      const tasks = deriveTasksFromSpec(makeSpec());
      await writeTasks(flowDir, runId, tasks);
      await updateTaskStatus(flowDir, runId, "t_mvp_01", "done");
      const updated = await readTasks(flowDir, runId);
      const done = updated.find((t) => t.id === "t_mvp_01");
      const pending = updated.find((t) => t.id === "t_mvp_02");
      expect(done?.status).toBe("done");
      expect(pending?.status).toBe("pending");
    });

    it("updateTaskStatus is a no-op for missing id", async () => {
      const tasks = deriveTasksFromSpec(makeSpec());
      await writeTasks(flowDir, runId, tasks);
      await updateTaskStatus(flowDir, runId, "t_nonexistent", "done");
      const updated = await readTasks(flowDir, runId);
      expect(updated.every((t) => t.status === "pending")).toBe(true);
    });
  });

  describe("decisions IO", () => {
    it("appendDecisions dedupes by id", async () => {
      const d: DecisionArtifact = {
        id: "d_test",
        question: "Sync or async?",
        choice: "Sync",
        alternatives: ["Async"],
        rationale: "simpler",
        reversibility: "moderate",
        madeAt: { phase: "scoping" },
      };
      await appendDecisions(flowDir, runId, [d]);
      const merged = await appendDecisions(flowDir, runId, [d]);
      expect(merged.length).toBe(1);
    });

    it("appendDecisions does not overwrite existing entries", async () => {
      const d1: DecisionArtifact = {
        id: "d_same",
        question: "Same question",
        choice: "Choice A",
        alternatives: [],
        rationale: "first",
        reversibility: "easy",
        madeAt: { phase: "research" },
      };
      const d2: DecisionArtifact = {
        ...d1,
        choice: "Choice B (changed)",
        rationale: "second",
      };
      await appendDecisions(flowDir, runId, [d1]);
      const merged = await appendDecisions(flowDir, runId, [d2]);
      expect(merged.length).toBe(1);
      expect(merged[0].choice).toBe("Choice A");
    });
  });

  describe("risks IO", () => {
    it("appendRisks persists with version envelope", async () => {
      const r: RiskArtifact = {
        id: "r_test",
        description: "API may rate-limit",
        likelihood: "high",
        impact: "medium",
        mitigation: "exponential backoff + retry",
        owner: "Implementer",
        status: "open",
      };
      await appendRisks(flowDir, runId, [r]);
      const read = await readRisks(flowDir, runId);
      expect(read.length).toBe(1);
      expect(read[0].likelihood).toBe("high");
    });
  });

  describe("criteria snapshot", () => {
    it("syncCriteriaSnapshot mirrors all fields", async () => {
      const criteria: Criterion[] = [
        { id: "c1", status: "met", evidence: "test.ts:10 PASS", sprint: 1 },
        { id: "c2", status: "unmet" },
      ];
      await syncCriteriaSnapshot(flowDir, runId, criteria);
      const snap = await readCriteriaSnapshot(flowDir, runId);
      expect(snap.length).toBe(2);
      expect(snap[0].evidence).toBe("test.ts:10 PASS");
      expect(snap[1].evidence).toBeUndefined();
    });
  });

  describe("parseDecisionsJson", () => {
    it("parses well-formed array", () => {
      const raw = JSON.stringify([
        {
          question: "Framework?",
          choice: "React",
          alternatives: ["Vue", "Svelte"],
          rationale: "team familiarity",
          reversibility: "hard",
        },
      ]);
      const out = parseDecisionsJson(raw);
      expect(out.length).toBe(1);
      expect(out[0].choice).toBe("React");
      expect(out[0].reversibility).toBe("hard");
      expect(out[0].id.startsWith("d_")).toBe(true);
    });

    it("strips markdown code fences", () => {
      const raw = '```json\n[{"question":"Q","choice":"C"}]\n```';
      const out = parseDecisionsJson(raw);
      expect(out.length).toBe(1);
    });

    it("defaults reversibility to moderate on invalid value", () => {
      const raw = JSON.stringify([{ question: "Q", choice: "C", reversibility: "unknown" }]);
      const out = parseDecisionsJson(raw);
      expect(out[0].reversibility).toBe("moderate");
    });

    it("returns [] on parse failure", () => {
      expect(parseDecisionsJson("not json")).toEqual([]);
      expect(parseDecisionsJson("{}")).toEqual([]);
    });

    it("skips entries missing required fields", () => {
      const raw = JSON.stringify([
        { question: "Q1", choice: "C1" },
        { question: "Q2" }, // missing choice
        { choice: "C3" }, // missing question
      ]);
      const out = parseDecisionsJson(raw);
      expect(out.length).toBe(1);
      expect(out[0].question).toBe("Q1");
    });
  });

  describe("parseRisksJson", () => {
    it("parses with likelihood and impact normalization", () => {
      const raw = JSON.stringify([
        {
          description: "Provider may go down",
          likelihood: "high",
          impact: "high",
          mitigation: "fallback provider",
          owner: "Implementer",
        },
      ]);
      const out = parseRisksJson(raw);
      expect(out.length).toBe(1);
      expect(out[0].likelihood).toBe("high");
      expect(out[0].status).toBe("open");
    });

    it("defaults likelihood/impact to medium when invalid", () => {
      const raw = JSON.stringify([{ description: "Some risk", likelihood: "bad", impact: "worse" }]);
      const out = parseRisksJson(raw);
      expect(out[0].likelihood).toBe("medium");
      expect(out[0].impact).toBe("medium");
    });

    it("returns [] on malformed input", () => {
      expect(parseRisksJson("```")).toEqual([]);
    });
  });
});
