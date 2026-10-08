import { describe, expect, it } from "vitest";
import type { SprintOutcome } from "../../flow/run-artifacts.js";
import { deriveRunVerdict, runIsTerminal } from "../run-verdict.js";

/**
 * Defect 1 — the run-level verdict must be derived, never asserted.
 *
 * Ground truth this suite is modelled on: run `mtpd7mf19b10`. Its two recorded
 * sprint outcomes both read `{pass:false, score:0, verify:"UNKNOWN",
 * failedCondition:"engineering_floor"}` and its resume digest read
 * `Score: 0.00 / Next action: Retry sprint 1: engineering_floor`, yet its
 * manifest was written `VerdictPass: true  VerdictScore: 1  VerdictReason:
 * phases_complete` — a literal, derived from nothing.
 */
function outcome(over: Partial<SprintOutcome> & { sprintN: number }): SprintOutcome {
  return {
    pass: false,
    score: 0,
    verify: "UNKNOWN",
    criteriaMet: 0,
    criteriaPartial: 0,
    criteriaUnmet: 1,
    finishedAt: `2026-09-06T05:0${over.sprintN}:00.000Z`,
    ...over,
  };
}

describe("deriveRunVerdict", () => {
  it("does NOT report pass/1 when every sprint failed its engineering floor", () => {
    // The exact shape of mtpd7mf19b10's sprints/1-outcome.json + 2-outcome.json.
    const v = deriveRunVerdict({
      outcomes: [
        outcome({ sprintN: 1, failedCondition: "engineering_floor", finishedAt: "2026-09-06T05:55:56.837Z" }),
        outcome({ sprintN: 2, failedCondition: "engineering_floor", finishedAt: "2026-09-06T05:54:46.832Z" }),
      ],
      phasesPassed: true,
    });
    expect(v.pass).toBe(false);
    expect(v.score).not.toBe(1);
    expect(v.score).toBe(0);
    expect(v.failedCondition).toBe("engineering_floor");
    expect(v.reason).toContain("engineering_floor");
  });

  it("refuses to pass a run that recorded no sprint outcomes at all", () => {
    const v = deriveRunVerdict({ outcomes: [], phasesPassed: true });
    expect(v.pass).toBe(false);
    expect(v.score).toBe(0);
    expect(v.reason).toBe("no_sprint_outcomes");
  });

  it("passes when the latest sprint passed, scoring it from that sprint", () => {
    const v = deriveRunVerdict({
      outcomes: [
        outcome({ sprintN: 1, pass: true, score: 0.95, verify: "PASS", criteriaMet: 1, criteriaUnmet: 0 }),
      ],
      phasesPassed: true,
    });
    expect(v.pass).toBe(true);
    expect(v.score).toBe(0.95);
  });

  it("passes when an early sprint failed but the latest one recovered, and says so", () => {
    const v = deriveRunVerdict({
      outcomes: [
        outcome({ sprintN: 1, finishedAt: "2026-09-06T05:10:00.000Z", failedCondition: "engineering_floor" }),
        outcome({
          sprintN: 2,
          pass: true,
          score: 1,
          verify: "PASS",
          criteriaMet: 1,
          criteriaUnmet: 0,
          finishedAt: "2026-09-06T05:20:00.000Z",
        }),
      ],
      phasesPassed: true,
    });
    expect(v.pass).toBe(true);
    expect(v.score).toBe(1);
    // The earlier failure must remain visible, not be silently dropped.
    expect(v.reason).toContain("1 earlier sprint failed");
  });

  it("uses finishedAt, not sprintN, to pick the latest outcome", () => {
    // sprintN collides across phases (writeSprintOutcome keys the file on
    // sprintN alone), so a later phase's sprint 1 can be the newest record.
    const v = deriveRunVerdict({
      outcomes: [
        outcome({ sprintN: 1, finishedAt: "2026-09-06T05:55:56.837Z" }), // newest, failed
        outcome({
          sprintN: 2,
          pass: true,
          score: 1,
          verify: "PASS",
          finishedAt: "2026-09-06T05:54:46.832Z", // older, passed
        }),
      ],
      phasesPassed: true,
    });
    expect(v.pass).toBe(false);
    expect(v.score).toBe(0);
  });

  it("fails the run when the phase orchestrator itself did not pass", () => {
    const v = deriveRunVerdict({
      outcomes: [outcome({ sprintN: 1, pass: true, score: 1, verify: "PASS" })],
      phasesPassed: false,
      phaseReason: "phases-deadlocked: phase-2",
    });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("phases-deadlocked: phase-2");
  });
});

describe("runIsTerminal", () => {
  it("marks a passing run terminal so it is not offered for resume", () => {
    expect(runIsTerminal({ pass: true, score: 1, reason: "phases_complete" })).toBe(true);
  });

  it("leaves a failing run resumable — doneAt must stay unset", () => {
    // findLatestIncompleteRun (index.ts) skips any manifest with doneAt set.
    // A run cut short that stamps doneAt can never be resumed, by anyone.
    expect(runIsTerminal({ pass: false, score: 0, reason: "sprint_failed" })).toBe(false);
  });
});
