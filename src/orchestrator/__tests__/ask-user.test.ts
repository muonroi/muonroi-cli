import { describe, expect, it } from "vitest";
import { ASK_USER_DISMISSED, buildAskUserQuestion, resolveAskUserAnswer } from "../ask-user.js";

describe("buildAskUserQuestion", () => {
  it("uses agent-supplied options verbatim (no CLI-synthesized options)", () => {
    const q = buildAskUserQuestion(
      {
        question: "Proceed with implementation?",
        options: [{ label: "Yes, build it" }, { label: "No, refine first" }],
      },
      "q1",
    );
    expect(q.phase).toBe("ask-user");
    expect(q.question).toBe("Proceed with implementation?");
    expect(q.options?.map((o) => o.label)).toEqual(["Yes, build it", "No, refine first"]);
    expect(q.options?.every((o) => o.kind === "choice")).toBe(true);
  });

  it("defaults option value to its label when omitted", () => {
    const q = buildAskUserQuestion({ question: "?", options: [{ label: "Alpha" }] }, "q2");
    expect(q.options?.[0].value).toBe("Alpha");
  });

  it("with no options renders a single free-text field", () => {
    const q = buildAskUserQuestion({ question: "What ledger name?" }, "q3");
    expect(q.options).toHaveLength(1);
    expect(q.options?.[0].kind).toBe("freetext");
  });

  it("clamps an out-of-range defaultIndex into the options range", () => {
    const q = buildAskUserQuestion({ question: "?", options: [{ label: "A" }, { label: "B" }], defaultIndex: 9 }, "q4");
    expect(q.defaultIndex).toBe(1);
  });

  it("defaults to a neutral index 0 (first option, NOT a recommendation)", () => {
    const q = buildAskUserQuestion({ question: "?", options: [{ label: "A" }, { label: "B" }] }, "q5");
    expect(q.defaultIndex).toBe(0);
  });
});

describe("resolveAskUserAnswer", () => {
  const info = { question: "?", options: [{ label: "Yes", value: "proceed" }, { label: "No" }] };

  it("returns the chosen option's value (fallback to label)", () => {
    expect(resolveAskUserAnswer(info, { index: 0 })).toBe("proceed");
    expect(resolveAskUserAnswer(info, { index: 1 })).toBe("No");
  });

  it("returns free text when provided", () => {
    expect(resolveAskUserAnswer({ question: "?" }, { text: "my-ledger" })).toBe("my-ledger");
  });

  it("returns the dismissed sentinel on cancel", () => {
    expect(resolveAskUserAnswer(info, { cancelled: true })).toBe(ASK_USER_DISMISSED);
  });

  it("returns the dismissed sentinel for an out-of-range index", () => {
    expect(resolveAskUserAnswer(info, { index: 5 })).toBe(ASK_USER_DISMISSED);
  });
});
