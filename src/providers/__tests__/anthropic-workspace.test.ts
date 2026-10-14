import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadUserSettings = vi.hoisted(() => vi.fn());
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings,
  getReasoningEffortForModel: () => undefined,
}));
vi.mock("../auth/registry.js", () => ({ getOAuthProviderConfig: async () => undefined }));

import { getProviderCapabilities } from "../capabilities.js";
import { __resetProviderFactoryRegistry, createProviderFactory, createProviderFactoryAsync } from "../runtime.js";

const MOCK_KEY = "x".repeat(32);
const WORKSPACE = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";
const MODEL = "claude-sonnet-4-6";
const ENDPOINT = "https://anthropic-workspace.example.test/v1";
let requests: Headers[];
let requireWorkspace: boolean;
let bodies: Record<string, any>[];

beforeEach(() => {
  requests = [];
  bodies = [];
  requireWorkspace = true;
  loadUserSettings.mockReset().mockReturnValue({ providers: { anthropic: { workspaceId: WORKSPACE } } });
  __resetProviderFactoryRegistry();
  // Keep the actual SDK serialization and HTTP error parsing. Only the transport
  // is replaced; no user API key or real provider endpoint is accessed.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = new Headers(init.headers);
      requests.push(headers);
      bodies.push(JSON.parse(init.body as string));
      if (requireWorkspace && !headers.get("anthropic-workspace-id")) {
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.",
            },
          },
          { status: 400 },
        );
      }
      if (JSON.parse(init.body as string).stream) {
        const events = [
          {
            type: "message_start",
            message: {
              id: "msg_workspace_test",
              type: "message",
              role: "assistant",
              model: MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      return Response.json({
        id: "msg_workspace_test",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetProviderFactoryRegistry();
});

async function generate(factory: ReturnType<typeof createProviderFactory>["factory"]) {
  return factory(MODEL).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    maxOutputTokens: 8,
  });
}

describe("Anthropic workspace authentication on the SDK wire", () => {
  it("serializes adaptive thinking and effort without a rejected manual budget", async () => {
    const { factory } = createProviderFactory("anthropic", { apiKey: MOCK_KEY, baseURL: ENDPOINT });
    const providerOptions = getProviderCapabilities("anthropic").buildProviderOptions({
      model: {
        id: "claude-opus-5-5",
        provider: "anthropic",
        name: "Opus",
        contextWindow: 1_000_000,
        inputPrice: 4,
        outputPrice: 20,
        description: "fixture",
        reasoning: true,
        thinkingType: "adaptive",
        supportsReasoningEffort: true,
        defaultReasoningEffort: "medium",
      },
      reasoningEffort: "low",
    });
    await factory("claude-opus-5-5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      maxOutputTokens: 128_000,
      providerOptions: providerOptions as any,
    });
    expect(bodies[0].thinking).toEqual({ type: "adaptive" });
    expect(bodies[0].output_config).toMatchObject({ effort: "low" });
    expect(bodies[0].temperature).toBeUndefined();
  });

  it("sends the configured workspace for factories used by main and council", async () => {
    const { factory } = createProviderFactory("anthropic", { apiKey: MOCK_KEY, baseURL: ENDPOINT });
    await expect(generate(factory)).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    expect(requests[0].get("anthropic-workspace-id")).toBe(WORKSPACE);
    expect(requests[0].get("x-api-key")).toBe(MOCK_KEY);
  });

  it("sends the configured workspace through async bootstrap factory creation", async () => {
    const { factory } = await createProviderFactoryAsync("anthropic", { apiKey: MOCK_KEY, baseURL: ENDPOINT });
    await generate(factory);
    expect(requests[0].get("anthropic-workspace-id")).toBe(WORKSPACE);
  });

  it("sends the workspace on streaming main/helper requests", async () => {
    const { factory } = createProviderFactory("anthropic", { apiKey: MOCK_KEY, baseURL: ENDPOINT });
    const result = await factory(MODEL).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      maxOutputTokens: 8,
    });
    const parts = [];
    const reader = result.stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    expect(parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text-delta", delta: "ok" })]));
    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(requests[0].get("anthropic-workspace-id")).toBe(WORKSPACE);
  });

  it("preserves caller headers and an explicit workspace override", async () => {
    const { factory } = createProviderFactory("anthropic", {
      apiKey: MOCK_KEY,
      baseURL: ENDPOINT,
      headers: { "Anthropic-Workspace-Id": "wrkspc_explicit", "x-test-gateway": "present" },
    });
    await generate(factory);
    expect(requests[0].get("anthropic-workspace-id")).toBe("wrkspc_explicit");
    expect(requests[0].get("x-test-gateway")).toBe("present");
  });

  it("trims whitespace around the configured ID", async () => {
    loadUserSettings.mockReturnValue({ providers: { anthropic: { workspaceId: ` ${WORKSPACE} ` } } });
    await generate(createProviderFactory("anthropic", { apiKey: MOCK_KEY, baseURL: ENDPOINT }).factory);
    expect(requests[0].get("anthropic-workspace-id")).toBe(WORKSPACE);
  });

  it.each([undefined, "", "   "])("does not invent a workspace for scoped keys (%s)", async (workspaceId) => {
    requireWorkspace = false;
    loadUserSettings.mockReturnValue({ providers: { anthropic: { workspaceId } } });
    await generate(createProviderFactory("anthropic", { apiKey: MOCK_KEY, baseURL: ENDPOINT }).factory);
    expect(requests[0].has("anthropic-workspace-id")).toBe(false);
  });

  it("surfaces the provider rejection when an unscoped key has no workspace configured", async () => {
    loadUserSettings.mockReturnValue({});
    const { factory } = createProviderFactory("anthropic", { apiKey: MOCK_KEY, baseURL: ENDPOINT });
    await expect(generate(factory)).rejects.toThrow("This API key is not scoped to a workspace");
    expect(requests[0].has("anthropic-workspace-id")).toBe(false);
  });
});
