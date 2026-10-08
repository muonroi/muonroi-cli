/**
 * sprint-failed-halt.test.ts
 *
 * `use-app-logic.tsx`'s top-level `/ideal` catch block used to build the
 * `halt_card_open` interaction-log payload as a bare inline object literal —
 * `{ reason: "sprint_failed", trigger: "loop_throw", sprintN }` — three lines
 * after computing `errMsg` and showing it on screen
 * (`buildAssistantEntry(\`Product loop error: ${errMsg}\`)`). The error text
 * was never persisted: `halt_card_open` rows carried `{reason, trigger,
 * sprintN}` and nothing else, so a post-mortem on a run that broke this way
 * (e.g. session 1f9f57415170 / run mu3ks8zwe8d5) had no error text in the DB
 * at all — diagnosing it required a human to paste a terminal screenshot.
 *
 * `use-app-logic.tsx` is a single `@ts-nocheck` React hook file with no
 * existing unit-test harness (no other file imports it directly), so this
 * pure, independently-testable helper is what the hook's catch block now
 * calls to build that payload — testable without standing up the hook itself.
 */
import { describe, expect, it } from "vitest";
import { buildSprintFailedHaltData } from "../sprint-failed-halt.js";

describe("buildSprintFailedHaltData", () => {
  it("carries the error message that is shown on screen into the persisted payload", () => {
    const err = new Error("Sprint 1 planning council produced no plan — the synthesizer returned no usable output");
    const data = buildSprintFailedHaltData(err, { trigger: "loop_throw", sprintN: 1 });

    expect(data.reason).toBe("sprint_failed");
    expect(data.trigger).toBe("loop_throw");
    expect(data.sprintN).toBe(1);
    expect(data.errorMessage).toBe(
      "Sprint 1 planning council produced no plan — the synthesizer returned no usable output",
    );
  });

  it("includes a truncated stack trace", () => {
    const err = new Error("boom");
    err.stack =
      "Error: boom\n    at fnA (a.ts:1:1)\n    at fnB (b.ts:2:2)\n    at fnC (c.ts:3:3)\n    at fnD (d.ts:4:4)";
    const data = buildSprintFailedHaltData(err, { trigger: "loop_throw", sprintN: null });
    expect(data.errorStack).toBeDefined();
    // Never dump the whole stack unbounded into one interaction_logs row.
    expect(data.errorStack?.split("\n").length).toBeLessThanOrEqual(5);
    expect(data.errorStack).toContain("at fnA");
  });

  it("truncates a runaway message so one row cannot blow the text limit", () => {
    const err = new Error("x".repeat(9_000));
    const data = buildSprintFailedHaltData(err, { trigger: "loop_throw", sprintN: 2 });
    expect(data.errorMessage.length).toBeLessThanOrEqual(2_000);
  });

  it("handles a non-Error throw (a thrown string) without crashing", () => {
    const data = buildSprintFailedHaltData("plain string failure", { trigger: "loop_throw", sprintN: null });
    expect(data.errorMessage).toBe("plain string failure");
    expect(data.errorStack).toBeUndefined();
  });

  it("never logs secrets by inventing new fields beyond the error's own text", () => {
    const err = new Error("provider rejected key sk-should-not-be-fabricated");
    const data = buildSprintFailedHaltData(err, { trigger: "loop_throw", sprintN: 3 });
    // The helper must not ADD anything the error didn't already say — it only
    // truncates the message/stack the caller already decided to show on screen.
    expect(Object.keys(data).sort()).toEqual(["errorMessage", "errorStack", "reason", "sprintN", "trigger"].sort());
  });
});
