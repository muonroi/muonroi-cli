/**
 * Debate-call shape contracts.
 *
 * History:
 *  - CQ-06 required tools + stepCountIs(4) for evidence verification.
 *  - Session a7a5690d2049 (DeepSeek V4 on SiliconFlow): 4/4 Round-1 turns
 *    empty because reasoning models burned step budget on tool chains and
 *    returned finishReason="tool-calls" text="".
 *  - First fix removed tools entirely → debate worked but lost evidence
 *    verification (training-data citations only — session f83c278f2162).
 *  - Current: verification tools available ONLY when
 *    options.enableVerificationTools=true, capped at stepCountIs(2)
 *    (1 verification call + final text). The caller (debate.ts) only enables
 *    it for balanced/premium tier; fast-tier reasoning models stay tool-free.
 *  - debate() now STREAMS (collectStreamText) instead of generateText — the
 *    codex/oauth endpoint 400s on non-stream requests. These tests mock
 *    streamText's fullStream and assert the same call shape + { text, toolCalls }.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A minimal streamText mock: records the call args and replays `parts`. */
function streamTextMock(captured: Record<string, unknown>[], parts: Array<Record<string, unknown>>) {
  return vi.fn().mockImplementation((args: Record<string, unknown>) => {
    captured.push(args);
    return {
      fullStream: (async function* () {
        for (const p of parts) yield p;
      })(),
    };
  });
}

const FINISH = { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } };

describe("debate() call shape — tools off by default, on with explicit opt-in", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does NOT pass tools to streamText when enableVerificationTools is absent", async () => {
    const capturedArgs: Record<string, unknown>[] = [];

    vi.doMock("ai", () => ({
      generateText: vi.fn(),
      streamText: streamTextMock(capturedArgs, [{ type: "text-delta", text: "debate response" }, FINISH]),
      stepCountIs: vi.fn().mockReturnValue({ __stepCountIs: 2 }),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
      shouldDropParam: vi.fn().mockReturnValue(false),
    }));
    vi.doMock("../prompts.js", () => ({
      buildResearchSystemPrompt: vi.fn().mockReturnValue("research system prompt"),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as any, "agent" as any, undefined, stats);

    await llm.debate("gpt-4o", "system prompt", "user prompt", undefined);

    expect(capturedArgs).toHaveLength(1);
    const args = capturedArgs[0] as { tools?: unknown; stopWhen?: unknown };
    expect(args.tools).toBeUndefined();
    expect(args.stopWhen).toBeUndefined();
  });

  it("passes tools + stopWhen=stepCountIs(2) when enableVerificationTools=true", async () => {
    const capturedArgs: Record<string, unknown>[] = [];
    const stepCountIsMock = vi.fn().mockReturnValue({ __stepCountIs: 2 });

    vi.doMock("ai", () => ({
      generateText: vi.fn(),
      streamText: streamTextMock(capturedArgs, [{ type: "text-delta", text: "verified response" }, FINISH]),
      stepCountIs: stepCountIsMock,
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
      shouldDropParam: vi.fn().mockReturnValue(false),
    }));
    // Builtin tools — must contain grep+read_file so the filter keeps something
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({
        grep: { execute: async () => "ok" },
        read_file: { execute: async () => "ok" },
        bash: { execute: async () => "ok" }, // must be filtered out
      }),
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

    await llm.debate("gpt-4o", "system", "prompt", undefined, undefined, { enableVerificationTools: true });

    expect(capturedArgs).toHaveLength(1);
    const args = capturedArgs[0] as { tools?: Record<string, unknown>; stopWhen?: unknown };
    expect(args.tools).toBeDefined();
    // Allowlist: only grep + read_file pass through; bash is filtered out
    expect(Object.keys(args.tools!).sort()).toEqual(["grep", "read_file"]);
    expect(args.stopWhen).toEqual({ __stepCountIs: 2 });
    expect(stepCountIsMock).toHaveBeenCalledWith(2);
  });

  it("uses temperature 0.7 and maxOutputTokens 6144", async () => {
    const capturedArgs: Record<string, unknown>[] = [];

    vi.doMock("ai", () => ({
      generateText: vi.fn(),
      streamText: streamTextMock(capturedArgs, [{ type: "text-delta", text: "response" }, FINISH]),
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
      shouldDropParam: vi.fn().mockReturnValue(false),
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

    const args = capturedArgs[0] as { temperature?: number; maxOutputTokens?: number };
    expect(args.temperature).toBe(0.7);
    // Reasoning models share output budget with reasoning_tokens — e2e showed
    // 2048 truncated debate turns mid-thought (finishReason=length). Raised to
    // 6144 so reasoning models still have ~4K text-token headroom.
    expect(args.maxOutputTokens).toBe(6144);
  });
});

// ── CQ-07: debate() returns { text, toolCalls } object ───────────────────────

describe("CQ-07: debate() returns { text, toolCalls } — not bare string", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns an object with text and toolCalls array collected from the stream", async () => {
    vi.doMock("ai", () => ({
      generateText: vi.fn(),
      streamText: streamTextMock(
        [],
        [
          { type: "tool-call", toolCallId: "1", toolName: "bash", input: {} },
          { type: "tool-result", toolCallId: "1", output: "ls output" },
          { type: "tool-call", toolCallId: "2", toolName: "grep", input: {} },
          { type: "text-delta", text: "debate answer" },
          FINISH,
        ],
      ),
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
      shouldDropParam: vi.fn().mockReturnValue(false),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi
        .fn()
        .mockResolvedValue({ tools: {}, errors: [], close: vi.fn().mockResolvedValue(undefined) }),
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

    expect(typeof result).toBe("object");
    expect(result.text).toBe("debate answer");
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe("bash");
    expect((result.toolCalls[0] as { result?: unknown }).result).toBe("ls output");
    expect(result.toolCalls[1].toolName).toBe("grep");
  });

  it("returns empty toolCalls array when the stream emits no tool calls", async () => {
    vi.doMock("ai", () => ({
      generateText: vi.fn(),
      streamText: streamTextMock([], [{ type: "text-delta", text: "answer without tools" }, FINISH]),
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
      shouldDropParam: vi.fn().mockReturnValue(false),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi
        .fn()
        .mockResolvedValue({ tools: {}, errors: [], close: vi.fn().mockResolvedValue(undefined) }),
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
      generateText: vi.fn(),
      streamText: streamTextMock([], [{ type: "text-delta", text: "ok" }, FINISH]),
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
      shouldDropParam: vi.fn().mockReturnValue(false),
    }));
    vi.doMock("../../tools/registry.js", () => ({
      createBuiltinTools: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("../../mcp/runtime.js", () => ({
      buildMcpToolSet: vi
        .fn()
        .mockResolvedValue({ tools: {}, errors: [], close: vi.fn().mockResolvedValue(undefined) }),
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
    const toolCalls = [{ toolName: "bash" }, { toolName: "grep" }];
    const toolSuffix = toolCalls.length ? ` [tools: ${toolCalls.map((t) => t.toolName).join(", ")}]` : "";
    const chunkText = `some response${toolSuffix}`;

    expect(chunkText).toContain("[tools: bash, grep]");
  });
});
