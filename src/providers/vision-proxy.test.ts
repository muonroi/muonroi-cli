import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "../models/registry.js";
import { needsVisionProxy, planImageHandlingForTextOnlyModel, proxyVision } from "./vision-proxy.js";

// Mock will be set up in beforeEach

import * as settings from "../utils/settings.js";
import * as keychain from "./keychain.js";

// Bun's test runner doesn't ship vi.stubGlobal — swap globalThis.fetch manually.
const realFetch = globalThis.fetch;
function setFetch(impl: typeof globalThis.fetch): void {
  globalThis.fetch = impl;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/**
 * Env-var-backed vision slots must be neutralized, or this whole file is
 * environment-dependent.
 *
 * A catalog vision slot may carry `api_key_env` instead of a keychain entry (the
 * SiliconFlow Qwen-VL slot is wired that way), and `resolveSlotTransport` reads
 * `process.env[api_key_env]` DIRECTLY — a path `vi.spyOn(keychain,
 * "loadKeyForProvider")` cannot reach. So on a developer machine that happens to
 * export that variable, the "no vision keys at all" tests are asserting against a
 * premise that is false: the chain really does have a usable slot, the plan is
 * correctly `proxy`, and one test even issued a live fetch. Green in CI, red
 * locally, and the product was never at fault.
 *
 * Names are derived from the loaded routing rather than hardcoded, so a new
 * env-keyed slot in the catalog is covered without touching this file.
 */
const savedSlotEnv = new Map<string, string | undefined>();

async function scrubEnvKeyedVisionSlots(): Promise<void> {
  await registry.loadCatalog();
  const routing = registry.getVisionProxyRouting();
  const slots = [routing?.default, routing?.ocr, routing?.design, ...(routing?.fallback_chain ?? [])];
  for (const slot of slots) {
    const name = slot?.api_key_env;
    if (!name || savedSlotEnv.has(name)) continue;
    savedSlotEnv.set(name, process.env[name]);
    delete process.env[name];
  }
}

function restoreEnvKeyedVisionSlots(): void {
  for (const [name, value] of savedSlotEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedSlotEnv.clear();
}

beforeEach(async () => {
  await scrubEnvKeyedVisionSlots();
  vi.spyOn(keychain, "loadKeyForProvider").mockResolvedValue("sk-test-key-12345678901234567890");
  vi.spyOn(registry, "getModelInfo").mockImplementation((id: string) => {
    if (id === "deepseek-v4-flash") return { id, supportsVision: false } as any;
    if (id === "deepseek-v4-pro") return { id, supportsVision: false } as any;
    if (id === "claude-sonnet-4-6") return { id, supportsVision: true } as any;
    if (id === "gpt-4o") return { id } as any; // undefined = defaults to true
    return null as any;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreFetch();
  restoreEnvKeyedVisionSlots();
});

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

describe("planImageHandlingForTextOnlyModel", () => {
  beforeEach(async () => {
    vi.mocked(registry.getModelInfo).mockRestore();
    await registry.loadCatalog();
  });

  it("returns proxy when a vision-proxy chain provider has a key", async () => {
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "xai") return "sk-xai-key-123456789012345678";
      throw new Error("no key");
    });
    const plan = await planImageHandlingForTextOnlyModel({
      primaryModelId: "deepseek-v4-flash",
      imageCount: 1,
    });
    expect(plan.strategy).toBe("proxy");
  });

  it("returns native_model when proxy providers lack keys but another vision model is configured", async () => {
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    // Narrow the proxy chain to zai only, so a keyed vision model that is NOT a
    // chain slot is the only way images can be served — the native_model branch.
    vi.spyOn(registry, "getVisionProxyRouting").mockReturnValue({
      default: { provider: "zai", model_id: "glm-4.6v-flash" },
      fallback_chain: [],
    });
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "xai") return "sk-xai-key-1234567890123456789012";
      throw new Error("no key");
    });
    const plan = await planImageHandlingForTextOnlyModel({
      primaryModelId: "deepseek-v4-flash",
      imageCount: 1,
    });
    expect(plan.strategy).toBe("native_model");
    if (plan.strategy === "native_model") {
      expect(plan.fallback.provider).toBe("xai");
      expect(plan.fallback.modelId).toBe("grok-4.5");
    }
  });

  it("does NOT route an image to opencode-go, which answers without seeing it", async () => {
    // Verified live: the Console Go proxy returns HTTP 200 and "I cannot see the
    // image" — it drops image parts. `supports_vision:false` in the catalog keeps
    // it out of every vision path; the runtime blind-response guard in
    // vision-backend.ts is the second line of defence.
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "opencode-go") return "sk-opencode-key-123456789012345678";
      throw new Error("no key");
    });
    const plan = await planImageHandlingForTextOnlyModel({
      primaryModelId: "deepseek-v4-flash",
      imageCount: 1,
    });
    expect(plan.strategy).toBe("unavailable");
  });

  it("returns unavailable when no vision keys at all", async () => {
    vi.spyOn(keychain, "loadKeyForProvider").mockRejectedValue(new Error("no key"));
    const plan = await planImageHandlingForTextOnlyModel({
      primaryModelId: "deepseek-v4-flash",
      imageCount: 1,
    });
    expect(plan.strategy).toBe("unavailable");
    if (plan.strategy === "unavailable") {
      expect(plan.notice).toContain("<vision-observation");
      expect(plan.notice).toContain("Do NOT guess");
    }
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

  it("proxies images through catalog vision backend (Z.ai) for text-only model", async () => {
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
    expect(content.some((p) => p.text.includes("<vision-observation>"))).toBe(true);
    expect(content.some((p) => p.text.includes("login form"))).toBe(true);
    expect(content.some((p) => p.text.includes("direct visual observation"))).toBe(true);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.z.ai/api/coding/paas/v4/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test-key-12345678901234567890" }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("glm-4.6v-flash");
  });

  it("returns unavailable envelope when no vision API keys configured", async () => {
    const fetchSpy = vi.fn();
    setFetch(fetchSpy as unknown as typeof globalThis.fetch);
    vi.spyOn(keychain, "loadKeyForProvider").mockRejectedValue(new Error("no key"));

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
    expect(content.some((p) => p.text.includes('status="unavailable"'))).toBe(true);
    expect(content.some((p) => p.text.includes("Do NOT guess"))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns fallback description on API error", async () => {
    setFetch(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      }) as unknown as typeof globalThis.fetch,
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
    expect(content.some((p) => p.text.includes("these 2 images"))).toBe(true);
  });

  it("uses json_object response_format when user text signals design intent", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"viewport":{"width":1440}}' } }] }),
    });
    setFetch(mockFetch as unknown as typeof globalThis.fetch);

    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "redesign this Figma mockup as a dashboard" },
          { type: "image" as const, image: fakeBase64, mediaType: "image/png" },
        ],
      },
    ];

    await proxyVision(messages, "deepseek-v4-flash");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("does NOT set response_format for plain analysis intent", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
    });
    setFetch(mockFetch as unknown as typeof globalThis.fetch);

    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "what error is shown here?" },
          { type: "image" as const, image: fakeBase64, mediaType: "image/png" },
        ],
      },
    ];

    await proxyVision(messages, "deepseek-v4-flash");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toBeUndefined();
  });

  it("svg input bypasses vision API entirely", async () => {
    const mockFetch = vi.fn();
    setFetch(mockFetch as unknown as typeof globalThis.fetch);

    const svg = '<svg width="100"><rect x="10" y="10" fill="#007bff"/></svg>';
    const svgB64 = Buffer.from(svg, "utf8").toString("base64");

    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "redesign this layout" },
          { type: "image" as const, image: svgB64, mediaType: "image/svg+xml" },
        ],
      },
    ];

    const result = await proxyVision(messages, "deepseek-v4-flash");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.proxied).toBe(true);
    const content = result.messages[0].content as Array<{ type: string; text: string }>;
    expect(content.some((p) => p.text.includes("<vision-observation>"))).toBe(true);
    expect(content.some((p) => p.text.includes("rect"))).toBe(true);
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
