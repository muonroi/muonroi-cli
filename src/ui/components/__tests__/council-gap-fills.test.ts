import { describe, expect, it } from "vitest";
import type { CouncilStanceMark, CouncilStanceRow } from "../../../types/index.js";
import { clampBubbleLines, DEFAULT_BUBBLE_BODY_LINES } from "../bubble-body-guard.js";
import { formatQuestionCounter } from "../council-question-card.js";
import { countOpenSplits } from "../council-scoreboard.js";

const ROSTER = ["architect", "skeptic", "research"];
const row = (stances: Record<string, CouncilStanceMark>, met = false): CouncilStanceRow => ({
  criterion: "c",
  met,
  stances,
});

describe("countOpenSplits", () => {
  it("counts a criterion with support on both sides", () => {
    expect(countOpenSplits([row({ architect: "+", skeptic: "-", research: null })], ROSTER)).toBe(1);
  });

  // The distinction that makes the number actionable: another round can still
  // settle an unargued criterion, but rarely breaks a deadlock.
  it("does NOT count an unmet criterion nobody has argued", () => {
    expect(countOpenSplits([row({ architect: null, skeptic: null, research: null })], ROSTER)).toBe(0);
  });

  it("does not count one-sided opposition as a split", () => {
    expect(countOpenSplits([row({ architect: null, skeptic: "-", research: null })], ROSTER)).toBe(0);
  });

  it("ignores a criterion already met", () => {
    expect(countOpenSplits([row({ architect: "+", skeptic: "-" }, true)], ROSTER)).toBe(0);
  });

  it("treats a conditional as a side, so ~ vs - is a split", () => {
    expect(countOpenSplits([row({ architect: "~", skeptic: "-", research: null })], ROSTER)).toBe(1);
  });

  it("sums across rows", () => {
    expect(
      countOpenSplits(
        [row({ architect: "+", skeptic: "-" }), row({ architect: "+", skeptic: "-" }), row({ architect: "+" })],
        ROSTER,
      ),
    ).toBe(2);
  });
});

describe("clampBubbleLines", () => {
  const body = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");

  it("reports how many lines it hid", () => {
    const r = clampBubbleLines(body(20), 8);
    expect(r.hiddenLines).toBe(12);
    expect(r.text.split("\n")).toHaveLength(8);
  });

  it("leaves a short body untouched", () => {
    const r = clampBubbleLines(body(4), 8);
    expect(r).toEqual({ text: body(4), hiddenLines: 0 });
  });

  it("does not clamp at exactly the limit", () => {
    expect(clampBubbleLines(body(8), 8).hiddenLines).toBe(0);
  });

  // maxLines <= 0 is the expanded state.
  it("disables the clamp for a non-positive limit", () => {
    const r = clampBubbleLines(body(50), 0);
    expect(r.hiddenLines).toBe(0);
    expect(r.text.split("\n")).toHaveLength(50);
  });

  it("defaults to the shared line budget", () => {
    expect(clampBubbleLines(body(DEFAULT_BUBBLE_BODY_LINES + 3)).hiddenLines).toBe(3);
  });
});

describe("formatQuestionCounter", () => {
  it("renders n / m", () => {
    expect(formatQuestionCounter({ questionIndex: 2, questionTotal: 3 })).toBe("2 / 3");
  });

  // A "1 / 1" counter is noise — there is no progress to convey.
  it("suppresses a single-question round", () => {
    expect(formatQuestionCounter({ questionIndex: 1, questionTotal: 1 })).toBe("");
  });

  it("suppresses missing or nonsensical values rather than printing '2 / 0'", () => {
    expect(formatQuestionCounter({})).toBe("");
    expect(formatQuestionCounter({ questionIndex: 2 })).toBe("");
    expect(formatQuestionCounter({ questionIndex: 2, questionTotal: 0 })).toBe("");
    expect(formatQuestionCounter({ questionIndex: 0, questionTotal: 3 })).toBe("");
    expect(formatQuestionCounter({ questionIndex: 5, questionTotal: 3 })).toBe("");
    expect(formatQuestionCounter({ questionIndex: Number.NaN, questionTotal: 3 })).toBe("");
  });
});
