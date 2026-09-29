/**
 * `proposeCompaction`'s docstring (compaction.ts:52) contracts: "Returns null
 * if the proposer call fails (caller should fall back gracefully)." Prior to
 * this fix, that contract only held for the `generateTextStreamed` call
 * itself — the JSON-extraction/parse/validation block after it (compaction.ts
 * ~141-160) was bare, no try/catch.
 *
 * Measured failure mode: the greedy `/\{[\s\S]*\}/` regex matches from the
 * FIRST `{` to the LAST `}` in the proposer's raw text. A proposer reply like
 * "I'll keep {message 1} and drop {message 2}" (conversational prose
 * containing multiple brace-delimited fragments instead of strict JSON)
 * therefore extracts `{message 1} and drop {message 2}` — not valid JSON —
 * and `JSON.parse` throws a `SyntaxError`. Neither `compactForContext`
 * (orchestrator.ts:2074) nor its own caller (tool-engine.ts:1221) has a
 * try/catch around this specific await, so the exception used to propagate
 * uncaught all the way to the turn-level catch (tool-engine.ts:4816),
 * surfacing a raw JSON parse error to the user instead of silently falling
 * back to the heuristic compaction path.
 */
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

// Controllable per-test response text for the mocked proposer call.
let mockResponseText = '{"shouldCompact":false,"reason":"not needed","actions":[]}';

vi.mock("../../providers/streamed-generate.js", () => ({
  generateTextStreamed: vi.fn(async () => ({ text: mockResponseText, usage: undefined })),
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

describe("proposeCompaction — malformed proposer JSON must not throw (contract: return null)", () => {
  beforeEach(() => {
    warnCalls.length = 0;
    mockResponseText = '{"shouldCompact":false,"reason":"not needed","actions":[]}';
  });

  it("returns null (not a thrown SyntaxError) when the proposer replies with prose containing multiple brace fragments", async () => {
    mockResponseText = "I'll keep {message 1} and drop {message 2}";

    // Red-before-fix: this `await` used to reject with a SyntaxError
    // ("Unexpected token ...") instead of resolving to null.
    await expect(proposeCompaction("stub-model", [{ role: "user", content: "hi" }])).resolves.toBeNull();

    const warnCall = warnCalls.find((c) => c.msg === "Failed to parse or validate proposer JSON");
    expect(warnCall).toBeDefined();
    expect(typeof warnCall!.ctx?.error).toBe("string");
  });

  it("returns null (not a thrown TypeError) when the proposer's actions array contains a malformed entry", async () => {
    mockResponseText = '{"shouldCompact":true,"reason":"go","actions":[null]}';

    await expect(proposeCompaction("stub-model", [{ role: "user", content: "hi" }])).resolves.toBeNull();
  });

  it("still parses a well-formed proposer response correctly (no regression)", async () => {
    mockResponseText =
      '{"shouldCompact":true,"reason":"context is large","actions":[{"messageIndex":0,"action":"drop","reason":"stale"}]}';

    const result = await proposeCompaction("stub-model", [{ role: "user", content: "hi" }]);

    expect(result).toEqual({
      shouldCompact: true,
      reason: "context is large",
      actions: [{ messageIndex: 0, action: "drop", reason: "stale" }],
    });
  });
});
