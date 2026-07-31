import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "../models/registry.js";
import * as usage from "../storage/usage.js";
import * as settings from "../utils/settings.js";
import * as keychain from "./keychain.js";
import {
  __resetVisionSlotBreaker,
  callVisionBackend,
  findNativeVisionFallback,
  formatNativeVisionObservation,
  formatNativeVisionUnavailable,
  isVisionBackendAvailable,
  looksLikeOcrIntent,
  resolveAvailableVisionChain,
  resolveVisionChain,
} from "./vision-backend.js";

beforeEach(() => {
  vi.spyOn(keychain, "loadKeyForProvider").mockResolvedValue("sk-test");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callVisionBackend usage recording (H2)", () => {
  const chain = [{ provider: "zai" as const, model_id: "glm-4.6v-flash" }];
  const content = [{ type: "text", text: "describe" }];

  function stubFetchWithUsage(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "I see a form." } }],
          usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
        }),
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records the provider usage under the `vision` source when a sessionId is given", async () => {
    stubFetchWithUsage();
    const rec = vi.spyOn(usage, "recordUsageEvent").mockImplementation(() => {});
    const res = await callVisionBackend(chain, content, undefined, undefined, { sessionId: "sess-1" });
    expect(res.ok).toBe(true);
    expect(rec).toHaveBeenCalledTimes(1);
    const [sessionId, source, model, tokenUsage] = rec.mock.calls[0];
    expect(sessionId).toBe("sess-1");
    expect(source).toBe("vision");
    expect(model).toBe("glm-4.6v-flash");
    expect(tokenUsage).toMatchObject({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500 });
  });

  it("does NOT record usage when no sessionId is threaded", async () => {
    stubFetchWithUsage();
    const rec = vi.spyOn(usage, "recordUsageEvent").mockImplementation(() => {});
    const res = await callVisionBackend(chain, content);
    expect(res.ok).toBe(true);
    expect(rec).not.toHaveBeenCalled();
  });
});

describe("looksLikeOcrIntent", () => {
  it("detects OCR-style prompts", () => {
    expect(looksLikeOcrIntent("transcribe all text in the image")).toBe(true);
    expect(looksLikeOcrIntent("describe the layout")).toBe(false);
  });
});

describe("resolveVisionChain", () => {
  it("uses catalog routing when available", () => {
    vi.spyOn(registry, "getVisionProxyRouting").mockReturnValue({
      default: { provider: "zai", model_id: "glm-4.6v-flash" },
      ocr: { provider: "zai", model_id: "glm-4.6v-flash" },
      design: { provider: "zai", model_id: "glm-5.2" },
      fallback_chain: [{ provider: "xai", model_id: "grok-4.5" }],
    });

    const chain = resolveVisionChain("design");
    expect(chain[0]).toEqual({ provider: "zai", model_id: "glm-5.2" });
    expect(chain.some((s) => s.model_id === "grok-4.5")).toBe(true);
  });
});

describe("formatNativeVisionObservation", () => {
  it("wraps observation as native sight with follow-up hints", () => {
    const out = formatNativeVisionObservation("I see a login form.", {
      imageCount: 1,
      cachedIds: ["img_1"],
    });
    expect(out).toContain("<vision-observation>");
    expect(out).toContain("direct visual observation");
    expect(out).toContain("ask_vision_proxy");
    expect(out).toContain("img_1");
  });
});

describe("resolveAvailableVisionChain", () => {
  it("returns only slots with configured API keys", async () => {
    vi.spyOn(registry, "getVisionProxyRouting").mockReturnValue({
      default: { provider: "zai", model_id: "glm-4.6v-flash" },
      fallback_chain: [{ provider: "xai", model_id: "grok-4.5" }],
    });
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "xai") return "sk-xai-key-123456789012345678";
      throw new Error("no key");
    });

    const chain = await resolveAvailableVisionChain();
    expect(chain).toEqual([{ provider: "xai", model_id: "grok-4.5" }]);
    expect(await isVisionBackendAvailable()).toBe(true);
  });

  it("returns empty when no vision provider keys exist", async () => {
    vi.spyOn(keychain, "loadKeyForProvider").mockRejectedValue(new Error("no key"));
    expect(await resolveAvailableVisionChain()).toEqual([]);
    expect(await isVisionBackendAvailable()).toBe(false);
  });
});

