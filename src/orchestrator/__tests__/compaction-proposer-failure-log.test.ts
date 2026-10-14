import { beforeEach, describe, expect, it, vi } from "vitest";

// Captured `logger.warn` args, one entry per call.
const warnCalls: Array<{ msg: string; ctx: Record<string, unknown> | undefined }> = [];

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((_ns: string, msg: string, ctx?: Record<string, unknown>) => {
      warnCalls.push({ msg, ctx });
    }),
    error: vi.fn(),
  },
}));

vi.mock("../../providers/streamed-generate.js", () => ({
  generateTextStreamed: vi.fn(async () => {
    throw new Error("provider connection reset");
  }),
}));

vi.mock("../../providers/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/runtime.js")>();
  return {
    ...actual,
    resolveModelRuntime: vi.fn(() => ({
      modelId: "stub-model",
      model: { id: "stub-model" },
      modelInfo: { id: "stub-model", provider: "openai" },
      providerOptions: undefined,
      unsupportedParams: [],
    })),
  };
});

import { proposeCompaction } from "../compaction.js";

describe("proposeCompaction — Proposer failure log carries the error message", () => {
  beforeEach(() => {
    warnCalls.length = 0;
  });

  it("logs err.message, not an Error object that serializes to '{}'", async () => {
    const result = await proposeCompaction("stub-model", [{ role: "user", content: "hi" }]);

    expect(result).toBeNull();
    const proposerFailureCall = warnCalls.find((c) => c.msg === "Proposer failure");
    expect(proposerFailureCall).toBeDefined();

    // Red-before-fix: `{ error: err }` where err is an Error instance.
    // JSON.stringify(new Error("x")) === "{}" because message/stack are
    // non-enumerable — appendToFile/formatConsole (src/utils/logger.ts) both
    // JSON.stringify the ctx, so the cause was silently dropped. Green: the
    // logged `error` field is the actual message string.
    expect(proposerFailureCall!.ctx?.error).toBe("provider connection reset");
    expect(typeof proposerFailureCall!.ctx?.error).toBe("string");

    // Prove the historical bug is gone: JSON.stringify of the logged ctx must
    // NOT collapse to an empty object the way `{ error: new Error(...) }` did.
    expect(JSON.stringify(proposerFailureCall!.ctx)).not.toBe("{}");
  });
});
