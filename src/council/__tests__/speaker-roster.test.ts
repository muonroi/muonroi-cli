import { describe, expect, it } from "vitest";
import { formatSpeakerRoster } from "../debate.js";

describe("formatSpeakerRoster (A: live debate preview detail)", () => {
  it("formats 'Name — focus', preferring concrete focus over lens", () => {
    const out = formatSpeakerRoster([
      {
        stance: { name: "Code Auditor", lens: "what does it implement?", focus: "grep the packages tree" },
        model: "m1",
      },
    ]);
    expect(out).toBe("Code Auditor — grep the packages tree");
  });

  it("falls back to lens when focus is absent, then to bare name", () => {
    const out = formatSpeakerRoster([
      { stance: { name: "Design Analyst", lens: "does the intent hold?" }, model: "m1" },
      { stance: { name: "Namer", lens: "" }, model: "m2" },
    ]);
    expect(out).toBe("Design Analyst — does the intent hold?\nNamer");
  });

  it("uses model id when there is no stance", () => {
    expect(formatSpeakerRoster([{ model: "deepseek-v4-flash" }])).toBe("deepseek-v4-flash");
  });

  it("dedups identical rows (same speaker across pairs renders once)", () => {
    const s = { stance: { name: "A", lens: "x" }, model: "m" };
    expect(formatSpeakerRoster([s, s])).toBe("A — x");
  });

  it("returns undefined for an empty roster so the UI falls back to label-only", () => {
    expect(formatSpeakerRoster([])).toBeUndefined();
  });
});
