import { describe, expect, it, vi } from "vitest";
import { buildSprintContext, digestSprintIntoPhase, handoffPhaseToNext } from "../context-policy.js";

// The sprint context used to be squeezed into byte budgets (8,192 bytes total,
// 4,096 for the phase digest, oldest entries dropped first, `[oversize:]` and
// `[…truncated]` markers). Those were character budgets, not a context-window
// guard, and `/ideal` has no limits (user decision). The tests that pinned the
// truncation now pin the opposite: every block is kept whole, in order.

const fakeProject = `## Project (permanent)\n${"x".repeat(200)}`;
const basePhase = {
  id: "phase-1",
  name: "n",
  goal: "g",
  successCriteria: ["A"],
  scope: "s",
  exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
  dependsOn: [],
  maxSprints: 2,
};

describe("buildSprintContext (subsystem E)", () => {
  it("renders all blocks in order", () => {
    const out = buildSprintContext({
      projectContextFormatted: fakeProject,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: basePhase,
      phaseDigest: [],
      sprintTail: "## Sprint Tail\nrecent work",
    });
    expect(out.indexOf("Project")).toBeLessThan(out.indexOf("Customer Decisions"));
    expect(out.indexOf("Customer Decisions")).toBeLessThan(out.indexOf("Phase History"));
    expect(out.indexOf("Phase History")).toBeLessThan(out.indexOf("Current Phase"));
    expect(out.indexOf("Current Phase")).toBeLessThan(out.indexOf("Phase Digest"));
    expect(out.indexOf("Phase Digest")).toBeLessThan(out.indexOf("Sprint Tail"));
  });

  it("determinism: same inputs produce same output", () => {
    const args = {
      projectContextFormatted: fakeProject,
      customerDecisions: [
        { seq: 1, timestampUtc: "2026-05-13T00:00:00Z", phaseId: "phase-1", sprintN: 1, verdict: "accept" as const },
      ],
      phaseHistory: [],
      currentPhase: basePhase,
      phaseDigest: [{ sprintN: 1, timestampUtc: "2026-05-13T00:00:00Z", lessonText: "L" }],
      sprintTail: "tail",
    };
    expect(buildSprintContext(args)).toBe(buildSprintContext(args));
  });

  it("a large sprint tail is kept whole (was trimmed to fit 8,192 bytes)", () => {
    const tail = "T".repeat(20000);
    const out = buildSprintContext({
      projectContextFormatted: fakeProject,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: basePhase,
      phaseDigest: [],
      sprintTail: tail,
    });
    expect(out).toContain(tail);
    expect(out).not.toMatch(/truncated/);
  });

  it("a large project context keeps every other block too (was an [oversize:] marker)", () => {
    const huge = `## Project\n${"x".repeat(9000)}`;
    const out = buildSprintContext({
      projectContextFormatted: huge,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: basePhase,
      phaseDigest: [],
      sprintTail: "",
    });
    expect(out).toContain(huge);
    expect(out).toContain("Sprint Tail");
    expect(out).not.toContain("[oversize:");
  });

  it("every customer decision is kept verbatim", () => {
    const decisions = Array.from({ length: 50 }, (_, i) => ({
      seq: i + 1,
      timestampUtc: "2026-05-13T00:00:00Z",
      phaseId: "phase-1",
      sprintN: 1,
      verdict: "reject" as const,
      feedback: "Y".repeat(80),
    }));
    const out = buildSprintContext({
      projectContextFormatted: `## Project\n${"x".repeat(5000)}`,
      customerDecisions: decisions,
      phaseHistory: [],
      currentPhase: basePhase,
      phaseDigest: [],
      sprintTail: "tail",
    });
    for (let i = 1; i <= 50; i++) expect(out).toContain(`seq ${i}`);
    expect(out).not.toContain("[oversize:");
  });

  it("a large phase history is kept whole, oldest entry included", () => {
    const bigHistory = Array.from({ length: 100 }, (_, i) => ({
      phaseId: `phase-${i}`,
      exitedAtUtc: "2026-05-13T00:00:00Z",
      exitSummary: "S".repeat(80),
      sprintsExecuted: 1,
      criteriaMetCount: 1,
    }));
    const out = buildSprintContext({
      projectContextFormatted: fakeProject,
      customerDecisions: [],
      phaseHistory: bigHistory,
      currentPhase: basePhase,
      phaseDigest: [],
      sprintTail: "",
    });
    expect(out).toContain("phase-0 (exited");
    expect(out).toContain("phase-99 (exited");
    expect(out).not.toMatch(/truncated/);
  });
});

describe("digestSprintIntoPhase (subsystem E)", () => {
  it("appends an entry", () => {
    expect(digestSprintIntoPhase([], { sprintN: 1, timestampUtc: "t", lessonText: "L" })).toHaveLength(1);
  });

  it("never prunes: every earlier entry stays and the newest is last (was pruned to 4,096 bytes)", () => {
    const big = Array.from({ length: 200 }, (_, i) => ({
      sprintN: i,
      timestampUtc: "2026-05-13T00:00:00Z",
      lessonText: "X".repeat(40),
    }));
    const out = digestSprintIntoPhase(big, { sprintN: 999, timestampUtc: "t", lessonText: "new" });
    expect(out).toHaveLength(201);
    expect(out[0].sprintN).toBe(0);
    expect(out[out.length - 1].sprintN).toBe(999);
    expect(out.some((e) => /digest pruned/.test(e.lessonText))).toBe(false);
  });

  it("an oversized entry is kept alongside the new one", () => {
    const huge = [{ sprintN: 1, timestampUtc: "t", lessonText: "X".repeat(5000) }];
    const out = digestSprintIntoPhase(huge, { sprintN: 2, timestampUtc: "t", lessonText: "tiny" });
    expect(out.map((e) => e.sprintN)).toEqual([1, 2]);
  });
});

describe("handoffPhaseToNext (subsystem E)", () => {
  it("happy path uses leader summary truncated to 300 chars", async () => {
    const leader = {
      generate: vi.fn().mockResolvedValue({ content: "All good carry over X.".repeat(50), costUsd: 0.05 }),
    };
    const out = await handoffPhaseToNext({
      phaseId: "phase-1",
      sprintsExecuted: 2,
      criteriaMet: 3,
      totalCriteria: 3,
      leader,
      backoffDelays: [1, 1, 1],
    });
    expect(out.exitSummary.length).toBeLessThanOrEqual(300);
    expect(out.usedFallback).toBe(false);
  });

  it("falls back on 3 429s", async () => {
    const err: any = new Error("429");
    err.status = 429;
    const leader = { generate: vi.fn().mockRejectedValue(err) };
    const out = await handoffPhaseToNext({
      phaseId: "phase-2",
      sprintsExecuted: 5,
      criteriaMet: 2,
      totalCriteria: 2,
      leader,
      backoffDelays: [1, 1, 1],
    });
    expect(out.usedFallback).toBe(true);
    expect(out.exitSummary).toContain("phase-2");
    expect(out.exitSummary).toContain("2/2");
  });
});
