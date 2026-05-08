/**
 * CQ-10: debate-planner uses generateObject with one-retry fallback
 *
 * Tests that planDebate:
 * 1. Calls generateObject on first attempt (structured output)
 * 2. Retries once via tracedGenerate when generateObject fails
 * 3. Returns FALLBACK_PLAN after both attempts fail
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const FALLBACK_STANCES = ["Primary Analyst", "Critical Reviewer"];

describe("CQ-10: planDebate uses generateObject as first attempt", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls generateObject (not generateText) on first attempt", async () => {
    const mockGenerateObject = vi.fn().mockResolvedValue({
      object: {
        intentSummary: "Test intent",
        stances: [
          { name: "Analyst", lens: "Analyse the problem" },
          { name: "Critic", lens: "Challenge assumptions" },
        ],
        outputShape: {
          kind: "decision",
          sections: [{ key: "result", heading: "Result", prompt: "findings", shape: "text" as const }],
          guardrails: [],
        },
      },
    });

    vi.doMock("ai", () => ({
      generateObject: mockGenerateObject,
      generateText: vi.fn(),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../prompts.js", () => ({
      buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "prompt" }),
    }));

    const { planDebate } = await import("../debate-planner.js");

    const spec = {
      problemStatement: "test",
      constraints: [],
      successCriteria: [],
      scope: "test",
      rawQA: [],
    };

    // Consume the generator to get the return value
    const llm = {} as never;
    const gen = planDebate(spec, "gpt-4o", llm);
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }
    const plan = result.value;

    expect(mockGenerateObject).toHaveBeenCalledOnce();
    expect(plan.stances.length).toBeGreaterThanOrEqual(2);
    expect(plan.intentSummary).toBe("Test intent");
  });

  it("retries once with schema error feedback when generateObject fails", async () => {
    const mockGenerateObject = vi.fn().mockRejectedValue(new Error("Schema validation failed: missing stances"));

    const mockTracedGenerateLlm = {
      generate: vi.fn().mockResolvedValue(""),
    };

    // Capture what prompt the retry uses
    let capturedRetryPrompt: string | undefined;

    vi.doMock("ai", () => ({
      generateObject: mockGenerateObject,
      generateText: vi.fn(),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../prompts.js", () => ({
      buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "original-prompt" }),
    }));
    // Mock tracedGenerate to return valid JSON on retry
    vi.doMock("../llm.js", () => ({
      tracedGenerate: vi.fn().mockImplementation(async function* (_llm: unknown, opts: { prompt: string }) {
        capturedRetryPrompt = opts.prompt;
        yield { type: "content", content: "" };
        return JSON.stringify({
          intentSummary: "Retry intent",
          stances: [
            { name: "Analyst", lens: "Analyse" },
            { name: "Critic", lens: "Challenge" },
          ],
          outputShape: {
            kind: "decision",
            sections: [{ key: "r", heading: "Result", prompt: "r", shape: "text" }],
            guardrails: [],
          },
        });
      }),
    }));

    const { planDebate } = await import("../debate-planner.js");

    const spec = {
      problemStatement: "test",
      constraints: [],
      successCriteria: [],
      scope: "test",
      rawQA: [],
    };

    const llm = {} as never;
    const gen = planDebate(spec, "gpt-4o", llm);
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }
    const plan = result.value;

    // generateObject was tried
    expect(mockGenerateObject).toHaveBeenCalledOnce();
    // Retry prompt must contain schema error feedback
    expect(capturedRetryPrompt).toContain("Schema validation failed");
    // Should return the retry-parsed plan
    expect(plan.stances.length).toBeGreaterThanOrEqual(2);
  });

  it("returns FALLBACK_PLAN after both generateObject and retry fail", async () => {
    vi.doMock("ai", () => ({
      generateObject: vi.fn().mockRejectedValue(new Error("API error")),
      generateText: vi.fn(),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../prompts.js", () => ({
      buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "prompt" }),
    }));
    // tracedGenerate also fails
    vi.doMock("../llm.js", () => ({
      tracedGenerate: vi.fn().mockImplementation(async function* () {
        throw new Error("Retry also failed");
      }),
    }));

    const { planDebate } = await import("../debate-planner.js");

    const spec = {
      problemStatement: "test",
      constraints: [],
      successCriteria: [],
      scope: "test",
      rawQA: [],
    };

    const llm = {} as never;
    const gen = planDebate(spec, "gpt-4o", llm);
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }
    const plan = result.value;

    // Must be FALLBACK_PLAN — check by known stance names
    expect(plan.stances.map((s: { name: string }) => s.name)).toEqual(FALLBACK_STANCES);
  });

  it("schema error text is sliced to 200 chars in retry prompt (T-15-07 threat mitigation)", async () => {
    const longError = "x".repeat(500);
    vi.doMock("ai", () => ({
      generateObject: vi.fn().mockRejectedValue(new Error(longError)),
      generateText: vi.fn(),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../prompts.js", () => ({
      buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "prompt" }),
    }));

    let capturedPrompt = "";
    vi.doMock("../llm.js", () => ({
      tracedGenerate: vi.fn().mockImplementation(async function* (_llm: unknown, opts: { prompt: string }) {
        capturedPrompt = opts.prompt;
        throw new Error("retry fail");
      }),
    }));

    const { planDebate } = await import("../debate-planner.js");

    const spec = { problemStatement: "test", constraints: [], successCriteria: [], scope: "test", rawQA: [] };
    const gen = planDebate(spec, "gpt-4o", {} as never);
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    // The injected error feedback must not exceed 200 chars (T-15-07)
    const errorInPrompt = capturedPrompt.slice(capturedPrompt.indexOf("Schema validation failed:") + "Schema validation failed: ".length);
    // First token after "Schema validation failed: " must be at most 200 chars before next period/sentence
    // Simple check: the injected error segment is <= 200 chars
    const match = capturedPrompt.match(/Schema validation failed: (.{1,220})/);
    expect(match).toBeTruthy();
    const injected = match![1].split(".")[0]; // up to first period
    expect(injected.length).toBeLessThanOrEqual(205); // small buffer for "." suffix
  });
});
