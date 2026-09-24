import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SprintItemDebateItemRecord } from "../../product-loop/item-debate-record.js";
import type { SpecLayoutCheckResult } from "../../product-loop/spec-layout-check.js";
import type { SprintPlanArtifact } from "../../product-loop/sprint-plan-artifact.js";
import { logger } from "../../utils/logger.js";
import {
  parseResumeDigest,
  type ResumeDigest,
  readRunDoc,
  readSpecLayoutCheck,
  readSprintAdherence,
  readSprintItemDebate,
  readSprintOutcomes,
  readSprintPlanArtifact,
  readSprintVerifyFix,
  renderResumeDigest,
  type SprintAdherenceRecord,
  type SprintItemDebateRecord,
  type SprintVerifyFixRecord,
  writeContextDoc,
  writeResearchDoc,
  writeSpecLayoutCheck,
  writeSprintAdherence,
  writeSprintItemDebate,
  writeSprintOutcome,
  writeSprintPlanArtifact,
  writeSprintVerify,
  writeSprintVerifyFix,
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
      // `nextAction` is a real string `deriveNextAction` produces
      // (src/product-loop/next-action.ts) rather than the old "Retry sprint N:
      // <failure>" placeholder: it carries backticks, an em dash and a colon
      // INSIDE the value, which is what `parseResumeDigest`'s `^-\s+([^:]+):`
      // key capture has to stop before.
      const nextAction =
        "Install the module the gate needs for the interpreter it uses, and declare it in that project's manifest: " +
        '`cd backend && ".venv/Scripts/python.exe" -m pytest` never ran — No module named pytest. ' +
        "Until it is installed nothing executes, so re-running sprint 3 produces no evidence either.";
      const d: ResumeDigest = {
        stage: "sprint-3",
        lastCompleted: "sprint-3 retrospective",
        nextAction,
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
      expect(parsed!.nextAction).toBe(nextAction);
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

  describe("sprint adherence — sprints/<n>-adherence.json", () => {
    function fullRecord(): SprintAdherenceRecord {
      return {
        version: 1,
        sprintN: 3,
        runId,
        enabled: true,
        rounds: [
          {
            round: 1,
            reviewerApproved: false,
            deviations: ["[native.ts] wrong LSP op → FIX: call manager.waitForDiagnostics"],
            fixRan: true,
            fixOutcome: { success: true, summary: "applied the fix" },
          },
          {
            round: 2,
            reviewerApproved: true,
            deviations: [],
            fixRan: false,
          },
        ],
        finalVerdict: true,
        residualDeviations: [],
        stopReason: "approved",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        startedAt: "2026-07-12T00:00:00.000Z",
        finishedAt: "2026-07-12T00:01:00.000Z",
      };
    }

    it("round-trip: the reader returns exactly what the writer wrote", async () => {
      const record = fullRecord();
      const wrote = await writeSprintAdherence(flowDir, runId, record);
      expect(wrote).toBe(true);

      const readBack = await readSprintAdherence(flowDir, runId, 3);
      expect(readBack).toEqual(record);
    });

    it("round-trips an error-stop record, including the optional errorMessage field", async () => {
      const record: SprintAdherenceRecord = {
        version: 1,
        sprintN: 5,
        runId,
        enabled: true,
        rounds: [],
        finalVerdict: false,
        residualDeviations: [],
        stopReason: "error",
        startedAt: "2026-07-12T00:00:00.000Z",
        finishedAt: "2026-07-12T00:00:05.000Z",
        errorMessage: "isolated task deadline exceeded",
      };
      await writeSprintAdherence(flowDir, runId, record);
      const readBack = await readSprintAdherence(flowDir, runId, 5);
      expect(readBack).toEqual(record);
      expect(readBack?.reviewModelId).toBeUndefined();
    });

    it("readSprintAdherence returns null when the file is absent", async () => {
      expect(await readSprintAdherence(flowDir, runId, 99)).toBeNull();
    });

    it("a store write failure is logged and returns false without throwing", async () => {
      // Collide the sprints dir path with a plain file so fs.mkdir(..., {recursive:true})
      // fails with a real I/O error (ENOTDIR/EEXIST) instead of a mocked one.
      const runDir = path.join(flowDir, "runs", runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, "sprints"), "not a directory", "utf8");

      const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const record = fullRecord();
        record.sprintN = 7;
        const wrote = await writeSprintAdherence(flowDir, runId, record);
        expect(wrote).toBe(false);
        expect(errSpy).toHaveBeenCalledWith(
          "orchestrator",
          expect.stringContaining("[adherence]"),
          expect.objectContaining({ runId, sprintN: 7 }),
        );
      } finally {
        errSpy.mockRestore();
        await fs.rm(path.join(runDir, "sprints"), { force: true });
      }
    });
  });

  describe("sprint plan artifact — sprints/<n>-plan.json", () => {
    function fullArtifact(): SprintPlanArtifact {
      return {
        version: 1,
        sprintN: 1,
        runId,
        planHash: "deadbeef".repeat(8),
        source: "structured",
        outcome: { goal: "ship the widget analyzer", acceptance: ["warnings show in Visual Studio"] },
        tasks: [
          {
            id: "step1",
            title: "set up the project",
            doneCriterion: "builds",
            dependsOn: [],
            targetFiles: ["src/Acme.sln"],
            targetDirs: ["src/Acme.Widgets"],
            owner: "Eng",
            estimate: "2h",
            priority: "high",
            status: "pending",
          },
        ],
        notes: [],
      };
    }

    it("round-trip: the reader returns exactly what the writer wrote", async () => {
      const artifact = fullArtifact();
      const wrote = await writeSprintPlanArtifact(flowDir, runId, artifact);
      expect(wrote).toBe(true);

      const readBack = await readSprintPlanArtifact(flowDir, runId, 1);
      expect(readBack).toEqual(artifact);
    });

    it("readSprintPlanArtifact returns null when the file is absent", async () => {
      expect(await readSprintPlanArtifact(flowDir, runId, 99)).toBeNull();
    });

    it("a store write failure is logged and returns false without throwing", async () => {
      // Collide the sprints dir path with a plain file so fs.mkdir(..., {recursive:true})
      // fails with a real I/O error, mirroring the adherence-store test above.
      const runDir = path.join(flowDir, "runs", runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, "sprints"), "not a directory", "utf8");

      const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const artifact = fullArtifact();
        artifact.sprintN = 8;
        const wrote = await writeSprintPlanArtifact(flowDir, runId, artifact);
        expect(wrote).toBe(false);
        expect(errSpy).toHaveBeenCalledWith(
          "orchestrator",
          expect.stringContaining("[sprint-plan]"),
          expect.objectContaining({ runId, sprintN: 8 }),
        );
      } finally {
        errSpy.mockRestore();
        await fs.rm(path.join(runDir, "sprints"), { force: true });
      }
    });
  });

  describe("sprint verify-fix — sprints/<n>-verify-fix.json", () => {
    function fullRecord(): SprintVerifyFixRecord {
      return {
        version: 1,
        sprintN: 4,
        runId,
        enabled: true,
        triggered: true,
        rounds: [
          {
            round: 1,
            failureKeyBefore: "engineering_floor:build_run_introduced:error NU1107",
            fixerRan: true,
            fixerSuccess: true,
            fixerSummary: "reverted the package downgrade",
            verifyVerdictAfter: "PASS",
            failureKeyAfter: "engineering_floor:build_run_introduced:error NU1107",
          },
        ],
        stopReason: "pass",
        fixModelId: "cheap-flash",
        taskStatusRefresh: {
          ran: false,
          reason: "re-running the plan-adherence per-task reviewer costs another LLM call",
        },
        startedAt: "2026-09-17T00:00:00.000Z",
        finishedAt: "2026-09-17T00:01:00.000Z",
      };
    }

    it("round-trip: the reader returns exactly what the writer wrote", async () => {
      const record = fullRecord();
      const wrote = await writeSprintVerifyFix(flowDir, runId, record);
      expect(wrote).toBe(true);

      const readBack = await readSprintVerifyFix(flowDir, runId, 4);
      expect(readBack).toEqual(record);
    });

    it("round-trips a disabled record", async () => {
      const record: SprintVerifyFixRecord = {
        version: 1,
        sprintN: 6,
        runId,
        enabled: false,
        triggered: false,
        rounds: [],
        stopReason: "disabled",
        startedAt: "2026-09-17T00:00:00.000Z",
        finishedAt: "2026-09-17T00:00:01.000Z",
      };
      await writeSprintVerifyFix(flowDir, runId, record);
      const readBack = await readSprintVerifyFix(flowDir, runId, 6);
      expect(readBack).toEqual(record);
      expect(readBack?.fixModelId).toBeUndefined();
    });

    it("readSprintVerifyFix returns null when the file is absent", async () => {
      expect(await readSprintVerifyFix(flowDir, runId, 99)).toBeNull();
    });

    it("a store write failure is logged and returns false without throwing", async () => {
      // Same real-I/O-error technique as the adherence/plan-artifact stores above.
      const runDir = path.join(flowDir, "runs", runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, "sprints"), "not a directory", "utf8");

      const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const record = fullRecord();
        record.sprintN = 9;
        const wrote = await writeSprintVerifyFix(flowDir, runId, record);
        expect(wrote).toBe(false);
        expect(errSpy).toHaveBeenCalledWith(
          "orchestrator",
          expect.stringContaining("[verify-fix]"),
          expect.objectContaining({ runId, sprintN: 9 }),
        );
      } finally {
        errSpy.mockRestore();
        await fs.rm(path.join(runDir, "sprints"), { force: true });
      }
    });
  });

  describe("spec-layout-check — spec-layout-check.json (S7)", () => {
    function mismatchResult(): SpecLayoutCheckResult {
      return {
        status: "mismatch",
        findings: [{ path: "src/Acme.CodeStandards", expectedRoot: "src/src", kind: "project" }],
      };
    }

    it("round-trip: the reader returns exactly what the writer wrote", async () => {
      const result = mismatchResult();
      const wrote = await writeSpecLayoutCheck(flowDir, runId, result);
      expect(wrote).toBe(true);

      const readBack = await readSpecLayoutCheck(flowDir, runId);
      expect(readBack).toEqual(result);
    });

    it("round-trips an ok status with no findings", async () => {
      const result: SpecLayoutCheckResult = { status: "ok", findings: [] };
      await writeSpecLayoutCheck(flowDir, runId, result);
      const readBack = await readSpecLayoutCheck(flowDir, runId);
      expect(readBack).toEqual(result);
    });

    it("readSpecLayoutCheck returns null when the file is absent", async () => {
      expect(await readSpecLayoutCheck(flowDir, runId)).toBeNull();
    });

    it("a write failure is logged and returns false without throwing", async () => {
      // Same real-I/O-error technique as the verify-fix store above, mirrored:
      // put a DIRECTORY where the writer expects to rename a FILE into place.
      const runDir = path.join(flowDir, "runs", runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.mkdir(path.join(runDir, "spec-layout-check.json"), { recursive: true });

      const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const wrote = await writeSpecLayoutCheck(flowDir, runId, mismatchResult());
        expect(wrote).toBe(false);
        expect(errSpy).toHaveBeenCalledWith(
          "orchestrator",
          expect.stringContaining("[spec-layout-check]"),
          expect.objectContaining({ runId }),
        );
      } finally {
        errSpy.mockRestore();
        await fs.rm(path.join(runDir, "spec-layout-check.json"), { recursive: true, force: true });
      }
    });

    it("a read failure (unparseable JSON) is logged and returns null without throwing", async () => {
      const runDir = path.join(flowDir, "runs", runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, "spec-layout-check.json"), "{not json", "utf8");

      const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const readBack = await readSpecLayoutCheck(flowDir, runId);
        expect(readBack).toBeNull();
        expect(errSpy).toHaveBeenCalledWith(
          "orchestrator",
          expect.stringContaining("[spec-layout-check]"),
          expect.objectContaining({ runId }),
        );
      } finally {
        errSpy.mockRestore();
        await fs.rm(path.join(runDir, "spec-layout-check.json"), { force: true });
      }
    });
  });

  describe("sprint item debate — sprints/<n>-item-debate.json (C3)", () => {
    function item(overrides: Partial<SprintItemDebateItemRecord> = {}): SprintItemDebateItemRecord {
      return {
        kind: "task",
        taskId: "step3",
        title: "Implement the rate limiter",
        selectionSignal: "vague-criterion",
        selectionReason: "Task step3 has no done criterion at all.",
        positions: [
          { role: "engineer", stance: "supports tightening the criterion" },
          { role: "skeptic", stance: "wants a concrete test command named" },
        ],
        leaderRuling: "The criterion is too vague; tighten it.",
        changeKind: "criterion",
        proposedChange: { criterionText: "dotnet test src/Sample.Tests passes with 0 failures" },
        ...overrides,
      };
    }

    function fullRecord(): SprintItemDebateRecord {
      return {
        version: 1,
        sprintN: 4,
        runId,
        enabled: true,
        items: [item(), item({ taskId: "step5", kind: "task", changeKind: "none", proposedChange: undefined })],
        stopReason: "completed",
        leaderModelId: "leader-pro",
        panelModelIds: ["panelist-a", "panelist-b"],
        startedAt: "2026-08-01T00:00:00.000Z",
        finishedAt: "2026-08-01T00:02:00.000Z",
      };
    }

    it("round-trip: the reader returns exactly what the writer wrote", async () => {
      const record = fullRecord();
      const wrote = await writeSprintItemDebate(flowDir, runId, record);
      expect(wrote).toBe(true);

      const readBack = await readSprintItemDebate(flowDir, runId, 4);
      expect(readBack).toEqual(record);
    });

    it("round-trips a disabled record with no items", async () => {
      const record: SprintItemDebateRecord = {
        version: 1,
        sprintN: 6,
        runId,
        enabled: false,
        items: [],
        stopReason: "disabled",
        startedAt: "2026-08-01T00:00:00.000Z",
        finishedAt: "2026-08-01T00:00:00.000Z",
      };
      await writeSprintItemDebate(flowDir, runId, record);
      const readBack = await readSprintItemDebate(flowDir, runId, 6);
      expect(readBack).toEqual(record);
      expect(readBack?.leaderModelId).toBeUndefined();
    });

    it("readSprintItemDebate returns null when the file is absent", async () => {
      expect(await readSprintItemDebate(flowDir, runId, 99)).toBeNull();
    });

    it("a store write failure is logged and returns false without throwing", async () => {
      // Same real-I/O-error technique as the adherence store above: collide
      // the sprints dir path with a plain file so fs.mkdir(recursive:true)
      // fails with a real ENOTDIR instead of a mocked one.
      const runDir = path.join(flowDir, "runs", runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, "sprints"), "not a directory", "utf8");

      const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const record = fullRecord();
        record.sprintN = 8;
        const wrote = await writeSprintItemDebate(flowDir, runId, record);
        expect(wrote).toBe(false);
        expect(errSpy).toHaveBeenCalledWith(
          "orchestrator",
          expect.stringContaining("[item-debate]"),
          expect.objectContaining({ runId, sprintN: 8 }),
        );
      } finally {
        errSpy.mockRestore();
        await fs.rm(path.join(runDir, "sprints"), { force: true });
      }
    });

    it("a read failure (unparseable JSON) is logged and returns null without throwing", async () => {
      const dir = path.join(flowDir, "runs", runId, "sprints");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "9-item-debate.json"), "{not json", "utf8");

      const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const readBack = await readSprintItemDebate(flowDir, runId, 9);
        expect(readBack).toBeNull();
        expect(errSpy).toHaveBeenCalledWith(
          "orchestrator",
          expect.stringContaining("[item-debate]"),
          expect.objectContaining({ runId, sprintN: 9 }),
        );
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});
