/**
 * Council usage accounting contract.
 *
 * Guards the fix for session f24c28b6dcb3: council LLM calls (the /council slash
 * path, auto-council, and every /ideal phase) were writing only to the cost-log
 * JSONL and never to the `usage_events` table, so their token cost was invisible
 * to session totals, the StatusBar, `usage forensics`, and the cost caps.
 *
 * The recording is now centralized in `recordCouncilUsage` (src/council/llm.ts),
 * called from generate/debate/research. These tests pin its three branches:
 * records on a real session, skips when there is no session FK, and never
 * rethrows on a storage failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage/index.js", () => ({
  recordUsageEvent: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../state/status-bar-store.js", () => {
  const state = {
    in_tokens: 0,
    out_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    session_usd: 0,
    ctx_tokens: 99,
    ctx_pct: 42,
    model: "main-model",
  };
  return {
    statusBarStore: {
      getState: () => state,
      setState: vi.fn((p: Record<string, unknown>) => Object.assign(state, p)),
      __state: state,
    },
  };
});
vi.mock("../../models/registry.js", () => ({
  getModelInfo: () => ({ inputPrice: 1, outputPrice: 2, cachedInputPrice: 0.1 }),
}));

import { statusBarStore } from "../../state/status-bar-store.js";
import { recordUsageEvent } from "../../storage/index.js";
import { logger } from "../../utils/logger.js";
import { recordCouncilUsage } from "../llm.js";

const mockRecord = recordUsageEvent as ReturnType<typeof vi.fn>;
const mockLogError = logger.error as ReturnType<typeof vi.fn>;
const mockStatusBar = statusBarStore as unknown as {
  __state: Record<string, number | string>;
  setState: ReturnType<typeof vi.fn>;
};

describe("recordCouncilUsage", () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockLogError.mockReset();
    mockStatusBar.setState.mockClear();
    // Reset the StatusBar mock's accumulator state so each test's assertions
    // on cumulative counters (in_tokens, session_usd, etc.) are order-independent
    // — otherwise an earlier test's recordCouncilUsage call (which also now
    // touches the StatusBar) would silently pollute a later test's totals.
    Object.assign(mockStatusBar.__state, {
      in_tokens: 0,
      out_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      session_usd: 0,
      ctx_tokens: 99,
      ctx_pct: 42,
      model: "main-model",
    });
  });

  it('records a source="council" usage_events row mapping cachedInputTokens → cacheReadTokens', () => {
    recordCouncilUsage("sess-1", "deepseek-v4-flash", {
      inputTokens: 1200,
      outputTokens: 800,
      cachedInputTokens: 400,
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [sessionId, source, modelId, usage] = mockRecord.mock.calls[0]!;
    expect(sessionId).toBe("sess-1");
    expect(source).toBe("council");
    expect(modelId).toBe("deepseek-v4-flash");
    expect(usage).toEqual({ inputTokens: 1200, outputTokens: 800, cacheReadTokens: 400 });
  });

  it("skips recording when there is no session id (no chat-session FK)", () => {
    recordCouncilUsage(undefined, "deepseek-v4-flash", {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
    });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("swallows a storage failure but logs it (No Silent Catch)", () => {
    mockRecord.mockImplementation(() => {
      throw new Error("db locked");
    });

    expect(() =>
      recordCouncilUsage("sess-2", "deepseek-v4-flash", {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
      }),
    ).not.toThrow();

    expect(mockLogError).toHaveBeenCalledTimes(1);
    const [ns, msg, ctx] = mockLogError.mock.calls[0]!;
    expect(ns).toBe("storage");
    expect(String(msg)).toContain("recordUsageEvent(council) failed");
    expect((ctx as { message?: string }).message).toContain("db locked");
  });

  it("accumulates council billing into the StatusBar without touching ctx/model", () => {
    const store = statusBarStore as unknown as {
      __state: Record<string, number | string>;
      setState: ReturnType<typeof vi.fn>;
    };
    recordCouncilUsage("sess-1", "deepseek-v4-flash", { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400 });

    // Billing counters accumulated (in_tokens += 1000, out += 200, cacheRead += 400).
    expect(store.__state.in_tokens).toBe(1000);
    expect(store.__state.out_tokens).toBe(200);
    expect(store.__state.cache_read_tokens).toBe(400);
    // usd = (nonCached 600 * 1 + cached 400 * 0.1 + out 200 * 2) / 1e6 = (600 + 40 + 400)/1e6 = 0.00104
    expect(store.__state.session_usd).toBeCloseTo(0.00104, 8);
    // Context-fill + model MUST be untouched.
    expect(store.__state.ctx_tokens).toBe(99);
    expect(store.__state.ctx_pct).toBe(42);
    expect(store.__state.model).toBe("main-model");
    // setState was NOT called with any of the forbidden keys.
    for (const call of store.setState.mock.calls) {
      const keys = Object.keys(call[0] as object);
      expect(keys).not.toContain("ctx_tokens");
      expect(keys).not.toContain("ctx_pct");
      expect(keys).not.toContain("model");
      expect(keys).not.toContain("provider");
    }
  });

  it("skips StatusBar update when there is no session id", () => {
    const store = statusBarStore as unknown as { setState: ReturnType<typeof vi.fn> };
    store.setState.mockClear();
    recordCouncilUsage(undefined, "deepseek-v4-flash", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
    expect(store.setState).not.toHaveBeenCalled();
  });
});
