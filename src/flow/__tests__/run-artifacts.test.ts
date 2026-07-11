import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseResumeDigest,
  type ResumeDigest,
  readRunDoc,
  readSprintOutcomes,
  renderResumeDigest,
  writeContextDoc,
  writeResearchDoc,
  writeSprintOutcome,
  writeSprintVerify,
} from "../run-artifacts.js";

describe("run-artifacts", () => {
  let flowDir: string;
  const runId = "run-test-1";

  beforeEach(async () => {
    flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-artifacts-"));
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  describe("ResumeDigest round-trip", () => {
    it("renders then parses back all fields", () => {
      const d: ResumeDigest = {
        stage: "sprint-3",
        lastCompleted: "sprint-3 retrospective",
        nextAction: "Retry sprint 3: verify_failed",
        sprintN: 3,
        score: 0.72,
        verify: "FAIL",
        openQuestions: ["Is the auth flow covered?", "Perf budget met?"],
        eeSnapshot: "- prefer bun test over vitest for speed",
        updatedAt: "2026-07-11T00:00:00.000Z",
      };
      const parsed = parseResumeDigest(renderResumeDigest(d));
      expect(parsed).not.toBeNull();
      expect(parsed!.stage).toBe("sprint-3");
      expect(parsed!.lastCompleted).toBe("sprint-3 retrospective");
      expect(parsed!.nextAction).toBe("Retry sprint 3: verify_failed");
      expect(parsed!.sprintN).toBe(3);
      expect(parsed!.score).toBeCloseTo(0.72, 2);
      expect(parsed!.verify).toBe("FAIL");
      expect(parsed!.openQuestions).toEqual(["Is the auth flow covered?", "Perf budget met?"]);
      expect(parsed!.eeSnapshot).toContain("prefer bun test");
    });

    it("returns null for an empty or legacy one-line digest", () => {
      expect(parseResumeDigest(undefined)).toBeNull();
      expect(parseResumeDigest("")).toBeNull();
      // Legacy one-liner had no `- Stage:` bullet.
      expect(parseResumeDigest("Stage: Research - Multi-expert debate")).toBeNull();
    });

    it("parses a minimal digest with only stage + nextAction", () => {
      const parsed = parseResumeDigest(renderResumeDigest({ stage: "research", nextAction: "run debate" }));
      expect(parsed!.stage).toBe("research");
      expect(parsed!.nextAction).toBe("run debate");
      expect(parsed!.sprintN).toBeUndefined();
    });
  });

  describe("research.md / context.md", () => {
    it("writes research.md with summary + findings + seed", async () => {
      await writeResearchDoc(flowDir, runId, {
        summary: "debate reached consensus on native store",
        findings: "| file | line |\n|---|---|",
        eeSeed: "recall: prior run picked SQLite",
      });
      const doc = await readRunDoc(flowDir, runId, "research.md");
      expect(doc).toContain("# Research");
      expect(doc).toContain("Experience seed");
      expect(doc).toContain("debate reached consensus");
      expect(doc).toContain("Findings");
    });

    it("writes context.md and tolerates empty content", async () => {
      await writeContextDoc(flowDir, runId, "");
      const doc = await readRunDoc(flowDir, runId, "context.md");
      expect(doc).toContain("(no prior context)");
    });

    it("readRunDoc returns null for an absent file", async () => {
      expect(await readRunDoc(flowDir, runId, "nope.md")).toBeNull();
    });
  });

  describe("sprint outcomes", () => {
    it("writes and reads sprint outcomes sorted by sprint number", async () => {
      await writeSprintOutcome(flowDir, runId, {
        sprintN: 2,
        pass: false,
        score: 0.5,
        verify: "FAIL",
        failedCondition: "verify_failed",
        criteriaMet: 1,
        criteriaPartial: 1,
        criteriaUnmet: 2,
        finishedAt: "2026-07-11T00:00:00.000Z",
      });
      await writeSprintOutcome(flowDir, runId, {
        sprintN: 1,
        pass: true,
        score: 0.95,
        verify: "PASS",
        criteriaMet: 4,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        finishedAt: "2026-07-11T00:00:00.000Z",
      });
      await writeSprintVerify(flowDir, runId, 1, "# Sprint 1 verify — PASS");

      const outcomes = await readSprintOutcomes(flowDir, runId);
      expect(outcomes.map((o) => o.sprintN)).toEqual([1, 2]);
      expect(outcomes[0].pass).toBe(true);
      expect(outcomes[1].failedCondition).toBe("verify_failed");

      const verifyMd = await readRunDoc(flowDir, runId, path.join("sprints", "1-verify.md"));
      expect(verifyMd).toContain("Sprint 1 verify");
    });

    it("returns [] when no sprints dir exists", async () => {
      expect(await readSprintOutcomes(flowDir, runId)).toEqual([]);
    });
  });
});
