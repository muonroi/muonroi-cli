import { describe, expect, it } from "vitest";
import { formatAnswerForLog } from "../format.js";

describe("formatAnswerForLog", () => {
  it("freetext: returns text verbatim (or '(empty)' for blank)", () => {
    expect(formatAnswerForLog({ kind: "freetext", text: "hello" })).toBe("hello");
    expect(formatAnswerForLog({ kind: "freetext", text: "" })).toBe("(empty)");
  });

  it("chat: returns placeholder", () => {
    expect(formatAnswerForLog({ kind: "chat", text: "anything" })).toBe("[Chat about this]");
  });

  it("choice without context: bare verb (legacy behaviour)", () => {
    expect(formatAnswerForLog({ kind: "choice", text: "accept" })).toBe("accept");
    expect(formatAnswerForLog({ kind: "choice", text: "skip" })).toBe("skip");
  });

  it("choice with selectedOptionLabel: appends value", () => {
    expect(
      formatAnswerForLog(
        { kind: "choice", text: "accept" },
        { selectedOptionLabel: '"internal-tool"' },
      ),
    ).toBe('accept · "internal-tool"');
  });

  it("choice with selectedOptionLabel + questionId: includes field name", () => {
    expect(
      formatAnswerForLog(
        { kind: "choice", text: "accept" },
        { selectedOptionLabel: '"internal-tool"', questionId: "productType" },
      ),
    ).toBe('accept · productType="internal-tool"');
  });

  it("choice: strips rationale tail (everything after em-dash)", () => {
    expect(
      formatAnswerForLog(
        { kind: "choice", text: "override" },
        {
          selectedOptionLabel: '"consumer-app" — Could be packaged as a standalone desktop app',
          questionId: "productType",
        },
      ),
    ).toBe('override · productType="consumer-app"');
  });

  it("choice: when label === verb, no decoration (avoid 'accept · accept')", () => {
    expect(
      formatAnswerForLog(
        { kind: "choice", text: "accept" },
        { selectedOptionLabel: "accept" },
      ),
    ).toBe("accept");
  });

  it("choice: empty/whitespace label is treated as missing", () => {
    expect(
      formatAnswerForLog(
        { kind: "choice", text: "accept" },
        { selectedOptionLabel: "   " },
      ),
    ).toBe("accept");
  });
});
