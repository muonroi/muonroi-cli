import { describe, expect, it, vi } from "vitest";
import { buildSprintContext, CONTEXT_CAPS, digestSprintIntoPhase, handoffPhaseToNext } from "../context-policy.js";

const fakeProject = "## Project (permanent)\n" + "x".repeat(200);

describe("buildSprintContext (subsystem E)", () => {
  it("renders all blocks in order under cap", () => {
    const out = buildSprintContext({
      projectContextFormatted: fakeProject,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: {
        id: "phase-1",
        name: "n",
        goal: "g",
        successCriteria: ["A"],
        scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 },
        dependsOn: [],
        maxSprints: 2,
      },
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
      currentPhase: {
        id: "phase-1",
        name: "n",
        goal: "g",
        successCriteria: ["A"],
        scope: "s",
        exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
        dependsOn: [],
        maxSprints: 2,
      },
      phaseDigest: [{ sprintN: 1, timestampUtc: "2026-05-13T00:00:00Z", lessonText: "L" }],
      sprintTail: "tail",
    };
    const a = buildSprintContext(args);
    const b = buildSprintContext(args);
    expect(a).toBe(b);
  });

  it("over cap with essentials fitting: trims sprintTail first", () => {
    const tail = "T".repeat(20000);
    const out = buildSprintContext({
      projectContextFormatted: fakeProject,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: {
        id: "phase-1",
        name: "n",
        goal: "g",
        successCriteria: ["A"],
        scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 },
        dependsOn: [],
        maxSprints: 2,
      },
      phaseDigest: [],
      sprintTail: tail,
    });
    expect(out.length).toBeLessThanOrEqual(CONTEXT_CAPS.SPRINT_CONTEXT_BYTES + 200);
    expect(out).toMatch(/\[…truncated \d+ bytes\]/);
  });

  it("project alone over cap → oversize marker", () => {
    const huge = "## Project\n" + "x".repeat(9000);
    const out = buildSprintContext({
      projectContextFormatted: huge,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: {
        id: "phase-1",
        name: "n",
        goal: "g",
        successCriteria: ["A"],
        scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 },
        dependsOn: [],
        maxSprints: 2,
      },
      phaseDigest: [],
      sprintTail: "",
    });
    expect(out).toContain("[oversize:");
    expect(out).not.toContain("Sprint Tail");
  });

  it("project + customer decisions together over cap → both intact + oversize marker", () => {
    const proj = "## Project\n" + "x".repeat(5000);
    const decisions = Array.from({ length: 50 }, (_, i) => ({
      seq: i + 1,
      timestampUtc: "2026-05-13T00:00:00Z",
      phaseId: "phase-1",
      sprintN: 1,
      verdict: "reject" as const,
      feedback: "Y".repeat(80),
    }));
    const out = buildSprintContext({
      projectContextFormatted: proj,
      customerDecisions: decisions,
      phaseHistory: [],
      currentPhase: {
        id: "phase-1",
        name: "n",
        goal: "g",
        successCriteria: ["A"],
        scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 },
        dependsOn: [],
        maxSprints: 2,
      },
      phaseDigest: [],
      sprintTail: "tail",
    });
    expect(out).toContain("[oversize:");
    for (let i = 1; i <= 50; i++) expect(out).toContain(`seq ${i}`);
  });
});

describe("buildSprintContext truncOldestFirst history path (subsystem E)", () => {
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

  it("large phaseHistory is truncated oldest-first within cap", () => {
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
    // should contain truncation marker and be under total cap with some slack
    expect(out).toMatch(/\[…truncated \d+ oldest entries\]/);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(CONTEXT_CAPS.SPRINT_CONTEXT_BYTES + 300);
  });

  it("single-entry history that is oversized: truncOldestFirst keeps one entry", () => {
    const singleBig = [
      {
        phaseId: "phase-big",
        exitedAtUtc: "2026-05-13T00:00:00Z",
        exitSummary: "X".repeat(9000),
        sprintsExecuted: 1,
        criteriaMetCount: 1,
      },
    ];
    const out = buildSprintContext({
      projectContextFormatted: fakeProject,
      customerDecisions: [],
      phaseHistory: singleBig,
      currentPhase: basePhase,
      phaseDigest: [],
      sprintTail: "",
    });
    // single-entry path: while loop condition `lines.length > 1` exits early, entry stays
    expect(out).toContain("phase-big");
  });
});

describe("digestSprintIntoPhase (subsystem E)", () => {
  it("appends entry when under cap", () => {
    const out = digestSprintIntoPhase([], { sprintN: 1, timestampUtc: "t", lessonText: "L" });
    expect(out).toHaveLength(1);
  });

  it("drops oldest when over cap, adds pruned marker", () => {
    const big: any[] = [];
    for (let i = 0; i < 200; i++) {
      big.push({ sprintN: i, timestampUtc: "2026-05-13T00:00:00Z", lessonText: "X".repeat(40) });
    }
    const out = digestSprintIntoPhase(big, { sprintN: 999, timestampUtc: "t", lessonText: "new" });
    expect(out.length).toBeLessThan(big.length + 1);
    expect(out[0].lessonText).toMatch(/digest pruned/);
    expect(out[out.length - 1].sprintN).toBe(999);
  });

  it("preserves order: newest stays last after pruning", () => {
    const existing = [
      { sprintN: 1, timestampUtc: "t", lessonText: "A".repeat(2000) },
      { sprintN: 2, timestampUtc: "t", lessonText: "B".repeat(2000) },
    ];
    const out = digestSprintIntoPhase(existing, { sprintN: 3, timestampUtc: "t", lessonText: "C" });
    expect(out[out.length - 1].sprintN).toBe(3);
  });

  it("single oversize entry dropped, adds marker + new entry", () => {
    const huge = [{ sprintN: 1, timestampUtc: "t", lessonText: "X".repeat(5000) }];
    const out = digestSprintIntoPhase(huge, { sprintN: 2, timestampUtc: "t", lessonText: "tiny" });
    expect(out.length).toBe(2);
    expect(out[0].sprintN).toBe(-1);
    expect(out[0].lessonText).toMatch(/digest pruned/);
    expect(out[1].sprintN).toBe(2);
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
      capUsd: 10,
      remainingUsd: 1,
      backoffDelays: [1, 1, 1],
    });
    expect(out.exitSummary.length).toBeLessThanOrEqual(300);
    expect(out.usedFallback).toBe(false);
  });

  it("falls back to deterministic when remainingUsd below floor", async () => {
    const leader = { generate: vi.fn() };
    const out = await handoffPhaseToNext({
      phaseId: "phase-1",
      sprintsExecuted: 2,
      criteriaMet: 1,
      totalCriteria: 3,
      leader,
      capUsd: 10,
      remainingUsd: 0.01,
      backoffDelays: [1, 1, 1],
    });
    expect(leader.generate).not.toHaveBeenCalled();
    expect(out.usedFallback).toBe(true);
    expect(out.exitSummary).toContain("phase-1");
    expect(out.exitSummary).toContain("1/3");
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
      capUsd: 10,
      remainingUsd: 1,
      backoffDelays: [1, 1, 1],
    });
    expect(out.usedFallback).toBe(true);
  });
});
