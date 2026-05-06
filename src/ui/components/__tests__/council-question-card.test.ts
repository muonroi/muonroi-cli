import { describe, expect, it } from "vitest";
import type { CouncilQuestionData } from "../../../types/index.js";
import {
  clampIndex,
  initialCardState,
  reduceCardKey,
  type CouncilCardState,
} from "../council-question-card.js";

function makeQuestion(overrides: Partial<CouncilQuestionData> = {}): CouncilQuestionData {
  return {
    questionId: "q1",
    phase: "clarify",
    question: "Which database?",
    isRequired: true,
    options: [
      { label: "Postgres", value: "postgres", kind: "choice" },
      { label: "MySQL", value: "mysql", kind: "choice" },
      { label: "Type something", value: "", kind: "freetext" },
      { label: "Chat about this", value: "", kind: "chat" },
    ],
    ...overrides,
  };
}

describe("clampIndex", () => {
  it("clamps below zero to 0", () => {
    expect(clampIndex(-1, 5)).toBe(0);
  });
  it("clamps above length to len-1", () => {
    expect(clampIndex(5, 3)).toBe(2);
  });
  it("returns 0 for empty list", () => {
    expect(clampIndex(2, 0)).toBe(0);
  });
});

describe("reduceCardKey — option list", () => {
  it("up/down navigates and clamps at edges", () => {
    const q = makeQuestion();
    let s = initialCardState(q);
    expect(s.idx).toBe(0);
    s = reduceCardKey(q, s, { kind: "down" }).state;
    expect(s.idx).toBe(1);
    s = reduceCardKey(q, s, { kind: "up" }).state;
    s = reduceCardKey(q, s, { kind: "up" }).state; // already at 0
    expect(s.idx).toBe(0);
    s = reduceCardKey(q, s, { kind: "down" }).state;
    s = reduceCardKey(q, s, { kind: "down" }).state;
    s = reduceCardKey(q, s, { kind: "down" }).state;
    s = reduceCardKey(q, s, { kind: "down" }).state; // past end
    expect(s.idx).toBe(3);
  });

  it("Enter on a choice option emits answer with value", () => {
    const q = makeQuestion();
    const s = { idx: 1, freetext: null };
    const result = reduceCardKey(q, s, { kind: "enter" });
    expect(result.emit?.type).toBe("answer");
    if (result.emit?.type === "answer") {
      expect(result.emit.answer.text).toBe("mysql");
      expect(result.emit.answer.kind).toBe("choice");
    }
  });

  it("Enter on freetext option opens inline input mode without emitting", () => {
    const q = makeQuestion();
    const s = { idx: 2, freetext: null };
    const result = reduceCardKey(q, s, { kind: "enter" });
    expect(result.emit).toBeUndefined();
    expect(result.state.freetext).toBe("");
  });

  it("Enter on chat option emits sentinel chat answer", () => {
    const q = makeQuestion();
    const s = { idx: 3, freetext: null };
    const result = reduceCardKey(q, s, { kind: "enter" });
    expect(result.emit?.type).toBe("answer");
    if (result.emit?.type === "answer") {
      expect(result.emit.answer.kind).toBe("chat");
      expect(result.emit.answer.text.length).toBeGreaterThan(0);
    }
  });

  it("Escape on option list emits cancel", () => {
    const q = makeQuestion();
    const result = reduceCardKey(q, initialCardState(q), { kind: "escape" });
    expect(result.emit?.type).toBe("cancel");
  });
});

describe("reduceCardKey — freetext mode", () => {
  it("char keys append to freetext buffer", () => {
    const q = makeQuestion();
    let s: CouncilCardState = { idx: 2, freetext: "" };
    s = reduceCardKey(q, s, { kind: "char", ch: "h" }).state;
    s = reduceCardKey(q, s, { kind: "char", ch: "i" }).state;
    expect(s.freetext).toBe("hi");
  });

  it("backspace deletes last char", () => {
    const q = makeQuestion();
    const result = reduceCardKey(q, { idx: 2, freetext: "abc" }, { kind: "backspace" });
    expect(result.state.freetext).toBe("ab");
  });

  it("Enter in freetext mode emits answer with typed text", () => {
    const q = makeQuestion();
    const result = reduceCardKey(q, { idx: 2, freetext: "custom answer" }, { kind: "enter" });
    expect(result.emit?.type).toBe("answer");
    if (result.emit?.type === "answer") {
      expect(result.emit.answer.text).toBe("custom answer");
      expect(result.emit.answer.kind).toBe("freetext");
    }
  });

  it("Escape in freetext mode returns to option list (no emit)", () => {
    const q = makeQuestion();
    const result = reduceCardKey(q, { idx: 2, freetext: "abc" }, { kind: "escape" });
    expect(result.emit).toBeUndefined();
    expect(result.state.freetext).toBeNull();
  });
});

describe("legacy fallback", () => {
  it("uses suggestions[] when options[] missing", () => {
    const q = makeQuestion({
      options: undefined,
      suggestions: ["legacy A", "legacy B"],
    });
    const s = initialCardState(q);
    const result = reduceCardKey(q, s, { kind: "enter" });
    expect(result.emit?.type).toBe("answer");
    if (result.emit?.type === "answer") {
      expect(result.emit.answer.text).toBe("legacy A");
    }
  });
});
