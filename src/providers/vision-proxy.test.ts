import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { needsVisionProxy, proxyVision } from "./vision-proxy.js";

vi.mock("../models/registry.js", () => ({
  getModelInfo: (id: string) => {
    if (id === "deepseek-v4-flash") return { id, supportsVision: false };
    if (id === "deepseek-v4-pro") return { id, supportsVision: false };
    if (id === "claude-sonnet-4-6") return { id, supportsVision: true };
    if (id === "gpt-4o") return { id }; // undefined = defaults to true
    return null;
  },
}));

vi.mock("./keychain.js", () => ({
  loadKeyForProvider: vi.fn().mockResolvedValue("sk-test-key-12345678901234567890"),
}));

// Bun's test runner doesn't ship vi.stubGlobal — swap globalThis.fetch manually.
const realFetch = globalThis.fetch;
function setFetch(impl: typeof globalThis.fetch): void {
  globalThis.fetch = impl;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

describe("needsVisionProxy", () => {
  it("returns true for deepseek models", () => {
    expect(needsVisionProxy("deepseek-v4-flash")).toBe(true);
    expect(needsVisionProxy("deepseek-v4-pro")).toBe(true);
  });

  it("returns false for models with vision support", () => {
    expect(needsVisionProxy("claude-sonnet-4-6")).toBe(false);
  });

  it("returns false when supportsVision is undefined (default)", () => {
    expect(needsVisionProxy("gpt-4o")).toBe(false);
  });

  it("returns false for unknown models", () => {
    expect(needsVisionProxy("unknown-model")).toBe(false);
  });
});

describe("proxyVision", () => {
  const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

  beforeEach(() => {
    setFetch(vi.fn() as unknown as typeof globalThis.fetch);
  });

  afterEach(() => {
    restoreFetch();
  });

  it("passes through when model supports vision", async () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    const result = await proxyVision(messages, "claude-sonnet-4-6");
    expect(result.proxied).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("passes through text-only messages for text-only model", async () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    const result = await proxyVision(messages, "deepseek-v4-flash");
    expect(result.proxied).toBe(false);
    expect(result.imageCount).toBe(0);
  });

  it("proxies images through SiliconFlow for text-only model", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "A screenshot showing a login form with email and password fields." } }],
        }),
    });
    setFetch(mockFetch as unknown as typeof globalThis.fetch);

    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "describe this screenshot" },
          { type: "image" as const, image: fakeBase64, mediaType: "image/png" },
        ],
      },
    ];

    const result = await proxyVision(messages, "deepseek-v4-flash");
    expect(result.proxied).toBe(true);
    expect(result.imageCount).toBe(1);

    const processed = result.messages[0];
    expect(processed.role).toBe("user");
    const content = processed.content as Array<{ type: string; text: string }>;
    expect(content.every((p) => p.type === "text")).toBe(true);
    expect(content.some((p) => p.text.includes("Vision Proxy"))).toBe(true);
    expect(content.some((p) => p.text.includes("login form"))).toBe(true);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.siliconflow.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test-key-12345678901234567890" }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Primary model: lightest first so the fast-path returns quickly when the
    // 8B endpoint is healthy. Fallback chain handles the heavier variants.
    expect(body.model).toBe("Qwen/Qwen3-VL-8B-Instruct");
  });

  it("returns fallback description on API error", async () => {
    setFetch(
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("server error") }) as unknown as typeof globalThis.fetch,
    );

    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "analyze" },
          { type: "image" as const, image: fakeBase64, mediaType: "image/png" },
        ],
      },
    ];

    const result = await proxyVision(messages, "deepseek-v4-flash");
    expect(result.proxied).toBe(true);
    const content = result.messages[0].content as Array<{ type: string; text: string }>;
    expect(content.some((p) => p.text.includes("unavailable"))).toBe(true);
    // New behaviour: fallback message surfaces the underlying HTTP error so
    // callers can distinguish "missing key" from "API down".
    expect(content.some((p) => p.text.includes("HTTP 500"))).toBe(true);
  });

  it("handles multiple images in one message", async () => {
    setFetch(
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Image 1: header. Image 2: footer." } }],
          }),
      }) as unknown as typeof globalThis.fetch,
    );

    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "compare these" },
          { type: "image" as const, image: fakeBase64, mediaType: "image/png" },
          { type: "image" as const, image: fakeBase64, mediaType: "image/jpeg" },
        ],
      },
    ];

    const result = await proxyVision(messages, "deepseek-v4-flash");
    expect(result.imageCount).toBe(2);
    const content = result.messages[0].content as Array<{ type: string; text: string }>;
    expect(content.some((p) => p.text.includes("2 images analyzed"))).toBe(true);
  });

  it("preserves non-user messages unchanged", async () => {
    const messages = [
      { role: "system" as const, content: "You are helpful." },
      { role: "assistant" as const, content: "Sure, I can help." },
      { role: "user" as const, content: "no images here" },
    ];

    const result = await proxyVision(messages, "deepseek-v4-flash");
    expect(result.proxied).toBe(false);
    expect(result.messages).toEqual(messages);
  });
});
