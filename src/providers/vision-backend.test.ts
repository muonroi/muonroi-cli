import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "../models/registry.js";
import * as usage from "../storage/usage.js";
import * as settings from "../utils/settings.js";
import * as keychain from "./keychain.js";
import {
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
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "xai") return "sk-xai-key-123456789012345678";
      throw new Error("no key");
    });
    const hit = await findNativeVisionFallback({ excludeModelId: "deepseek-v4-flash" });
    expect(hit).not.toBeNull();
    expect(hit!.provider).toBe("xai");
    expect(hit!.modelId).toMatch(/grok/);
  });

  it("falls back to non-proxy vision provider when zai/xai keys are missing", async () => {
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "opencode-go") return "sk-opencode-key-123456789012345678";
      throw new Error("no key");
    });
    const hit = await findNativeVisionFallback({ excludeModelId: "deepseek-v4-flash" });
    expect(hit).toEqual({
      modelId: "opencode/glm-5.2",
      provider: "opencode-go",
      source: "catalog_vision",
    });
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
