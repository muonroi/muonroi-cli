import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModelForProvider } from "../../__test-helpers__/catalog-fixtures.js";
import { createCouncilLLM } from "../../council/llm.js";
import { loadCatalog } from "../../models/registry.js";
import { CouncilManager } from "../../orchestrator/council-manager.js";
import { DelegationManager } from "../../orchestrator/delegations.js";
import { Agent } from "../../orchestrator/orchestrator.js";
import { closeDatabase } from "../../storage/db.js";
import type { BashTool } from "../../tools/bash.js";
import { setRetryReporter } from "../../utils/visible-retry.js";
import { saveProviderCredentials } from "../credential-setup.js";
import {
  __resetProviderFactoryRegistry,
  authModeForModel,
  createProviderFactoryAsync,
  factoryForModel,
} from "../runtime.js";

const fixture = vi.hoisted(() => ({ token: ["subscription", "fixture"].join("-"), failLoad: false }));
vi.mock("../auth/registry.js", () => ({
  listOAuthProviderIds: async () => ["openai"],
  getOAuthProviderConfig: async (id: string) =>
    id === "openai"
      ? {
          loadTokensWithRefresh: async () => {
            if (fixture.failLoad) throw new Error("fixture token network failure");
            return { accessToken: fixture.token };
          },
          provider: { authHeaders: () => ({ Authorization: `Bearer ${fixture.token}` }) },
          baseURL: "https://subscription.example.invalid/backend",
          defaultProviderOptions: { store: false, instructions: "fixture" },
          unsupportedParams: ["maxOutputTokens"],
        }
      : undefined,
}));
const KEY = ["api", "backup", "fixture", "abcdefghijklmno"].join("-");
const calls: Array<{ url: string; auth: string | null; body: Record<string, any> }> = [];
let home: string, agent: Agent | undefined;
beforeAll(async () => {
  await loadCatalog();
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-subscription-"));
  for (const key of ["HOME", "USERPROFILE", "MUONROI_CLI_HOME"]) vi.stubEnv(key, home);
  vi.stubEnv("MUONROI_ENV_FILE", path.join(home, ".env"));
  vi.stubEnv("OPENAI_API_KEY", KEY);
  vi.stubEnv("MUONROI_BACKGROUND_CHILD", "0");
  calls.length = 0;
  fixture.failLoad = false;
  __resetProviderFactoryRegistry();
  setRetryReporter(() => {});
});
afterEach(async () => {
  await agent?.cleanup();
  agent = undefined;
  closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setRetryReporter(null);
  __resetProviderFactoryRegistry();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function transport(failureCode = "subscription_expired", status = 403) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = {
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    if (call.auth === `Bearer ${fixture.token}`)
      return Response.json({ error: { message: "fixture subscription unavailable", code: failureCode } }, { status });
    return Response.json({
      id: "resp_fixture",
      object: "response",
      created_at: 1,
      status: "completed",
      model: call.body.model,
      output: [
        {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "API OK", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  });
}
describe("subscription/API HTTP adapter and host handoff", () => {
  it("without an API key, preserves OAuth failure and its unsupported-parameter contract", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    transport("invalid_token", 401);
    const modelId = getTestModelForProvider("openai");
    const { factory } = await createProviderFactoryAsync("openai", {});
    expect(factory.unsupportedParams).toContain("maxOutputTokens");
    await expect(factory.responses!(modelId).doGenerate({ prompt: [] })).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(authModeForModel(modelId)).toBe("subscription");
  });
  it("legacy council generation preserves the subscription factory and its bearer", async () => {
    const modelId = getTestModelForProvider("openai");
    const original = await createProviderFactoryAsync("openai", { apiKey: KEY });
    let authorization: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ error: { message: "fixture transport reached" } }, { status: 400 });
    });
    const manager = new CouncilManager({} as any);
    await expect(manager.generate(modelId, "fixture", "fixture", 10)).rejects.toThrow("fixture transport reached");
    expect(authorization).toBe(`Bearer ${fixture.token}`);
    expect(factoryForModel(modelId)).toBe(original.factory);
  });
  it("council preserves the host-selected API factory instead of reselecting OAuth", async () => {
    transport();
    const modelId = getTestModelForProvider("openai");
    const original = await createProviderFactoryAsync("openai", { apiKey: KEY, authMode: "api-key" });
    const llm = createCouncilLLM({} as BashTool, "agent", "auth-fixture", {
      calls: 0,
      startMs: Date.now(),
      phases: [],
    });
    await llm.generate(modelId, "fixture", "fixture", 10, undefined, AbortSignal.abort());
    expect(calls).toHaveLength(0);
    expect(factoryForModel(modelId)).toBe(original.factory);
  });
  it.each([
    ["subscription_expired", 403],
    ["usage_limit_reached", 429],
    ["invalid_token", 401],
    ["model_not_supported", 400],
  ])("switches exactly once for explicit %s with original model/output cap", async (code, status) => {
    transport(code, status);
    const modelId = getTestModelForProvider("openai");
    const { factory } = await createProviderFactoryAsync("openai", { apiKey: KEY });
    expect(authModeForModel(modelId)).toBe("subscription");
    const result = await factory.responses!(modelId).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      maxOutputTokens: 777,
      providerOptions: { openai: factory.defaultProviderOptions },
    });
    expect(result.content[0].text).toBe("API OK");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://subscription.example.invalid/backend/responses");
    expect(calls[1].url).toContain("api.openai.com/v1/responses");
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${fixture.token}`, `Bearer ${KEY}`]);
    expect(calls[0].body.max_output_tokens).toBeUndefined();
    expect(calls[1].body.max_output_tokens).toBe(777);
    expect(calls[1].body.model).toBe(calls[0].body.model);
    expect(calls[1].body.store).toBe(false);
    expect(authModeForModel(modelId)).toBe("api-key");
  });
  it("does not change billing on ordinary 429", async () => {
    transport("rate_limit_exceeded", 429);
    const { factory } = await createProviderFactoryAsync("openai", { apiKey: KEY });
    await expect(factory.responses!(getTestModelForProvider("openai")).doGenerate({ prompt: [] })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("does not use API billing for a token-loader outage", async () => {
    fixture.failLoad = true;
    transport();
    await expect(createProviderFactoryAsync("openai", { apiKey: KEY })).rejects.toThrow("token network failure");
    expect(calls).toHaveLength(0);
  });
  it("saving a backup preserves subscription primary and hands the current key/mode to worker and council", async () => {
    const modelId = getTestModelForProvider("openai");
    agent = new Agent("oauth", undefined, modelId, 1, { persistSession: false, permissionMode: "yolo" });
    await saveProviderCredentials("openai", { apiKey: KEY }, agent);
    expect(authModeForModel(modelId)).toBe("subscription");
    transport();
    await agent.getProvider().responses!(modelId).doGenerate({ prompt: [] });
    let handoff: Parameters<DelegationManager["startTask"]>[1] | undefined;
    vi.spyOn(DelegationManager.prototype, "startTask").mockImplementation(async (_request, opts) => {
      handoff = opts;
      return { success: true, output: "captured" };
    });
    await (agent as any).runDelegation(
      { agent: "general", modelId, description: "fixture", prompt: "No tools", background: true, writeScope: [] },
      undefined,
      true,
    );
    expect(handoff?.workerApiKey).toBe(KEY);
    expect(handoff?.workerAuthMode).toBe("api-key");
    vi.spyOn(DelegationManager.prototype, "startCouncil").mockImplementation(async (_request, opts) => {
      handoff = opts;
      return { success: true, output: "captured" };
    });
    await (agent as any).startCouncil({ topic: "fixture", reason: "fixture", context: "fixture", modelIds: [modelId] });
    expect(handoff?.workerApiKey).toBe(KEY);
    expect(handoff?.workerAuthMode).toBe("api-key");
  });
  it("a host-selected API child does not reselect the unavailable subscription", async () => {
    transport();
    const modelId = getTestModelForProvider("openai");
    agent = new Agent(KEY, undefined, modelId, 1, {
      executionRole: "worker",
      persistSession: false,
      authMode: "api-key",
      permissionMode: "yolo",
    });
    await (agent as any)._initOAuthProvider();
    await agent.getProvider().responses!(modelId).doGenerate({ prompt: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
  });
});
