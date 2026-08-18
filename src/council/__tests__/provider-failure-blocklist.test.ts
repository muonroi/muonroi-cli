/**
 * Council provider-call failure recording (Fix 1) + entitlement blocklist
 * consumption (Fix 2).
 *
 * Live evidence: session 947db934b573, ~/.muonroi-cli/debug.log:480 —
 * opencode-go returned HTTP 403 `{"type":"error","error":{"type":"RegionError"}}`
 * ("only available hosted in China…") for opencode/deepseek-v4-flash, with the
 * AI SDK error carrying `isRetryable:false`. Before this fix the council path's
 * ONLY writer for a provider failure was debug.log — `usage forensics` and
 * every DB-based analysis were blind to it — and a later utility call in the
 * same run could pick the same doomed model again.
 *
 * These tests exercise the real `recordCouncilProviderFailure` (via the
 * `__testRecordCouncilProviderFailure` test hook — mirrors the existing
 * `__testCollectStreamText` pattern in llm.ts) and the real
 * `tracedGenerateWithFallback` / `researchWithFallback` consumers, with
 * `logInteraction` mocked so no real DB is touched (same pattern as
 * council-usage.test.ts).
 */
import { APICallError } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage/index.js", () => ({
  logInteraction: vi.fn(),
  recordUsageEvent: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../state/status-bar-store.js", () => ({
  statusBarStore: {
    getState: () => ({ in_tokens: 0, out_tokens: 0, cache_read_tokens: 0, session_usd: 0 }),
    setState: vi.fn(),
  },
}));

vi.mock("../../models/registry.js", () => ({
  getModelInfo: () => ({ inputPrice: 1, outputPrice: 2, cachedInputPrice: 0.1 }),
}));

import { logInteraction } from "../../storage/index.js";
import type { StreamChunk } from "../../types/index.js";
import { researchWithFallback } from "../debate.js";
import { __testRecordCouncilProviderFailure, tracedGenerateWithFallback } from "../llm.js";
import {
  blockModel,
  clearModelBlocklist,
  consumeBlockNotification,
  formatBlockedModelWarning,
  getBlockedModel,
  isModelBlocked,
} from "../model-blocklist.js";
import type { CouncilLLM } from "../types.js";

const mockLogInteraction = logInteraction as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockLogInteraction.mockReset();
  clearModelBlocklist();
});

function regionErrorApiError(statusCode: number, isRetryable?: boolean): APICallError {
  return new APICallError({
    message:
      "The latest version of this model is only available hosted in China and requires explicit opt in: https://opencode.ai/workspace/wrk_01KWGWER",
    url: "https://opencode.ai/zen/v1/chat/completions",
    requestBodyValues: { model: "opencode/deepseek-v4-flash" },
    statusCode,
    responseBody: '{"type":"error","error":{"type":"RegionError"}}',
    isRetryable,
  });
}

async function drain<T>(gen: AsyncGenerator<StreamChunk, T, unknown>): Promise<{ chunks: StreamChunk[]; result: T }> {
  const chunks: StreamChunk[] = [];
  let r: IteratorResult<StreamChunk, T>;
  do {
    r = await gen.next();
    if (!r.done) chunks.push(r.value);
  } while (!r.done);
  return { chunks, result: r.value };
}

