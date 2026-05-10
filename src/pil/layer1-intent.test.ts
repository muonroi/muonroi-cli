import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../router/classifier/index.js", () => ({
  classify: vi.fn(),
}));

vi.mock("../ee/bridge.js", () => ({
  classifyViaBrain: vi.fn(),
}));

import { layer1Intent } from "./layer1-intent";
import { classify } from "../router/classifier/index.js";
import { classifyViaBrain } from "../ee/bridge.js";
import type { PipelineContext } from "./types";

const mockedClassify = vi.mocked(classify);
const mockedClassifyViaBrain = vi.mocked(classifyViaBrain);

function makeCtx(raw: string): PipelineContext {
  return {
    raw,
    enriched: raw,
    taskType: null,
    domain: null,
    confidence: 0,
    outputStyle: null,
    tokenBudget: 500,
    metrics: null,
    layers: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: brain returns null (no classification)
  mockedClassifyViaBrain.mockResolvedValue(null);
});

describe("layer1Intent", () => {
  it("maps short messages (≤80 chars) to taskType = 'general' via regex:short-message", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:short-message", confidence: 0.3 });

    const result = await layer1Intent(makeCtx("hi there"));

    expect(result.taskType).toBe("general");
    // Hot-path chitchat short-circuit promotes the message to chitchat (≤10
    // chars + ≤2 words AND no keyword match). It also bumps confidence to 0.5
    // and assigns intentKind="chitchat" so downstream layers can skip MCP.
    expect(result.confidence).toBe(0.5);
    expect(result.intentKind).toBe("chitchat");
  });

  it("does NOT trigger chitchat hot-path when classifier is high-confidence", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:short-message", confidence: 0.3 });
    // 11 chars, 3 words — fails hot-path constraints, stays plain "general".
    const result = await layer1Intent(makeCtx("hi how are"));
    expect(result.taskType).toBe("general");
    expect(result.intentKind).toBeFalsy();
  });

  it("returns taskType=null for no-match without keyword or brain hit", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    mockedClassifyViaBrain.mockResolvedValue(null);

    const result = await layer1Intent(makeCtx("lorem ipsum dolor sit amet"));

    expect(result.taskType).toBeNull();
  });

  it("applies keyword fallback (Pass 2) for debug-related messages", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });

    const result = await layer1Intent(makeCtx("there is a bug in the login flow"));

    expect(result.taskType).toBe("debug");
    expect(result.confidence).toBe(0.65);
  });

  it("applies keyword fallback (Pass 2) for plan-related messages", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });

    const result = await layer1Intent(makeCtx("let's plan the architecture for phase 3"));

    expect(result.taskType).toBe("plan");
    expect(result.confidence).toBe(0.6);
  });

  it("invokes brain classification (Pass 3) when taskType is null after Pass 2", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    mockedClassifyViaBrain.mockResolvedValue("generate, concise");

    const result = await layer1Intent(makeCtx("make me a new service"));

    expect(mockedClassifyViaBrain).toHaveBeenCalled();
    expect(result.taskType).toBe("generate");
    expect(result.confidence).toBe(0.55);
    expect(result.outputStyle).toBe("concise");
  });

  it("extracts domain from tree-sitter reason", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "tree-sitter:typescript", confidence: 0.9 });

    const result = await layer1Intent(makeCtx("refactor the handler function"));

    expect(result.taskType).toBe("refactor");
    expect(result.domain).toBe("typescript");
  });

  it("fails open on error — returns ctx unchanged with applied=false", async () => {
    mockedClassify.mockImplementation(() => {
      throw new Error("classifier crashed");
    });

    const ctx = makeCtx("test input");
    const result = await layer1Intent(ctx);

    expect(result.taskType).toBeNull();
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.applied).toBe(false);
  });
});
