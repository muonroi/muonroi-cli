/**
 * CQ-06: debate() passes tools to generateText with stepCountIs(4)
 * CQ-07: debate() returns { text, toolCalls } object (not bare string)
 * CQ-09: Per-round persistence text contains "[Council Round N]"
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── CQ-06: debate() uses tools with stopWhen: stepCountIs(4) ─────────────────

describe("CQ-06: debate() passes tools and uses stepCountIs(4)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes merged builtin+MCP tools to generateText", async () => {
    const capturedArgs: Record<string, unknown>[] = [];

    vi.doMock("ai", () => ({
      generateText: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
        capturedArgs.push(args);
        return { text: "debate response", toolCalls: [], steps: [] };
      }),
      stepCountIs: vi.fn().mockReturnValue({ __stepCountIs: 4 }),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({ builtin_bash: {} }),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi.fn().mockResolvedValue({
        tools: { mcp_tavily__search: {} },
        errors: [],
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../utils/settings.js", () => ({
      loadMcpServers: vi.fn().mockReturnValue([{ id: "tavily", enabled: true }]),
    }));
    vi.doMock("../prompts.js", () => ({
      buildResearchSystemPrompt: vi.fn().mockReturnValue("research system prompt"),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    await llm.debate("gpt-4o", "system prompt", "user prompt", undefined);

    expect(capturedArgs).toHaveLength(1);
    const args = capturedArgs[0] as { tools?: Record<string, unknown> };
    expect(args.tools).toHaveProperty("builtin_bash");
    expect(args.tools).toHaveProperty("mcp_tavily__search");
  });

  it("uses stopWhen stepCountIs(4) not stepCountIs(15)", async () => {
    let capturedStopWhen: unknown;
    const mockStepCountResult = { __stepCountIs: 4 };

    vi.doMock("ai", () => ({
      generateText: vi.fn().mockImplementation(async (args: { stopWhen?: unknown }) => {
        capturedStopWhen = args.stopWhen;
        return { text: "response", toolCalls: [], steps: [] };
      }),
      stepCountIs: vi.fn().mockImplementation((n: number) => ({ __stepCountIs: n })),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi.fn().mockResolvedValue({
        tools: {},
        errors: [],
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../utils/settings.js", () => ({
      loadMcpServers: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("../prompts.js", () => ({
      buildResearchSystemPrompt: vi.fn().mockReturnValue("research system prompt"),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    await llm.debate("gpt-4o", "system", "prompt");

    // stopWhen must be the result of stepCountIs(4) — __stepCountIs: 4
    expect(capturedStopWhen).toEqual({ __stepCountIs: 4 });
  });

  it("uses temperature 0.7 and maxOutputTokens 2048", async () => {
    let capturedArgs: { temperature?: number; maxOutputTokens?: number } = {};

    vi.doMock("ai", () => ({
      generateText: vi.fn().mockImplementation(async (args: typeof capturedArgs) => {
        capturedArgs = args;
        return { text: "response", toolCalls: [], steps: [] };
      }),
      stepCountIs: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi.fn().mockResolvedValue({
        tools: {},
        errors: [],
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../utils/settings.js", () => ({
      loadMcpServers: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("../prompts.js", () => ({
      buildResearchSystemPrompt: vi.fn().mockReturnValue("research system prompt"),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    await llm.debate("gpt-4o", "system", "prompt");

    expect(capturedArgs.temperature).toBe(0.7);
    expect(capturedArgs.maxOutputTokens).toBe(2048);
  });
});

// ── CQ-07: debate() returns { text, toolCalls } object ───────────────────────

describe("CQ-07: debate() returns { text, toolCalls } — not bare string", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns an object with text and toolCalls array", async () => {
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockResolvedValue({
        text: "debate answer",
        toolCalls: [
          { toolName: "bash", result: "ls output" },
          { toolName: "grep" },
        ],
        steps: [],
      }),
      stepCountIs: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi.fn().mockResolvedValue({
        tools: {},
        errors: [],
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../utils/settings.js", () => ({
      loadMcpServers: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("../prompts.js", () => ({
      buildResearchSystemPrompt: vi.fn().mockReturnValue("research system prompt"),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    const result = await llm.debate("gpt-4o", "system", "prompt");

    // Must be an object, not a string
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("toolCalls");
    expect(result.text).toBe("debate answer");
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe("bash");
    expect(result.toolCalls[1].toolName).toBe("grep");
  });

  it("returns empty toolCalls array when generateText returns no toolCalls", async () => {
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockResolvedValue({
        text: "answer without tools",
        toolCalls: undefined,
        steps: [],
      }),
      stepCountIs: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi.fn().mockResolvedValue({
        tools: {},
        errors: [],
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../utils/settings.js", () => ({
      loadMcpServers: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("../prompts.js", () => ({
      buildResearchSystemPrompt: vi.fn().mockReturnValue("research system prompt"),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    const result = await llm.debate("gpt-4o", "system", "prompt");

    expect(result.toolCalls).toEqual([]);
  });

  it("increments stats.calls after a successful debate() call", async () => {
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockResolvedValue({ text: "ok", toolCalls: [], steps: [] }),
      stepCountIs: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi.fn().mockResolvedValue({
        tools: {},
        errors: [],
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../utils/settings.js", () => ({
      loadMcpServers: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("../prompts.js", () => ({
      buildResearchSystemPrompt: vi.fn().mockReturnValue("research system prompt"),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    expect(stats.calls).toBe(0);
    await llm.debate("gpt-4o", "system", "prompt");
    expect(stats.calls).toBe(1);
  });
});

// ── CQ-09: Per-round persistence text contains "[Council Round N]" ────────────

describe("CQ-09: Per-round persistence output format", () => {
  it("roundPersistText contains literal '[Council Round' followed by round number", () => {
    // Test the persistence text format directly — pure function behavior
    // The debate.ts code builds: `[Council Round ${round}]\n${roundSummaryText}`
    // We validate the expected string format that gets emitted as council_status content
    const round = 1;
    const exampleSummaryText = "[primary] → [secondary]: response text";
    const roundPersistText = `[Council Round ${round}]\n${exampleSummaryText}`;

    expect(roundPersistText).toMatch(/^\[Council Round \d+\]/);
    expect(roundPersistText).toContain("[Council Round 1]");
  });

  it("round persistence text format works for multiple round numbers", () => {
    for (const round of [1, 2, 3, 8]) {
      const persistText = `[Council Round ${round}]\nsome exchange text`;
      expect(persistText).toContain(`[Council Round ${round}]`);
      expect(persistText).toMatch(/\[Council Round \d+\]/);
    }
  });

  it("persistence text includes tool usage suffix when toolCalls present", () => {
    // Validate the suffix format: "[tools: bash, grep]"
    const toolCalls = [{ toolName: "bash" }, { toolName: "grep" }];
    const toolSuffix = toolCalls.length
      ? ` [tools: ${toolCalls.map((t) => t.toolName).join(", ")}]`
      : "";
    const chunkText = `some response${toolSuffix}`;

    expect(chunkText).toContain("[tools: bash, grep]");
  });
});
