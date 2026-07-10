import { describe, expect, it } from "vitest";
import { SPRINT_EXECUTION_MARKER } from "../../pil/layer6-output.js";
import { taskTypeToMaxTokens } from "../../pil/task-tier-map.js";
import { resolveTurnMaxOutputTokens } from "../tool-engine.js";

// Regression for the /ideal sprint-implementation handoff wedge (2026-07-10,
// gsd-core migration): the impl prompt was classified `analyze`/default → the
// output budget capped at 4_096 → deepseek-v4-flash narrated its plan until it
// hit finishReason:"length" mid-word, produced ZERO code, and the turn wedged.
// A sprint-execution turn must floor at the build/generate tier regardless of
// the noisy classify.
describe("resolveTurnMaxOutputTokens", () => {
  const BUILD = taskTypeToMaxTokens("build"); // 12_288

  it("floors a sprint-execution turn to the build tier even when classified analyze (4_096)", () => {
    const raw = `${SPRINT_EXECUTION_MARKER}\n\nEXECUTE the sprint plan below.`;
    expect(taskTypeToMaxTokens("analyze")).toBe(4_096); // the starved cap that caused the wedge
    expect(resolveTurnMaxOutputTokens({ taskType: "analyze", raw })).toBe(BUILD);
  });

  it("floors a sprint-execution turn recognised by the plan header marker", () => {
    const raw = "--- SPRINT PLAN TO IMPLEMENT ---\n\nphase 1 ...";
    expect(resolveTurnMaxOutputTokens({ taskType: null, raw })).toBe(BUILD);
  });

  it("never LOWERS a turn already classified above the build tier", () => {
    // build/generate already == BUILD; the floor is a max(), never a downgrade.
    const raw = `${SPRINT_EXECUTION_MARKER}\n\ngo`;
    expect(resolveTurnMaxOutputTokens({ taskType: "generate", raw })).toBe(BUILD);
  });

  it("leaves a NON-sprint turn on its classified budget (no over-budgeting of refactor)", () => {
    expect(resolveTurnMaxOutputTokens({ taskType: "refactor", raw: "rename the symbol foo to bar" })).toBe(
      taskTypeToMaxTokens("refactor"), // 6_144 — intentionally tighter, must be preserved
    );
    expect(resolveTurnMaxOutputTokens({ taskType: "analyze", raw: "analyze the auth design" })).toBe(4_096);
    expect(resolveTurnMaxOutputTokens({ taskType: null, raw: "hi" })).toBe(4_096);
  });

  it("tolerates a missing raw (defaults to the classified budget)", () => {
    expect(resolveTurnMaxOutputTokens({ taskType: "debug" })).toBe(taskTypeToMaxTokens("debug"));
  });
});
