import { beforeAll, describe, expect, it } from "vitest";
import { classify, warm } from "./index.js";

describe("classify orchestrator", () => {
  beforeAll(async () => {
    await warm();
  }, 30_000);

  it("returns hot for generic greeting (short message fast path)", () => {
    const result = classify("hi");
    expect(result.tier).toBe("hot");
    expect(result.confidence).toBe(0.6);
    expect(result.reason).toBe("regex:short-message");
  });

  it("returns hot for regex-matchable prompts", () => {
    const result = classify("create a file called hello.ts");
    expect(result.tier).toBe("hot");
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it("threshold gating: prompt scoring 0.6 returns abstain when threshold is 0.8", () => {
    // "explain something" matches regex with ~0.70 confidence
    const result = classify("explain what this does", 0.8);
    expect(result.tier).toBe("abstain");
  });

  it("returns hot for tree-sitter-detectable code prompts", () => {
    const result = classify("```ts\nconst x: number = 1;\n```");
    expect(result.tier).toBe("hot");
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
  });
});
