import { describe, expect, it } from "vitest";
import { buildInterruptedTurnNote } from "./interrupted-turn.js";

describe("buildInterruptedTurnNote", () => {
  it("is never empty — so the stalled turn always leaves a trace in history", () => {
    expect(buildInterruptedTurnNote("", []).length).toBeGreaterThan(0);
  });

  it("records the interruption and the tools that were issued", () => {
    const note = buildInterruptedTurnNote("", ["bash", "read_file", "grep"]);
    expect(note).toMatch(/interrupted|stall/i);
    expect(note).toMatch(/bash/);
    expect(note).toMatch(/read_file/);
    expect(note).toMatch(/3 tool/); // count
  });

  it("warns against blindly redoing partially-applied work", () => {
    expect(buildInterruptedTurnNote("", ["bash"])).toMatch(/partial|re-check|recheck/i);
  });

  it("prepends any partial assistant text before the note", () => {
    const note = buildInterruptedTurnNote("Here is what I found so far:", ["bash"]);
    expect(note.startsWith("Here is what I found so far:")).toBe(true);
    expect(note).toMatch(/interrupted|stall/i);
  });

  it("dedupes tool names but keeps the raw count", () => {
    const note = buildInterruptedTurnNote("", ["bash", "bash", "bash", "read_file"]);
    expect(note).toMatch(/4 tool/); // raw count
    // bash listed once
    expect(note.match(/bash/g)?.length).toBe(1);
  });

  it("handles the no-tools case with a generic note", () => {
    const note = buildInterruptedTurnNote("", []);
    expect(note).toMatch(/interrupted|stall/i);
    expect(note).not.toMatch(/tool call/);
  });
});
