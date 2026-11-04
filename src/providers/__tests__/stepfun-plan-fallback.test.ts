import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModelForProvider } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { setRetryReporter } from "../../utils/visible-retry.js";
import { apiBaseFor } from "../endpoints.js";
import { __resetProviderFactoryRegistry, createProviderFactory, createProviderFactoryAsync } from "../runtime.js";

const state = vi.hoisted(() => ({ baseURL: "https://api.stepfun.ai/step_plan/v1" }));
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings: () => ({ providers: { stepfun: { baseURL: state.baseURL } } }),
  getReasoningEffortForModel: () => undefined,
}));
vi.mock("../auth/registry.js", () => ({ getOAuthProviderConfig: async () => undefined }));
vi.mock("../../usage/decision-log.js", () => ({ appendDecisionLog: vi.fn(async () => {}) }));

const PLAN = "https://api.stepfun.ai/step_plan/v1";
const KEY = "fixture-stepfun-api-key-not-a-real-key";
const measuredError = {
  error: { message: "you have no active step plan subscription", type: "request_params_invalid" },
};
const calls: Array<{ url: string; auth: string | null; body: Record<string, any> }> = [];
let modelId: string;
const params = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "ping" }] }],
  maxOutputTokens: 777,
};
function transport(planBody = measuredError, planStatus = 400, apiStatus = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = {
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    if (call.url.includes("/step_plan/") && planStatus !== 200) return Response.json(planBody, { status: planStatus });
    if (apiStatus !== 200)
      return Response.json(
        { error: { message: "API fixture rejected", code: "invalid_token" } },
        { status: apiStatus },
      );
    if (call.body.stream)
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", created: 1, model: modelId, choices: [{ index: 0, delta: { content: "API OK" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    return Response.json({
      id: "fixture",
      created: 1,
      model: modelId,
      choices: [{ index: 0, message: { role: "assistant", content: "API OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
}
beforeAll(async () => {
  await loadCatalog();
  modelId = getTestModelForProvider("stepfun", "premium");
});
beforeEach(() => {
  state.baseURL = PLAN;
  calls.length = 0;
  __resetProviderFactoryRegistry();
  setRetryReporter(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetProviderFactoryRegistry();
  setRetryReporter(null);
});

describe("StepFun plan/API billing route through the actual SDK adapter", () => {
  it.each([
    "sync",
    "async",
  ])("%s factory falls back once on the measured entitlement error and retains key/model/budget", async (kind) => {
    transport();
    const { factory } =
      kind === "sync"
        ? createProviderFactory("stepfun", { apiKey: KEY })
        : await createProviderFactoryAsync("stepfun", { apiKey: KEY });
    const result = await factory(modelId).doGenerate(params);
    expect(result.content[0].text).toBe("API OK");
    expect(calls.map((c) => c.url)).toEqual([`${PLAN}/chat/completions`, `${apiBaseFor("stepfun")}/chat/completions`]);
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
    expect(calls.map((c) => c.body.model)).toEqual([modelId, modelId]);
    expect(calls.map((c) => c.body.max_tokens)).toEqual([777, 777]);
    expect(factory.authModeForModel?.(modelId)).toBe("api-key");
    await factory(modelId).doGenerate(params);
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toBe(`${apiBaseFor("stepfun")}/chat/completions`);
    expect(state.baseURL).toBe(PLAN);
  });
  it("uses the same bounded fallback for streaming", async () => {
    transport();
    const { factory } = createProviderFactory("stepfun", { apiKey: KEY });
    const result = await factory(modelId).doStream(params);
    const parts: any[] = [];
    for await (const part of result.stream) parts.push(part);
    expect(parts.some((p) => p.type === "text-delta" && p.delta === "API OK")).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it("a host-selected API worker must not reselect the saved plan endpoint", async () => {
    transport();
    const { factory } = await createProviderFactoryAsync("stepfun", { apiKey: KEY, authMode: "api-key" });
    await factory(modelId).doGenerate(params);
    expect(calls.map((c) => c.url)).toEqual([`${apiBaseFor("stepfun")}/chat/completions`]);
  });
  it.each([
    [{ error: { message: "Rate limit reached", type: "rate_limit_exceeded" } }, 429],
    [{ error: { message: "unknown parameter", type: "request_params_invalid" } }, 400],
    [{ error: { message: measuredError.error.message, type: "other_error" } }, 400],
  ])("does not change billing for a different error contract", async (body, status) => {
    transport(body, status);
    const { factory } = createProviderFactory("stepfun", { apiKey: KEY });
    await expect(factory(modelId).doGenerate(params)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("does not replay an API rejection after the single fallback", async () => {
    transport(measuredError, 400, 401);
    const { factory } = createProviderFactory("stepfun", { apiKey: KEY });
    await expect(factory(modelId).doGenerate(params)).rejects.toThrow("API fixture rejected");
    expect(calls).toHaveLength(2);
  });
  it("preserves a custom gateway even when it returns the same message", async () => {
    state.baseURL = "https://proxy.example.invalid/step_plan/v1";
    transport();
    const { factory } = createProviderFactory("stepfun", { apiKey: KEY });
    await expect(factory(modelId).doGenerate(params)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith(state.baseURL)).toBe(true);
  });
  it("does not choose an API endpoint without an actual configured key", async () => {
    transport();
    const { factory } = createProviderFactory("stepfun", {});
    await expect(factory(modelId).doGenerate(params)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("a working plan stays primary and a new factory resets the fallback latch", async () => {
    const fetch = transport();
    const first = createProviderFactory("stepfun", { apiKey: KEY }).factory;
    await first(modelId).doGenerate(params);
    expect(first.authModeForModel?.(modelId)).toBe("api-key");
    fetch.mockRestore();
    transport(measuredError, 200);
    const refreshed = createProviderFactory("stepfun", { apiKey: KEY }).factory;
    await refreshed(modelId).doGenerate(params);
    expect(refreshed.authModeForModel?.(modelId)).toBe("subscription");
    expect(calls.at(-1)?.url).toBe(`${PLAN}/chat/completions`);
  });
  it("normalizes a trailing slash on the recognized plan route", async () => {
    state.baseURL = `${PLAN}/`;
    transport();
    await createProviderFactory("stepfun", { apiKey: KEY }).factory(modelId).doGenerate(params);
    expect(calls).toHaveLength(2);
  });
  it("cancellation does not authorize a billing switch", async () => {
    transport();
    const { factory } = createProviderFactory("stepfun", { apiKey: KEY });
    await expect(factory(modelId).doGenerate({ ...params, abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(factory.authModeForModel?.(modelId)).toBe("subscription");
  });
  it("the standard API endpoint never enters subscription mode", async () => {
    state.baseURL = apiBaseFor("stepfun");
    transport();
    const { factory } = createProviderFactory("stepfun", { apiKey: KEY });
    await factory(modelId).doGenerate(params);
    expect(calls).toHaveLength(1);
    expect(factory.authModeForModel?.(modelId)).toBe("api-key");
  });
});