describe("recordCouncilProviderFailure (Fix 1 + Fix 2)", () => {
  it("a 403 + isRetryable:false writes an interaction_logs row carrying the status code and blocklists the model", () => {
    __testRecordCouncilProviderFailure({
      sessionId: "sess-1",
      kind: "generate",
      modelId: "opencode/deepseek-v4-flash",
      resolvedModelId: "opencode/deepseek-v4-flash",
      providerId: "opencode-go",
      durationMs: 316,
      aborted: false,
      err: regionErrorApiError(403, false),
    });

    expect(mockLogInteraction).toHaveBeenCalledTimes(1);
    const [sessionId, eventType, meta] = mockLogInteraction.mock.calls[0]!;
    expect(sessionId).toBe("sess-1");
    expect(eventType).toBe("error");
    expect(meta.eventSubtype).toBe("council_generate_auth");
    expect(meta.model).toBe("opencode/deepseek-v4-flash");
    expect(meta.durationMs).toBe(316);
    expect(meta.data.provider).toBe("opencode-go");
    expect(meta.data.aborted).toBe(false);
    expect(meta.data.forensics.statusCode).toBe(403);
    expect(meta.data.forensics.isRetryable).toBe(false);

    expect(isModelBlocked("sess-1", "opencode/deepseek-v4-flash")).toBe(true);
    expect(getBlockedModel("sess-1", "opencode/deepseek-v4-flash")?.statusCode).toBe(403);
  });

  it("a 401 + isRetryable:false also blocklists (same entitlement/auth class as 403)", () => {
    __testRecordCouncilProviderFailure({
      sessionId: "sess-1",
      kind: "debate",
      modelId: "some/model",
      resolvedModelId: "some/model",
      providerId: "opencode-go",
      durationMs: 50,
      aborted: false,
      err: regionErrorApiError(401, false),
    });
    expect(isModelBlocked("sess-1", "some/model")).toBe(true);
  });

  it("a 429 writes the failure row (Fix 1 is universal) but does NOT blocklist the model (transient — must keep retrying)", () => {
    __testRecordCouncilProviderFailure({
      sessionId: "sess-2",
      kind: "research",
      modelId: "some/model",
      resolvedModelId: "some/model",
      providerId: "siliconflow",
      durationMs: 900,
      aborted: false,
      err: new APICallError({
        message: "rate limited",
        url: "https://api.siliconflow.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      }),
    });

    expect(mockLogInteraction).toHaveBeenCalledTimes(1);
    const [, , meta] = mockLogInteraction.mock.calls[0]!;
    expect(meta.data.forensics.statusCode).toBe(429);
    expect(isModelBlocked("sess-2", "some/model")).toBe(false);
  });

  it("a plain-Error timeout (no HTTP status at all) writes the failure row but does NOT blocklist", () => {
    __testRecordCouncilProviderFailure({
      sessionId: "sess-3",
      kind: "generate",
      modelId: "some/model",
      resolvedModelId: "some/model",
      providerId: "deepseek",
      durationMs: 300_000,
      aborted: false,
      err: new Error("The operation timed out."),
    });

    expect(mockLogInteraction).toHaveBeenCalledTimes(1);
    const [, , meta] = mockLogInteraction.mock.calls[0]!;
    // No APICallError → summarizeApiErrorForLog returns null → no forensics key at all.
    expect(meta.data.forensics).toBeUndefined();
    expect(meta.data.message).toContain("timed out");
    expect(isModelBlocked("sess-3", "some/model")).toBe(false);
  });

  it("an aborted call (user cancel) is recorded but not blocklisted", () => {
    __testRecordCouncilProviderFailure({
      sessionId: "sess-4",
      kind: "debate",
      modelId: "some/model",
      resolvedModelId: "some/model",
      providerId: "deepseek",
      durationMs: 1200,
      aborted: true,
      err: new DOMException("aborted", "AbortError"),
    });
    expect(mockLogInteraction).toHaveBeenCalledTimes(1);
    expect(mockLogInteraction.mock.calls[0]![2].data.aborted).toBe(true);
    expect(isModelBlocked("sess-4", "some/model")).toBe(false);
  });

  it("a DB write failure does not propagate out of the recorder (No Silent Catch, best-effort)", () => {
    mockLogInteraction.mockImplementation(() => {
      throw new Error("db locked");
    });
    expect(() =>
      __testRecordCouncilProviderFailure({
        sessionId: "sess-5",
        kind: "generate",
        modelId: "some/model",
        resolvedModelId: "some/model",
        providerId: "deepseek",
        durationMs: 10,
        aborted: false,
        err: regionErrorApiError(403, false),
      }),
    ).not.toThrow();
    // The blocklist side effect must still happen even though the DB write failed.
    expect(isModelBlocked("sess-5", "some/model")).toBe(true);
  });
});

/** Build a CouncilLLM whose blocklist methods are wired to the REAL model-blocklist module, scoped to `scope`. */
function makeScopedLlm(scope: string, generateImpl: (modelId: string) => Promise<string>): CouncilLLM {
  return {
    generate: async (modelId: string) => generateImpl(modelId),
    debate: async () => ({ text: "", toolCalls: [] }),
    research: async () => "",
    isModelBlocked: (modelId: string) => isModelBlocked(scope, modelId),
    takeModelBlockWarning: (modelId: string) => {
      const info = getBlockedModel(scope, modelId);
      if (!info) return undefined;
      if (!consumeBlockNotification(scope, modelId)) return undefined;
      return formatBlockedModelWarning(info);
    },
  };
}

describe("tracedGenerateWithFallback — blocklist consultation (Fix 2 consumer)", () => {
  it("skips a blocked candidate and still tries the next, unblocked one", async () => {
    const scope = "sess-fallback-skip";
    blockModel(scope, "blocked-model", { statusCode: 403, reason: "RegionError" });
    const calls: string[] = [];
    const llm = makeScopedLlm(scope, async (modelId) => {
      calls.push(modelId);
      return "healthy output";
    });

    const { chunks, result } = await drain(
      tracedGenerateWithFallback(llm, {
        phase: "evaluate",
        label: "test",
        system: "sys",
        prompt: "p",
        tickIntervalMs: 0,
        models: ["blocked-model", "healthy-model"],
      }),
    );

    expect(calls).toEqual(["healthy-model"]);
    expect(result).toBe("healthy output");
    const toast = chunks.find((c) => c.type === "toast");
    expect(toast?.content).toContain("blocked-model");
    expect(toast?.content).toContain("403");
  });

  it("returns null without calling generate at all when every candidate is blocked", async () => {
    const scope = "sess-fallback-all-blocked";
    blockModel(scope, "blocked-a", { statusCode: 403, reason: "RegionError" });
    blockModel(scope, "blocked-b", { statusCode: 401, reason: "no entitlement" });
    const calls: string[] = [];
    const llm = makeScopedLlm(scope, async (modelId) => {
      calls.push(modelId);
      return "should never run";
    });

    const { result } = await drain(
      tracedGenerateWithFallback(llm, {
        phase: "evaluate",
        label: "test",
        system: "sys",
        prompt: "p",
        tickIntervalMs: 0,
        models: ["blocked-a", "blocked-b"],
      }),
    );

    expect(calls).toEqual([]);
    expect(result).toBeNull();
  });

  it("surfaces the warning once per model, not once per call", async () => {
    const scope = "sess-fallback-once";
    blockModel(scope, "blocked-model", { statusCode: 403, reason: "RegionError" });
    const llm = makeScopedLlm(scope, async () => "healthy output");

    const args = {
      phase: "evaluate" as const,
      label: "test",
      system: "sys",
      prompt: "p",
      tickIntervalMs: 0,
      models: ["blocked-model", "healthy-model"],
    };

    const first = await drain(tracedGenerateWithFallback(llm, args));
    const second = await drain(tracedGenerateWithFallback(llm, args));

    const firstToasts = first.chunks.filter((c) => c.type === "toast");
    const secondToasts = second.chunks.filter((c) => c.type === "toast");
    expect(firstToasts).toHaveLength(1);
    expect(secondToasts).toHaveLength(0);
    // The model is still skipped on the second call — "not notified again" is
    // NOT the same as "no longer blocked".
    expect(second.result).toBe("healthy output");
  });
});

describe("researchWithFallback / pickDebateFallbackModel — blocklist consultation (Fix 2 consumer)", () => {
  const RESEARCH_FAILED = "## Source Code Findings\n[Research failed: opencode-go overloaded]";
  const RESEARCH_OK = "## Source Code Findings\n- Found the render cascade in app.tsx.";

  it("skips a blocked fallback-pool candidate and recovers via the next different-provider candidate", async () => {
    const scope = "sess-research-fallback";
    // "deepseek-blocked" resolves to the same provider ("deepseek") as
    // "deepseek-good2" via detectProviderForModel's prefix fallback, so
    // WITHOUT the blocklist check it would be picked first (pool order).
    blockModel(scope, "deepseek-blocked", { statusCode: 403, reason: "RegionError" });

    const researchCalls: string[] = [];
    const llm: CouncilLLM = {
      generate: async () => "unused",
      debate: async () => ({ text: "", toolCalls: [] }),
      research: async (modelId: string) => {
        researchCalls.push(modelId);
        if (modelId === "opencode-primary") return RESEARCH_FAILED;
        if (modelId === "deepseek-blocked") return "SHOULD NEVER BE CALLED — model is blocked";
        return RESEARCH_OK;
      },
      isModelBlocked: (modelId: string) => isModelBlocked(scope, modelId),
      takeModelBlockWarning: () => undefined,
    };

    const result = await researchWithFallback(llm, "opencode-primary", "topic", "", undefined, () => {}, {}, [
      "deepseek-blocked",
      "deepseek-good2",
    ]);

    expect(researchCalls).toEqual(["opencode-primary", "deepseek-good2"]);
    expect(result).toBe(RESEARCH_OK);
  });
});
