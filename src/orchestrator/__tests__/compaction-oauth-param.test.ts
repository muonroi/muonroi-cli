import { beforeEach, describe, expect, it, vi } from "vitest";

// Captured `generateTextStreamed` args, one entry per call.
const calls: Array<Record<string, unknown>> = [];

vi.mock("../../providers/streamed-generate.js", () => ({
  generateTextStreamed: vi.fn(async (args: Record<string, unknown>) => {
    calls.push(args);
    return { text: '{"shouldCompact":false,"reason":"n/a","actions":[]}', usage: undefined };
  }),
}));

// Keep the REAL capability layer and the REAL `shouldDropParam` (that is the
// unit under test); stub only the runtime resolution so the test can hand the
// compaction path an OAuth-shaped runtime.
//
// Session bce44da8134d / sub-session 3f998bfef7db: ChatGPT Codex OAuth
// (`https://chatgpt.com/backend-api/codex/responses`) answered HTTP 400
// `{"detail":"Unsupported parameter: max_output_tokens"}`. The provider
// REGISTRY marks the param unsupported (`unsupportedParams`), while the model
// CATALOG says gpt-5.4-mini accepts it — so a call site that consults only
// `capabilities.acceptsParam()` still sends it and 400s.
vi.mock("../../providers/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/runtime.js")>();
  return {
    ...actual,
    resolveModelRuntime: vi.fn(() => ({
      modelId: "oauth-model",
      model: { id: "oauth-model" },
      // Catalog side says the param is fine — only the OAuth registry objects.
      modelInfo: { id: "oauth-model", provider: "openai", supportsMaxOutputTokens: true },
      providerOptions: undefined,
      unsupportedParams: ["maxOutputTokens"],
    })),
    requireRuntimeProvider: vi.fn(() => "openai"),
  };
});

import { generateCompactionSummary, proposeCompaction } from "../compaction.js";

describe("compaction honours OAuth unsupportedParams (ChatGPT Codex 400)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("omits maxOutputTokens from the compaction proposer call", async () => {
    await proposeCompaction("oauth-model", [{ role: "user", content: "hi" }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("maxOutputTokens");
  });

  it("omits maxOutputTokens from the compaction summary call", async () => {
    await generateCompactionSummary("oauth-model", {
      messagesToSummarize: [{ role: "user", content: "hi" }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      previousSummary: undefined,
      settings: { reserveTokens: 4096 },
    } as unknown as Parameters<typeof generateCompactionSummary>[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("maxOutputTokens");
  });
});
