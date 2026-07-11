import { describe, expect, it } from "vitest";
import { buildToolGroupEntry, formatAnswerForLog, isCouncilStartPatch } from "../format.js";

describe("isCouncilStartPatch (F5 — reset stale rail criteria on a new council)", () => {
  it("true when leader+panel arrive together (the entrypoint's once-per-debate patch)", () => {
    expect(isCouncilStartPatch({ leader: "deepseek", panel: ["a", "b"] })).toBe(true);
  });

  it("true even with an empty panel array (participants may be empty)", () => {
    expect(isCouncilStartPatch({ leader: "deepseek", panel: [] })).toBe(true);
  });

  it("false for the partial later patches that must MERGE, not reset", () => {
    expect(isCouncilStartPatch({ successCriteria: ["x"] } as never)).toBe(false);
    expect(isCouncilStartPatch({ criteriaMet: [true] } as never)).toBe(false);
    expect(isCouncilStartPatch({ researchMode: true } as never)).toBe(false);
    expect(isCouncilStartPatch({ roundBudget: 3 } as never)).toBe(false);
    expect(isCouncilStartPatch({ leader: "deepseek" })).toBe(false); // leader alone
    expect(isCouncilStartPatch({ panel: ["a"] })).toBe(false); // panel alone
  });
});

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
    expect(formatAnswerForLog({ kind: "choice", text: "accept" }, { selectedOptionLabel: '"internal-tool"' })).toBe(
      'accept · "internal-tool"',
    );
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

  it("choice: snake_case action id shows the human label only (no id leak)", () => {
    // Post-debate actions (continue_session, save_exit…) are internal routing
    // tokens — the user must see the label, never "continue_session · …".
    expect(
      formatAnswerForLog(
        { kind: "choice", text: "continue_session" },
        { selectedOptionLabel: "Tiếp tục phiên làm việc" },
      ),
    ).toBe("Tiếp tục phiên làm việc");
    expect(
      formatAnswerForLog(
        { kind: "choice", text: "save_exit" },
        { selectedOptionLabel: "Save this evaluation — the synthesis is the deliverable" },
      ),
    ).toBe("Save this evaluation");
  });

  it("choice: when label === verb, no decoration (avoid 'accept · accept')", () => {
    expect(formatAnswerForLog({ kind: "choice", text: "accept" }, { selectedOptionLabel: "accept" })).toBe("accept");
  });

  it("choice: empty/whitespace label is treated as missing", () => {
    expect(formatAnswerForLog({ kind: "choice", text: "accept" }, { selectedOptionLabel: "   " })).toBe("accept");
  });
});

describe("buildToolGroupEntry", () => {
  it("creates an active group with a unique id and empty items list", () => {
    const e1 = buildToolGroupEntry();
    const e2 = buildToolGroupEntry();
    expect(e1.type).toBe("tool_group");
    expect(e1.toolGroup?.state).toBe("active");
    expect(e1.toolGroup?.items).toEqual([]);
    expect(e1.toolGroup?.id).not.toBe(e2.toolGroup?.id);
    expect(typeof e1.toolGroup?.startedAt).toBe("number");
  });

  it("propagates partial ChatEntry overrides to the entry", () => {
    const e = buildToolGroupEntry({ modeColor: "#ff0000", sourceLabel: "test-source" });
    expect(e.modeColor).toBe("#ff0000");
    expect(e.sourceLabel).toBe("test-source");
  });
});