describe("findNativeVisionFallback", () => {
  beforeEach(async () => {
    await registry.loadCatalog();
  });

  it("picks a vision catalog model when proxy providers lack keys", async () => {
    // Pin provider/model enablement: unmocked, this reads the DEVELOPER'S real
    // user-settings.json, so a machine with `disabledProviders: ["xai"]` failed
    // a test that says nothing about that machine.
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "xai") return "sk-xai-key-123456789012345678";
      throw new Error("no key");
    });
    const hit = await findNativeVisionFallback({ excludeModelId: "deepseek-v4-flash" });
    expect(hit).not.toBeNull();
    expect(hit!.provider).toBe("xai");
    expect(hit!.modelId).toMatch(/grok/);
  });

  it("returns null rather than routing an image to a provider that cannot see it", async () => {
    // opencode-go was the "non-proxy vision provider" this test used to expect.
    // Verified live: the Console Go proxy accepts an image request with HTTP 200
    // and then answers "I cannot see the image" — it silently drops image parts.
    // The catalog now marks it supports_vision:false, so no image is ever routed
    // to a model that would answer blind.
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "opencode-go") return "sk-opencode-key-123456789012345678";
      throw new Error("no key");
    });
    expect(await findNativeVisionFallback({ excludeModelId: "deepseek-v4-flash" })).toBeNull();
  });
});

describe("formatNativeVisionUnavailable", () => {
  it("tells model not to guess and suggests retry paths", () => {
    const out = formatNativeVisionUnavailable(2, ["HTTP 500"], ["img_2"]);
    expect(out).toContain('status="unavailable"');
    expect(out).toContain("Do NOT guess");
    expect(out).toContain("analyze_image");
    expect(out).toContain("img_2");
  });
});

describe("slot transport + circuit breaker", () => {
  beforeEach(() => {
    __resetVisionSlotBreaker();
  });

  afterEach(() => {
    delete process.env.SILICONFLOW_TEST_KEY;
  });

  function stubFetchSequence(responses: Array<{ status: number; body: unknown }>): string[] {
    const urls: string[] = [];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const r = responses[Math.min(i++, responses.length - 1)]!;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: async () => r.body,
          text: async () => JSON.stringify(r.body),
        } as unknown as Response;
      }),
    );
    return urls;
  }

  it("reaches a slot that is not a first-class provider via api_base + api_key_env", async () => {
    process.env.SILICONFLOW_TEST_KEY = "sk-sf";
    const urls = stubFetchSequence([{ status: 200, body: { choices: [{ message: { content: "I see a chart." } }] } }]);

    const result = await callVisionBackend(
      [
        {
          provider: "siliconflow",
          model_id: "Qwen/Qwen2.5-VL-72B-Instruct",
          api_base: "https://api.siliconflow.cn/v1",
          api_key_env: "SILICONFLOW_TEST_KEY",
        },
      ],
      [{ type: "text", text: "describe" }],
    );

    expect(result).toMatchObject({ ok: true, text: "I see a chart." });
    expect(urls[0]).toBe("https://api.siliconflow.cn/v1/chat/completions");
  });

  it("skips a slot whose env key is unset instead of falling back to the keychain", async () => {
    const result = await callVisionBackend(
      [{ provider: "siliconflow", model_id: "vl", api_key_env: "SILICONFLOW_TEST_KEY", api_base: "https://x/v1" }],
      [{ type: "text", text: "describe" }],
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("no API key");
  });

  it("stops re-trying a slot that rejects image content outright", async () => {
    // Z.ai's coding endpoint answers every image request with this — retrying it
    // on each call burned a round-trip per vision request for nothing.
    const shapeReject = {
      status: 400,
      body: { error: { code: "1210", message: "messages.content.type is invalid, allowed values: ['text']" } },
    };
    stubFetchSequence([shapeReject]);
    const chain = [{ provider: "zai" as const, model_id: "glm-5.2" }];

    await callVisionBackend(chain, [{ type: "text", text: "describe" }]);
    // Breaker is now tripped: the slot drops out of the resolved chain...
    const available = await resolveAvailableVisionChain("design");
    expect(available.some((s) => s.model_id === "glm-5.2" && s.provider === "zai")).toBe(false);
  });

  it("keeps a tripped slot when it is the ONLY one left (degraded beats blind)", async () => {
    vi.spyOn(registry, "getVisionProxyRouting").mockReturnValue({
      default: { provider: "zai", model_id: "glm-5.2" },
      fallback_chain: [],
    });
    stubFetchSequence([
      { status: 400, body: { error: { code: "1210", message: "messages.content.type is invalid" } } },
    ]);

    await callVisionBackend([{ provider: "zai", model_id: "glm-5.2" }], [{ type: "text", text: "describe" }]);
    const available = await resolveAvailableVisionChain("default");
    expect(available).toHaveLength(1);
  });
});

