import { describe, expect, it } from "vitest";
import { type AgenticDecision, createMockBrain, parseDecision } from "../agentic-loop.js";

describe("agentic-loop brain primitives", () => {
  it("createMockBrain plays scripted decisions in order", async () => {
    const script: AgenticDecision[] = [
      { action: "type", text: "/ideal", reason: "kick off" },
      { action: "press", key: "Enter", reason: "submit" },
      { action: "done", verdict: "pass", reason: "ok" },
    ];
    const brain = createMockBrain(script);
    const sink = {
      goal: "test",
      historyExcerpt: "",
      turn: 1,
      maxTurns: 5,
      context: { prompt: "x", estimatedTokens: 1, truncated: false },
    };
    expect((await brain.decide(sink)).action).toBe("type");
    expect((await brain.decide(sink)).action).toBe("press");
    expect((await brain.decide(sink)).action).toBe("done");
  });

  it("createMockBrain returns inconclusive done once exhausted", async () => {
    const brain = createMockBrain([]);
    const d = await brain.decide({
      goal: "test",
      historyExcerpt: "",
      turn: 1,
      maxTurns: 5,
      context: { prompt: "x", estimatedTokens: 1, truncated: false },
    });
    expect(d.action).toBe("done");
    expect(d.action === "done" && d.verdict).toBe("inconclusive");
  });
});

describe("parseDecision", () => {
  it("strips ```json fences and parses cleanly", () => {
    const r = parseDecision('```json\n{"action":"type","text":"hi","reason":"go"}\n```');
    expect(r).toMatchObject({ action: "type", text: "hi" });
  });

  it("rejects malformed", () => {
    expect(parseDecision("nope")).toBeNull();
  });

  it("parses done with verdict", () => {
    const r = parseDecision('{"action":"done","verdict":"pass","reason":"all good"}');
    expect(r).toMatchObject({ action: "done", verdict: "pass" });
  });

  it("parses wait_for with selector + timeout", () => {
    const r = parseDecision('{"action":"wait_for","selector":"id=askcard","timeoutMs":3000,"reason":"x"}');
    expect(r).toMatchObject({ action: "wait_for", selector: "id=askcard", timeoutMs: 3000 });
  });

  it("parses press with key", () => {
    const r = parseDecision('{"action":"press","key":"Enter","reason":"submit"}');
    expect(r).toMatchObject({ action: "press", key: "Enter" });
  });

  it("rejects invalid verdict on done", () => {
    expect(parseDecision('{"action":"done","verdict":"weird","reason":"x"}')).toBeNull();
  });

  it("rejects unknown action", () => {
    expect(parseDecision('{"action":"nuke","reason":"x"}')).toBeNull();
  });
});
