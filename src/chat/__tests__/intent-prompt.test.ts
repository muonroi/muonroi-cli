import { describe, expect, it } from "vitest";
import { buildConvoPrompt, parseConvoReply, SYSTEM_PROMPT } from "../intent-prompt.js";

describe("intent-prompt", () => {
  it("SYSTEM_PROMPT contains intent semantics", () => {
    expect(SYSTEM_PROMPT).toContain("accept");
    expect(SYSTEM_PROMPT).toContain("reject");
    expect(SYSTEM_PROMPT).toContain("abort");
    expect(SYSTEM_PROMPT).toContain("discuss");
  });

  it("SYSTEM_PROMPT instructs language match (default Vietnamese)", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/vietnamese|language/);
  });

  it("SYSTEM_PROMPT forbids keyword matching", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/keyword|negation|conservative/);
  });

  it("buildConvoPrompt includes review summary, prior turns, new msg", () => {
    const out = buildConvoPrompt({
      reviewSummary: "Sprint done.",
      productName: "Demo",
      priorTurns: [
        { role: "customer", content: "looks good?" },
        { role: "bot", content: "yes" },
      ],
      newMessage: "I accept",
    });
    expect(out).toContain("Sprint done.");
    expect(out).toContain("looks good?");
    expect(out).toContain("yes");
    expect(out).toContain("I accept");
  });

  it("buildConvoPrompt truncates reviewSummary to 1500 chars", () => {
    const out = buildConvoPrompt({
      reviewSummary: "x".repeat(3000),
      productName: "Demo",
      priorTurns: [],
      newMessage: "hi",
    });
    expect(out.length).toBeLessThan(3000);
  });

  it("parseConvoReply parses bare JSON", () => {
    const out = parseConvoReply('{"intent":"accept","reply":"Great!"}');
    expect(out.intent).toBe("accept");
    expect(out.reply).toBe("Great!");
  });

  it("parseConvoReply strips ```json code fence", () => {
    const out = parseConvoReply('```json\n{"intent":"reject","reply":"fix it"}\n```');
    expect(out.intent).toBe("reject");
  });

  it("parseConvoReply returns intent='discuss' + reply on malformed JSON", () => {
    const out = parseConvoReply("not json at all");
    expect(out.intent).toBe("discuss");
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it("parseConvoReply caps reply at 500 chars", () => {
    const out = parseConvoReply(JSON.stringify({ intent: "discuss", reply: "x".repeat(800) }));
    expect(out.reply.length).toBe(500);
  });

  it("parseConvoReply preserves unknown intent string for caller classification", () => {
    const out = parseConvoReply(JSON.stringify({ intent: "maybe", reply: "..." }));
    expect(out.intent).toBe("maybe");
  });

  it("buildConvoPrompt with empty priorTurns renders (none) placeholder", () => {
    const out = buildConvoPrompt({
      reviewSummary: "Done.",
      productName: "Test",
      priorTurns: [],
      newMessage: "ok?",
    });
    expect(out).toContain("(none)");
  });

  it("parseConvoReply falls back to discuss when intent field is missing", () => {
    const out = parseConvoReply(JSON.stringify({ reply: "hi" }));
    expect(out.intent).toBe("discuss");
  });

  it("parseConvoReply falls back to FALLBACK_REPLY when reply field is missing", () => {
    const out = parseConvoReply(JSON.stringify({ intent: "accept" }));
    expect(out.reply.length).toBeGreaterThan(0);
  });
});