describe("blind-backend + wire model id", () => {
  beforeEach(() => {
    __resetVisionSlotBreaker();
  });

  function stub200(text: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        lastBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: text } }] }),
          text: async () => "",
        } as unknown as Response;
      }),
    );
  }
  let lastBody: { model?: string } = {};

  it("strips the opencode/ namespace before it reaches the wire", async () => {
    // The endpoint rejects the namespaced id outright: "Model opencode/glm-5.2
    // is not supported" — the adapter path strips it, this fetch path did not.
    stub200("I see a blue gradient.");
    await callVisionBackend(
      [{ provider: "opencode-go", model_id: "opencode/glm-5.2" }],
      [{ type: "text", text: "describe" }],
    );
    expect(lastBody.model).toBe("glm-5.2");
  });

  it("treats a 200 that says it cannot see the image as a FAILURE", async () => {
    // OpenCode Go answers 200 while silently dropping the image parts. Passed
    // through as an observation, this sentence becomes the primary's own "sight".
    stub200("I cannot see the image to identify the dominant colours.");
    const result = await callVisionBackend(
      [{ provider: "opencode-go", model_id: "opencode/glm-5.2" }],
      [{ type: "text", text: "describe" }],
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("without seeing the image");
  });

  it("does not mistake a real observation about illegible content for blindness", async () => {
    stub200(
      "I see a dashboard with three panels. The caption under the chart is too low-resolution to read, and I cannot see the axis labels clearly, but the layout is a 3-column grid with a dark header bar above it.",
    );
    const result = await callVisionBackend(
      [{ provider: "zai", model_id: "glm-4.6v-flash" }],
      [{ type: "text", text: "describe" }],
    );
    expect(result.ok).toBe(true);
  });
});

// The catalog gained an anthropic vision slot (routing.vision_proxy.fallback_chain
// -> {provider: anthropic, model_id: claude-sonnet-5}), but this module speaks
// ONLY the OpenAI shape: it POSTed `${base}/chat/completions` with
// `Authorization: Bearer` and an `image_url` body. Against Anthropic that is the
// wrong URL, the wrong auth header and the wrong body — the slot could only ever
// 404, so it was dead config. These tests pin the Anthropic Messages translation.
describe("callVisionBackend — anthropic slot speaks the Messages API", () => {
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";
  const content = [
    { type: "text", text: "describe this" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}`, detail: "high" } },
  ];

  function captureAnthropic(responseBody: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => responseBody } as unknown as Response;
      }),
    );
    return { calls };
  }

  it("POSTs /v1/messages with x-api-key + anthropic-version and base64 image blocks", async () => {
    const { calls } = captureAnthropic({
      content: [{ type: "text", text: "I see a login form." }],
      usage: { input_tokens: 1500, output_tokens: 120 },
    });

    const result = await callVisionBackend([{ provider: "anthropic", model_id: "claude-sonnet-5" }], content);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.text).toBe("I see a login form.");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    // apiBaseFor("anthropic") already ends in /v1, so the path must be /v1/messages.
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined(); // Bearer is an OpenAI-ism

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBeGreaterThan(0); // Anthropic REQUIRES max_tokens
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "describe this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
    ]);
    // No OpenAI leftovers.
    expect(JSON.stringify(body)).not.toContain("image_url");
    expect(JSON.stringify(body)).not.toContain("response_format");
  });

  it("joins multiple text blocks and skips non-text blocks in the reply", async () => {
    captureAnthropic({
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "A dark header " },
        { type: "text", text: "above a 3-column grid." },
      ],
    });
    const result = await callVisionBackend([{ provider: "anthropic", model_id: "claude-sonnet-5" }], content);
    expect(result.ok === true && result.text).toBe("A dark header above a 3-column grid.");
  });

  it("fails the slot instead of silently dropping a non-data-URI image", async () => {
    // Anthropic's base64 source needs the bytes; a remote URL cannot be expressed.
    // Dropping it would yield a confident answer about an image nobody looked at.
    captureAnthropic({ content: [{ type: "text", text: "should never be reached" }] });
    const result = await callVisionBackend(
      [{ provider: "anthropic", model_id: "claude-sonnet-5" }],
      [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("Anthropic image blocks");
  });

  it("leaves the OpenAI-shaped backends untouched", async () => {
    const { calls } = captureAnthropic({ choices: [{ message: { content: "I see a chart." } }] });
    const result = await callVisionBackend([{ provider: "zai", model_id: "glm-4.6v-flash" }], content);
    expect(result.ok === true && result.text).toBe("I see a chart.");
    expect(calls[0].url).toContain("/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });
});
