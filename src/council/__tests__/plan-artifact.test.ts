import { describe, expect, it } from "vitest";
import {
  markPhaseDone,
  nextPendingPhase,
  type PlanPhase,
  parsePlanMarkdown,
  renderPlanMarkdown,
} from "../plan-artifact.js";

const PHASES: PlanPhase[] = [
  {
    id: "P0",
    title: "Sentinel transition E2E",
    steps: ["Add the spy", "Assert the sentinel wins"],
    files: ["src/council/index.ts"],
    acceptance: ["The sentinel action reaches the caller unchanged"],
    verify: "bunx vitest run src/council/__tests__/phase-outcome-envelope.test.ts",
    done: false,
  },
  {
    id: "P1",
    title: "Canonical degraded mapping",
    steps: ["Map degraded explicitly"],
    files: ["src/council/types.ts"],
    acceptance: ["degraded no longer collapses into ask_followup"],
    verify: "bunx vitest run src/council/__tests__/",
    done: false,
  },
];

describe("plan artifact round-trip", () => {
  it("renders then parses back to the same phases", () => {
    expect(parsePlanMarkdown(renderPlanMarkdown("topic", PHASES))).toEqual(PHASES);
  });

  it("nextPendingPhase returns P0 first, then P1 once P0 is ticked", () => {
    const body = renderPlanMarkdown("topic", PHASES);
    expect(nextPendingPhase(body)?.id).toBe("P0");
    expect(nextPendingPhase(markPhaseDone(body, "P0"))?.id).toBe("P1");
  });

  it("nextPendingPhase returns null when every phase is done", () => {
    let body = renderPlanMarkdown("topic", PHASES);
    body = markPhaseDone(markPhaseDone(body, "P0"), "P1");
    expect(nextPendingPhase(body)).toBeNull();
  });

  it("markPhaseDone on an unknown id leaves the body untouched", () => {
    const body = renderPlanMarkdown("topic", PHASES);
    expect(markPhaseDone(body, "P9")).toBe(body);
  });

  it("a phase with no verify command parses to an empty string, not undefined", () => {
    const body = renderPlanMarkdown("topic", [{ ...PHASES[0], verify: "" }]);
    expect(parsePlanMarkdown(body)[0].verify).toBe("");
  });
});
