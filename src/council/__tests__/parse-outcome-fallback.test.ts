import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilLLM, DebatePlan } from "../types.js";

// Build a minimal mock CouncilLLM that returns a fixed synthesisText
function makeMockLLM(synthesisText: string): CouncilLLM {
  return {
    async generate() {
      return synthesisText;
    },
    async research() {
      return "";
    },
    async debate() {
      return { text: "", toolCalls: [] };
    },
  };
}

async function runPlanningWith(synthesisText: string, debatePlan?: DebatePlan) {
  const { runPlanning } = await import("../planner.js");
  const spec = {
    problemStatement: "test",
    constraints: [],
    successCriteria: [],
    scope: "test",
    rawQA: [],
  };
  const debateState: any = {
    spec,
    exchangeLogs: new Map(),
    runningSummary: "",
    roundCount: 1,
    active: [],
  };
  const participants = [{ role: "primary" as any, model: "m1", position: "pos1" }];
  const gen = runPlanning(
    debateState,
    spec,
    participants,
    "m1",
    async () => false,
    makeMockLLM(synthesisText),
    debatePlan,
  );
  let result: { outcome: any; plan: any; synthesisText: string } | undefined;
  while (true) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
  }
  return result;
}

const sampleDebatePlan: DebatePlan = {
  intentSummary: "Evaluate options",
  stances: [],
  outputShape: {
    kind: "evaluation",
    sections: [
      { key: "strengths", heading: "Strengths", prompt: "", shape: "list" },
      { key: "summary_text", heading: "Summary", prompt: "", shape: "text" },
    ],
    guardrails: [],
  },
};

describe("parseOutcome — raw log + shape-based fallback (CQ-20)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("Test 1: no JSON → returns null AND console.error called with raw text", async () => {
    const rawText = "This is plain text with no JSON object inside at all.";
    const result = await runPlanningWith(rawText);
    expect(result?.outcome).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Council] parseOutcome failed"),
      expect.stringContaining(rawText),
    );
  });

  it("Test 2: malformed JSON → returns null AND logs raw text", async () => {
    const malformed = '{"summary": "ok"'; // missing closing brace — no valid JSON match
    const result = await runPlanningWith(malformed);
    expect(result?.outcome).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[Council] parseOutcome failed"), expect.any(String));
  });

  it("Test 3: JSON parse fails + debatePlan sections → returns object with kind and summary", async () => {
    const rawText = "This is a long enough line that exceeds twenty chars for summary extraction";
    const result = await runPlanningWith(rawText, sampleDebatePlan);
    expect(result?.outcome).not.toBeNull();
    expect(result?.outcome.type).toBe("evaluation");
    expect(result?.outcome.summary).toBe(rawText.trim());
  });

  it("Test 4: shape fallback populates sections with correct empty defaults", async () => {
    const rawText = "Long enough summary text here for the fallback to work correctly";
    const result = await runPlanningWith(rawText, sampleDebatePlan);
    expect(result?.outcome?.sections).toBeDefined();
    expect(result?.outcome?.sections?.strengths).toEqual([]);
    expect(result?.outcome?.sections?.summary_text).toBe("");
  });

  it("Test 5: valid JSON path returns correct outcome — no regression", async () => {
    const validJson = JSON.stringify({
      type: "decision",
      summary: "We should go with option A because it is simpler.",
      agreed: ["Option A"],
    });
    const result = await runPlanningWith(validJson);
    expect(result?.outcome).not.toBeNull();
    expect(result?.outcome?.type).toBe("decision");
    expect(result?.outcome?.summary).toBe("We should go with option A because it is simpler.");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("Test 6: shape fallback EXTRACTS section content from markdown headings (regex regression)", async () => {
    // Pre-fix the heading regex used a literal "s+" instead of "\\s+" (and
    // replaced spaces with "s+"), so it never matched a real "## Heading" line —
    // every section came back empty even when the synthesis clearly contained them.
    const md =
      "Here is the evaluation summary line that is plenty long enough.\n\n" +
      "## Strengths\n- Fast startup\n- Low cost\n\n" +
      "## Summary\nThe approach is solid overall.";
    const result = await runPlanningWith(md, sampleDebatePlan);
    expect(result?.outcome?.sections?.strengths).toEqual(["- Fast startup", "- Low cost"]);
    expect(result?.outcome?.sections?.summary_text).toContain("The approach is solid overall.");
  });
});
