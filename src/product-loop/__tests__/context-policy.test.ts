import { describe, expect, it } from "vitest";
import { buildSprintContext, CONTEXT_CAPS } from "../context-policy.js";

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
