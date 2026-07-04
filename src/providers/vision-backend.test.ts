import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "../models/registry.js";
import * as settings from "../utils/settings.js";
import * as keychain from "./keychain.js";
import {
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
      fallback_chain: [{ provider: "xai", model_id: "grok-build-0.1" }],
    });

    const chain = resolveVisionChain("design");
    expect(chain[0]).toEqual({ provider: "zai", model_id: "glm-5.2" });
    expect(chain.some((s) => s.model_id === "grok-build-0.1")).toBe(true);
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
      fallback_chain: [{ provider: "xai", model_id: "grok-build-0.1" }],
    });
    vi.spyOn(keychain, "loadKeyForProvider").mockImplementation(async (p) => {
      if (p === "xai") return "sk-xai-key-123456789012345678";
      throw new Error("no key");
    });

    const chain = await resolveAvailableVisionChain();
    expect(chain).toEqual([{ provider: "xai", model_id: "grok-build-0.1" }]);
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
