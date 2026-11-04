import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRetryReporter } from "../../utils/visible-retry.js";
import { createSubscriptionFallback, subscriptionFallbackReason } from "../subscription-fallback.js";

vi.mock("../../usage/decision-log.js", () => ({ appendDecisionLog: vi.fn(async () => {}) }));
const params = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "ping" }] }],
  maxOutputTokens: 321,
};
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const generated = {
  content: [{ type: "text" as const, text: "ok" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage,
  warnings: [],
};
const failure = (code: string, statusCode = 403) =>
  Object.assign(new Error("fixture failure"), { statusCode, responseBody: JSON.stringify({ error: { code } }) });
const stream = (parts: LanguageModelV3StreamPart[]) =>
  new ReadableStream<LanguageModelV3StreamPart>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
const collect = async (s: ReadableStream<LanguageModelV3StreamPart>) => {
  const parts = [];
  for await (const p of s as any) parts.push(p);
  return parts;
};
beforeEach(() => setRetryReporter(() => {}));
afterEach(() => {
  setRetryReporter(null);
  vi.restoreAllMocks();
});

describe("subscription fallback authority", () => {
  it.each([
    ["subscription_expired", 403, "entitlement"],
    ["model_not_supported", 400, "model-support"],
    ["usage_limit_reached", 429, "quota"],
    ["insufficient_quota", 429, "quota"],
    ["invalid_token", 401, "authentication"],
  ])("recognizes explicit %s (%i)", (code, status, reason) =>
    expect(subscriptionFallbackReason(failure(code, status))).toBe(reason));
  it.each([
    ["rate_limit_exceeded", 429],
    ["slow_down", 429],
    ["content_policy_violation", 403],
    ["", 429],
    ["", 403],
    ["model_not_found", 404],
  ])("does not change billing for %s (%i)", (code, status) =>
    expect(subscriptionFallbackReason(failure(code, status))).toBeUndefined());
  it("does not infer a quota from an error message or network failure", () => {
    expect(subscriptionFallbackReason(new Error("subscription quota network timeout"))).toBeUndefined();
    expect(
      subscriptionFallbackReason(Object.assign(new Error("cancel"), { name: "AbortError", statusCode: 401 })),
    ).toBeUndefined();
  });
});

describe("bounded model execution", () => {
  it("tries subscription first, strips only its unsupported budget and retains the original API budget", async () => {
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        throw failure("invalid_token", 401);
      },
    });
    const api = new MockLanguageModelV3({ doGenerate: generated });
    const f = createSubscriptionFallback("openai");
    const m = f.wrap(primary, () => api, ["maxOutputTokens"]);
    expect(f.authModeForModel(primary.modelId)).toBe("subscription");
    await m.doGenerate(params);
    expect(primary.doGenerateCalls[0].maxOutputTokens).toBeUndefined();
    expect(api.doGenerateCalls[0].maxOutputTokens).toBe(321);
    await m.doGenerate(params);
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(api.doGenerateCalls).toHaveLength(2);
    expect(f.authModeForModel(primary.modelId)).toBe("api-key");
  });
  it("keeps a model entitlement fallback scoped to that model", async () => {
    const primary = new MockLanguageModelV3({
      modelId: "unsupported-fixture",
      doGenerate: async () => {
        throw failure("model_not_supported");
      },
    });
    const f = createSubscriptionFallback("openai");
    await f.wrap(primary, () => new MockLanguageModelV3({ doGenerate: generated })).doGenerate(params);
    expect(f.authModeForModel(primary.modelId)).toBe("api-key");
    expect(f.authModeForModel("another-fixture")).toBe("subscription");
  });
  it("does not replay when API itself fails", async () => {
    const error = failure("invalid_token", 401);
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        throw error;
      },
    });
    const api = new MockLanguageModelV3({
      doGenerate: async () => {
        throw error;
      },
    });
    await expect(
      createSubscriptionFallback("openai")
        .wrap(primary, () => api)
        .doGenerate(params),
    ).rejects.toBe(error);
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(api.doGenerateCalls).toHaveLength(1);
  });
  it("does not fall back on RPM/TPM throttling, cancellation, or network failure", async () => {
    for (const error of [failure("rate_limit_exceeded", 429), new Error("ECONNRESET")]) {
      const primary = new MockLanguageModelV3({
        doGenerate: async () => {
          throw error;
        },
      });
      const api = new MockLanguageModelV3({ doGenerate: generated });
      await expect(
        createSubscriptionFallback("openai")
          .wrap(primary, () => api)
          .doGenerate(params),
      ).rejects.toBe(error);
      expect(api.doGenerateCalls).toHaveLength(0);
    }
    const controller = new AbortController();
    controller.abort();
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        throw failure("invalid_token", 401);
      },
    });
    const api = new MockLanguageModelV3({ doGenerate: generated });
    await expect(
      createSubscriptionFallback("openai")
        .wrap(primary, () => api)
        .doGenerate({ ...params, abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(api.doGenerateCalls).toHaveLength(0);
  });
  it("handles a pre-output SSE quota error exactly once", async () => {
    const primary = new MockLanguageModelV3({
      doStream: async () => ({
        stream: stream([
          { type: "stream-start", warnings: [] },
          { type: "error", error: failure("usage_limit_reached", 429) },
        ]),
      }),
    });
    const api = new MockLanguageModelV3({
      doStream: async () => ({
        stream: stream([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "API" },
        ]),
      }),
    });
    const output = await createSubscriptionFallback("openai")
      .wrap(primary, () => api)
      .doStream(params);
    expect((await collect(output.stream)).map((p) => p.type)).toEqual(["text-start", "text-delta"]);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(api.doStreamCalls).toHaveLength(1);
  });
  it.each([
    { type: "text-start", id: "1" },
    { type: "reasoning-start", id: "1" },
    { type: "tool-input-start", id: "1", toolName: "fixture" },
  ] as LanguageModelV3StreamPart[])("does not replay after meaningful %j output", async (part) => {
    const primary = new MockLanguageModelV3({
      doStream: async () => ({ stream: stream([part, { type: "error", error: failure("usage_limit_reached", 429) }]) }),
    });
    const backup = vi.fn(() => new MockLanguageModelV3());
    const output = await createSubscriptionFallback("openai").wrap(primary, backup).doStream(params);
    expect((await collect(output.stream)).map((p) => p.type)).toEqual([part.type, "error"]);
    expect(backup).not.toHaveBeenCalled();
  });
});
