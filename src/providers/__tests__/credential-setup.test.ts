import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setKey: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../keychain.js", () => ({ setKeyForProvider: mocks.setKey }));
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings: mocks.load,
  saveUserSettings: mocks.save,
  getReasoningEffortForModel: () => undefined,
}));
vi.mock("../auth/registry.js", () => ({ getOAuthProviderConfig: async () => undefined }));

import { promptProviderCredentials, saveProviderCredentials } from "../credential-setup.js";
import { __resetProviderFactoryRegistry, createProviderFactory } from "../runtime.js";

const KEY = ["synthetic", "provider", "credential", "fixture"].join("-");
const ID = "wrkspc_setupFixture";
let settings: Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  settings = {
    providers: {
      anthropic: { baseURL: "https://example.test/v1", workspaceId: "wrkspc_old" },
      xai: { baseURL: "https://other.test" },
    },
    defaultProvider: "xai",
  };
  mocks.setKey.mockResolvedValue(true);
  mocks.load.mockImplementation(() => settings);
  mocks.save.mockImplementation((patch) => {
    settings = { ...settings, ...patch };
  });
  __resetProviderFactoryRegistry();
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetProviderFactoryRegistry();
});

function scripted(...answers: string[]) {
  return vi.fn(async (_question: string) => {
    if (!answers.length) throw new Error("Unexpected extra setup prompt");
    return answers.shift()!;
  });
}

describe("complete interactive provider credentials", () => {
  it("asks workspace-aware users for key, explicit scope, and workspace ID", async () => {
    const prompt = scripted(` ${KEY} `, "2", ` ${ID} `);
    expect(await promptProviderCredentials("anthropic", prompt)).toEqual({ apiKey: KEY, workspaceId: ID });
    expect(prompt.mock.calls.map(([question]) => question).join("\n")).toContain("Settings > Workspaces");
    expect(mocks.setKey).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("requires a workspace for the default / unsure choice and retries invalid input", async () => {
    const prompt = scripted(KEY, "invalid", "", "", "bad", ID);
    expect(await promptProviderCredentials("anthropic", prompt)).toEqual({ apiKey: KEY, workspaceId: ID });
    expect(prompt.mock.calls[2][0]).toContain("Choose 1 or 2");
    expect(prompt.mock.calls[4][0]).toContain("required");
    expect(prompt.mock.calls[5][0]).toContain("wrkspc_");
  });
  it("does not ask for a workspace after explicit scoped-key selection", async () => {
    const prompt = scripted(KEY, "1");
    expect(await promptProviderCredentials("anthropic", prompt)).toEqual({ apiKey: KEY });
    expect(prompt).toHaveBeenCalledTimes(2);
  });
  it("other providers still require only a key", async () => {
    const prompt = scripted(KEY);
    expect(await promptProviderCredentials("deepseek", prompt)).toEqual({ apiKey: KEY });
    expect(prompt).toHaveBeenCalledTimes(1);
  });
  it("empty-key cancellation and interrupted workspace setup write nothing", async () => {
    expect(await promptProviderCredentials("anthropic", scripted(""))).toBeNull();
    await expect(promptProviderCredentials("anthropic", scripted(KEY, "2"))).rejects.toThrow(
      "Unexpected extra setup prompt",
    );
    expect(mocks.setKey).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("validates required workspace before writing credentials", async () => {
    for (const workspaceId of ["", "wrong-id", "wrkspc_", "wrkspc_bad space"]) {
      await expect(saveProviderCredentials("anthropic", { apiKey: KEY, workspaceId })).rejects.toThrow("Workspace ID");
    }
    expect(mocks.setKey).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("preserves provider endpoints and unrelated settings when saving workspace", async () => {
    await saveProviderCredentials("anthropic", { apiKey: KEY, workspaceId: ` ${ID} ` });
    expect(settings.providers.anthropic).toEqual({ baseURL: "https://example.test/v1", workspaceId: ID });
    expect(settings.providers.xai).toEqual({ baseURL: "https://other.test" });
    expect(settings.defaultProvider).toBe("xai");
  });
  it("explicit scoped-key setup clears stale workspace selection", async () => {
    await saveProviderCredentials("anthropic", { apiKey: KEY });
    expect(settings.providers.anthropic.workspaceId).toBeUndefined();
    expect(settings.providers.anthropic.baseURL).toBe("https://example.test/v1");
  });
  it("does not update settings if key storage fails", async () => {
    mocks.setKey.mockResolvedValue(false);
    expect(await saveProviderCredentials("anthropic", { apiKey: KEY, workspaceId: ID })).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("the next actual SDK request uses the saved workspace without a restart", async () => {
    const headers: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        headers.push(new Headers(init.headers));
        return Response.json({
          id: "msg_setup",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );
    await saveProviderCredentials("anthropic", { apiKey: KEY, workspaceId: ID });
    const { factory } = createProviderFactory("anthropic", {
      apiKey: KEY,
      baseURL: settings.providers.anthropic.baseURL,
    });
    await factory("claude-sonnet-4-6").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      maxOutputTokens: 8,
    });
    expect(headers[0].get("anthropic-workspace-id")).toBe(ID);
    await saveProviderCredentials("anthropic", { apiKey: KEY });
    const scoped = createProviderFactory("anthropic", { apiKey: KEY, baseURL: settings.providers.anthropic.baseURL });
    await scoped
      .factory("claude-sonnet-4-6")
      .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }], maxOutputTokens: 8 });
    expect(headers[1].has("anthropic-workspace-id")).toBe(false);
  });
});
