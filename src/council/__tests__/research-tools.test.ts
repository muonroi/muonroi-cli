import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildResearchSystemPrompt } from "../prompts.js";

// ── CQ-05: buildResearchSystemPrompt pure-function tests ─────────────────────

describe("CQ-05: buildResearchSystemPrompt", () => {
  it("contains all 3 required section headings", () => {
    const prompt = buildResearchSystemPrompt(false);
    expect(prompt).toContain("## Source Code Findings");
    expect(prompt).toContain("## Internet Findings");
    expect(prompt).toContain("## Frontend Findings (live)");
  });

  it("injects URL Research Requirement when hasUrl=true", () => {
    const prompt = buildResearchSystemPrompt(true);
    expect(prompt).toContain("URL Research Requirement");
    // Browser-tool surface is referenced (Playwright / Chrome-DevTools).
    expect(/playwright|chrome-devtools/i.test(prompt)).toBe(true);
  });

  it("does NOT inject URL instruction when hasUrl=false", () => {
    const prompt = buildResearchSystemPrompt(false);
    expect(prompt).not.toContain("URL Research Requirement");
  });

  it("contains citation format instructions for all 3 sections", () => {
    const prompt = buildResearchSystemPrompt(false);
    // Source Code Findings citation format
    expect(prompt).toContain("[file:line]");
    // Internet Findings citation format
    expect(prompt).toContain("[url]");
    // Frontend Findings citation format
    expect(prompt).toContain("[snapshot:uid]");
  });
});

// ── CQ-04 + CQ-03: createCouncilLLM.research() integration-style tests ──────

describe("CQ-04: research() URL detection and gap annotation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("appends gap annotation when topic contains URL but no browser tool invoked", async () => {
    // Mock ai generateText to return result with no browser tool calls
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockResolvedValue({
        text: "## Source Code Findings\nFound nothing.\n\n## Internet Findings\nFound nothing.\n\n## Frontend Findings (live)\nNot performed.",
        toolCalls: [],
        steps: [],
      }),
      stepCountIs: vi.fn().mockReturnValue({}),
    }));

    // Mock provider/key dependencies so createCouncilLLM doesn't require real keys
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({
        factory: {},
      }),
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({
        model: {},
        providerOptions: undefined,
      }),
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

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    // bash and mode are not used in the mocked code paths
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    const result = await llm.research("gpt-4o", "Check https://example.com for issues", "", undefined);

    expect(result).toContain("## Research Gap");
    expect(result).toContain("no browser tool was invoked");
    expect(stats.calls).toBe(1);
  });

  it("does NOT append gap annotation when topic has no URL", async () => {
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockResolvedValue({
        text: "## Source Code Findings\nFound something.\n\n## Internet Findings\nNone.\n\n## Frontend Findings (live)\nNone.",
        toolCalls: [],
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
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
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

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    const result = await llm.research("gpt-4o", "What is the council architecture?", "", undefined);

    expect(result).not.toContain("## Research Gap");
    expect(stats.calls).toBe(1);
  });
});

describe("CQ-03: research() MCP tool merge", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("merges MCP tools with builtin tools when buildMcpToolSet returns a bundle", async () => {
    const capturedTools: Record<string, unknown> = {};

    vi.doMock("ai", () => ({
      generateText: vi.fn().mockImplementation(async (args: { tools?: Record<string, unknown> }) => {
        if (args.tools) {
          Object.assign(capturedTools, args.tools);
        }
        return {
          text: "## Source Code Findings\nNone.\n\n## Internet Findings\nNone.\n\n## Frontend Findings (live)\nNone.",
          toolCalls: [],
          steps: [],
        };
      }),
      stepCountIs: vi.fn().mockReturnValue({}),
    }));

    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
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

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    await llm.research("gpt-4o", "What are best practices for TypeScript?", "", undefined);

    // Both builtin and MCP tools must be present in the generateText call
    expect(capturedTools).toHaveProperty("builtin_bash");
    expect(capturedTools).toHaveProperty("mcp_tavily__search");
  });

  it("falls back to builtin tools only when MCP spawn fails", async () => {
    const capturedTools: Record<string, unknown> = {};

    vi.doMock("ai", () => ({
      generateText: vi.fn().mockImplementation(async (args: { tools?: Record<string, unknown> }) => {
        if (args.tools) {
          Object.assign(capturedTools, args.tools);
        }
        return {
          text: "## Source Code Findings\nNone.\n\n## Internet Findings\nNone.\n\n## Frontend Findings (live)\nNone.",
          toolCalls: [],
          steps: [],
        };
      }),
      stepCountIs: vi.fn().mockReturnValue({}),
    }));

    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({ builtin_bash: {} }),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi.fn().mockRejectedValue(new Error("MCP spawn failed")),
    }));
    vi.doMock("../../utils/settings.js", () => ({
      loadMcpServers: vi.fn().mockReturnValue([{ id: "tavily", enabled: true }]),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    // Should not throw; falls back to builtins
    const result = await llm.research("gpt-4o", "Some topic", "", undefined);

    expect(result).not.toContain("Research failed");
    expect(capturedTools).toHaveProperty("builtin_bash");
    expect(capturedTools).not.toHaveProperty("mcp_tavily__search");
    expect(stats.calls).toBe(1);
  });
});
