import { describe, expect, it } from "vitest";
import { buildClarificationPrompt, buildReadinessJudgePrompt } from "../prompts.js";

// Guards the de-robotized askcard contract (2026-06-14). The council clarifier
// used to (a) force "AT LEAST 2 questions" → rambling/over-asking, (b) tell the
// model to OMIT a recommendation unless certain → unranked option lists, and
// (c) carry no existing-repo grounding → generic greenfield questions on a
// brownfield repo. These assertions lock in the fixed behaviour so a future
// edit can't silently regress it.
describe("buildClarificationPrompt — de-robotized askcard", () => {
  const { system } = buildClarificationPrompt(
    "Add a retry to the EE bridge call",
    "## Current Project\nmuonroi-cli — TypeScript CLI. Stack: bun, vitest.\n",
  );

  it("does NOT force a minimum question quota", () => {
    expect(system).not.toMatch(/AT LEAST 2 questions/i);
    expect(system).not.toMatch(/MUST ask AT LEAST/i);
    expect(system).not.toMatch(/Minimum-question rule/i);
  });

  it("explicitly allows zero questions / returning []", () => {
    expect(system).toMatch(/return \[\]/i);
    expect(system).toMatch(/ZERO questions/i);
  });

  it("makes a recommendation MANDATORY (decisive), not optional", () => {
    expect(system).toMatch(/ALWAYS include "recommended"/);
    // The old "OMIT the field entirely" default must be gone.
    expect(system).not.toMatch(/OMIT the field entirely/i);
    expect(system).toMatch(/never face an unranked list/i);
  });

  it("grounds questions in the existing repo, not greenfield", () => {
    expect(system).toMatch(/Current Project/);
    expect(system).toMatch(/EXISTING repository/);
    expect(system).toMatch(/do NOT ask generic greenfield/i);
  });

  it("still emits the structured JSON contract (question/suggestions/recommended)", () => {
    expect(system).toMatch(/"suggestions"/);
    expect(system).toMatch(/"recommended"/);
    expect(system).toMatch(/Output ONLY a JSON array/);
  });
});

describe("buildReadinessJudgePrompt — no JS string-concat leak", () => {
  const { system } = buildReadinessJudgePrompt("Optimize queries", [], {
    problemStatement: "p",
    constraints: [],
    successCriteria: ["c"],
    scope: "s",
  });

  it("does not leak JS concatenation syntax into the prompt text", () => {
    // Was: `...means "probably " +\n  "ready but some ambiguity remains"` — the
    // `" +` and the leading `  "` leaked verbatim into the model-facing string.
    expect(system).not.toContain('" +');
    expect(system).toContain("probably ready but some ambiguity remains");
  });
});
