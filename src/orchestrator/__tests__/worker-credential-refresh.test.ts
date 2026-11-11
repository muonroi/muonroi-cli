import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModelForProvider } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { saveProviderCredentials } from "../../providers/credential-setup.js";
import { __resetProviderFactoryRegistry, resolveModelRuntime } from "../../providers/runtime.js";
import { rewarmProviderFactory } from "../../providers/warm.js";
import { saveUserSettings } from "../../utils/settings.js";
import { DelegationManager } from "../delegations.js";
import { Agent } from "../orchestrator.js";

const OLD = "old-fixture-" + "x".repeat(24),
  FRESH = "new-fixture-" + "y".repeat(24);
let home: string, agent: Agent | undefined;
beforeAll(async () => {
  await loadCatalog();
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-worker-auth-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("MUONROI_CLI_HOME", home);
  vi.stubEnv("MUONROI_ENV_FILE", path.join(home, ".env"));
  vi.stubEnv("DEEPSEEK_API_KEY", OLD);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("MUONROI_BACKGROUND_CHILD", "0");
  __resetProviderFactoryRegistry();
});
afterEach(async () => {
  await agent?.cleanup();
  agent = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetProviderFactoryRegistry();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("worker auth after provider credentials change", () => {
  it("a StepFun API-mode worker bypasses the saved plan route at Agent construction", async () => {
    saveUserSettings({ providers: { stepfun: { baseURL: "https://api.stepfun.ai/step_plan/v1" } } });
    const modelId = getTestModelForProvider("stepfun");
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return Response.json({ error: { message: "fixture transport reached" } }, { status: 400 });
    });
    agent = new Agent(FRESH, undefined, modelId, 1, {
      executionRole: "worker",
      persistSession: false,
      authMode: "api-key",
      permissionMode: "yolo",
    });
    await (agent as any)._initOAuthProvider();
    await expect(agent.getProvider()(modelId).doGenerate({ prompt: [] })).rejects.toThrow("fixture transport reached");
    expect(calls).toEqual(["https://api.stepfun.ai/v1/chat/completions"]);
  });

  it("uses the newly saved credential for both main transport and detached worker handoff", async () => {
    const modelId = getTestModelForProvider("deepseek", "fast");
    agent = new Agent(OLD, undefined, modelId, 1, { persistSession: false, permissionMode: "yolo" });
    expect(await saveProviderCredentials("deepseek", { apiKey: FRESH }, agent)).toBe(true);
    expect(await rewarmProviderFactory("deepseek")).toBe(true);
    let mainUsesFresh = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      mainUsesFresh = new Headers(init?.headers).get("authorization") === `Bearer ${FRESH}`;
      return new Response(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: modelId,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await resolveModelRuntime(modelId).model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });
    expect(mainUsesFresh).toBe(true);
    let handoff: Parameters<DelegationManager["startTask"]>[1] | undefined;
    vi.spyOn(DelegationManager.prototype, "startTask").mockImplementation(async (_request, options) => {
      handoff = options;
      return { success: true, output: "captured" };
    });
    const result = await (agent as any).runDelegation(
      {
        agent: "general",
        modelId,
        description: "Credential probe",
        prompt: "No tools",
        background: true,
        writeScope: [],
      },
      undefined,
      true,
    );
    expect(result.success).toBe(true);
    expect(handoff?.workerApiKey).toBe(FRESH);
  });
  it("does not replace an explicit session key with another stored key", async () => {
    const modelId = getTestModelForProvider("deepseek", "fast");
    agent = new Agent(OLD, undefined, modelId, 1, { persistSession: false, permissionMode: "yolo" });
    await saveProviderCredentials("deepseek", { apiKey: FRESH });
    let handoff: Parameters<DelegationManager["startTask"]>[1] | undefined;
    vi.spyOn(DelegationManager.prototype, "startTask").mockImplementation(async (_request, opts) => {
      handoff = opts;
      return { success: true, output: "captured" };
    });
    await (agent as any).runDelegation(
      {
        agent: "general",
        modelId,
        description: "Explicit credential",
        prompt: "No tools",
        background: true,
        writeScope: [],
      },
      undefined,
      true,
    );
    expect(handoff?.workerApiKey).toBe(OLD);
  });
  it("saving another provider does not change the active provider's handoff", async () => {
    const modelId = getTestModelForProvider("deepseek", "fast");
    agent = new Agent(OLD, undefined, modelId, 1, { persistSession: false, permissionMode: "yolo" });
    await saveProviderCredentials("openai", { apiKey: FRESH }, agent);
    let handoff: Parameters<DelegationManager["startTask"]>[1] | undefined;
    vi.spyOn(DelegationManager.prototype, "startTask").mockImplementation(async (_request, opts) => {
      handoff = opts;
      return { success: true, output: "captured" };
    });
    await (agent as any).runDelegation(
      {
        agent: "general",
        modelId,
        description: "Other provider",
        prompt: "No tools",
        background: true,
        writeScope: [],
      },
      undefined,
      true,
    );
    expect(agent.getProviderId()).toBe("deepseek");
    expect(handoff?.workerApiKey).toBe(OLD);
  });
  it("retains the configured custom endpoint after refreshing the held credential", async () => {
    const modelId = getTestModelForProvider("deepseek", "fast");
    const endpoint = "https://custom.example.invalid/v1";
    saveUserSettings({ providers: { deepseek: { baseURL: endpoint } } });
    agent = new Agent(OLD, endpoint, modelId, 1, { persistSession: false, permissionMode: "yolo" });
    await saveProviderCredentials("deepseek", { apiKey: FRESH }, agent);
    let url = "",
      auth: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get("authorization");
      return Response.json({ error: { message: "fixture HTTP reached" } }, { status: 400 });
    });
    await expect(resolveModelRuntime(modelId).model.doGenerate({ prompt: [] })).rejects.toThrow("fixture HTTP reached");
    expect(url).toBe(`${endpoint}/chat/completions`);
    expect(auth).toBe(`Bearer ${FRESH}`);
  });
});
