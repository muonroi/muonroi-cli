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

import { recordUsageEvent } from "../../storage/index.js";
import { logger } from "../../utils/logger.js";
import { recordCouncilUsage } from "../llm.js";

const mockRecord = recordUsageEvent as ReturnType<typeof vi.fn>;
const mockLogError = logger.error as ReturnType<typeof vi.fn>;

describe("recordCouncilUsage", () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockLogError.mockReset();
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
});
