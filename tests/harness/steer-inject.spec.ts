import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CostLeakHarness, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";

// A usage block in the AI-SDK doStream "stream" shape (mirrors fixtures/llm/scope-adherence.json).
const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: null, cacheWrite: null },
  outputTokens: { total: out, text: out, reasoning: null },
});

const bashRound = (id: string, cmd: string) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName: "bash", input: JSON.stringify({ command: cmd }) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: null }, usage: usage(60, 12) },
];

const finalRound = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "f" },
  { type: "text-delta", id: "f", delta: "done" },
  { type: "text-end", id: "f" },
  { type: "finish", finishReason: { unified: "stop", raw: null }, usage: usage(120, 4) },
];

const FIXTURE = {
  provider: "mock",
  modelId: "mock-deepseek-v4-flash",
  // 4 rounds: 3 bash tool-calls (each → a prepareStep boundary) then a final text stop.
  stream: [bashRound("b0", "echo s0"), bashRound("b1", "echo s1"), bashRound("b2", "echo s2"), finalRound],
};

describe("live-queue steering — mid-turn injection", () => {
  let h: CostLeakHarness;

  beforeAll(async () => {
    h = await spawnCostLeakHarness(FIXTURE, { modelId: "deepseek-v4-flash" });
  }, 120_000);

  afterAll(() => {
    h?.cleanup();
  });

  it("injects a message typed while the turn is streaming (steer-inject fires before idle)", async () => {
    // Start a multi-step turn.
    h.driver.type("run the steps");
    h.driver.press("Enter");

    // Queue a follow-up WHILE the turn is in flight (isProcessing === true).
    // The bash tool-exec latency between rounds guarantees this lands before a
    // later prepareStep boundary drains it.
    h.driver.type("also summarize what you did");
    h.driver.press("Enter");

    // Assert the injection actually happened mid-turn.
    await h.driver.wait_for({
      event: "steer-inject",
      match: (e) => e.t === "event" && e.kind === "steer-inject" && e.count >= 1 && e.atStep >= 1,
      timeoutMs: 30_000,
    });

    const injected = h.driver.last_event("steer-inject");
    expect(injected?.count).toBeGreaterThanOrEqual(1);
    expect(injected?.atStep).toBeGreaterThanOrEqual(1);

    // Turn still settles cleanly.
    await h.driver.wait_for({ idle: true, timeoutMs: 30_000 });
  }, 90_000);
});
