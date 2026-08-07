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

  it("rounds trip CRLF line endings", () => {
    const body = renderPlanMarkdown("topic", PHASES);
    const crlfBody = body.replace(/\n/g, "\r\n");
    expect(parsePlanMarkdown(crlfBody)).toEqual(PHASES);
  });

  it("rounds trip a phase title containing an em-dash", () => {
    const phase = { ...PHASES[0], title: "Handle edge case — redux" };
    const body = renderPlanMarkdown("topic", [phase]);
    expect(parsePlanMarkdown(body)[0].title).toBe("Handle edge case — redux");
  });

  it("rounds trip bullet text that begins with a dash", () => {
    const phase = { ...PHASES[0], steps: ["- but actually", "normal step"] };
    const body = renderPlanMarkdown("topic", [phase]);
    expect(parsePlanMarkdown(body)[0].steps).toEqual(["- but actually", "normal step"]);
  });

  it("rounds trip empty string in steps, files, or acceptance", () => {
    const phase = {
      id: "P0",
      title: "Test empty items",
      steps: ["first", "", "third"],
      files: ["src/a.ts", "", "src/c.ts"],
      acceptance: ["item 1", "", "item 3"],
      verify: "",
      done: false,
    };
    const body = renderPlanMarkdown("topic", [phase]);
    const parsed = parsePlanMarkdown(body);
    expect(parsed[0].steps).toEqual(["first", "", "third"]);
    expect(parsed[0].files).toEqual(["src/a.ts", "", "src/c.ts"]);
    expect(parsed[0].acceptance).toEqual(["item 1", "", "item 3"]);
  });
});

describe("phase heading dash tolerance (hand-edited plans)", () => {
  // PHASE_RE used to require U+2014 exactly — what renderPlanMarkdown emits. A
  // human editing PLAN.md types a plain hyphen, which parsed as ZERO phases, and
  // runPlanExecution then reported reason:"plan complete" having executed
  // nothing. Fail-silent-SUCCESS is the wrong direction for a gate.
  const DASHES: Array<[string, string]> = [
    ["em dash (what renderPlanMarkdown emits)", "—"],
    ["en dash", "–"],
    ["plain hyphen (hand-typed)", "-"],
  ];

  for (const [name, dash] of DASHES) {
    it(`parses a phase heading written with a ${name}`, () => {
      const body = ["# PLAN", "", `## P0 ${dash} Sentinel`, "", "**Verify:** exit 0", "", "**Status:** pending"].join(
        "\n",
      );
      const phases = parsePlanMarkdown(body);
      expect(phases).toHaveLength(1);
      expect(phases[0].id).toBe("P0");
      expect(phases[0].title).toBe("Sentinel");
      expect(nextPendingPhase(body)?.id).toBe("P0");
    });
  }

  it("markPhaseDone works on a hand-typed hyphen heading too", () => {
    const body = ["## P0 - Sentinel", "", "**Status:** pending"].join("\n");
    expect(markPhaseDone(body, "P0")).toContain("**Status:** done");
  });

  it("still finds NO phases in a file that genuinely has none", () => {
    expect(parsePlanMarkdown("# PLAN\n\nsome prose, no headings\n")).toHaveLength(0);
  });
});
