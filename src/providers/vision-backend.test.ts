import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "../models/registry.js";
import * as keychain from "./keychain.js";
import {
  formatNativeVisionObservation,
  formatNativeVisionUnavailable,
  looksLikeOcrIntent,
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

describe("formatNativeVisionUnavailable", () => {
  it("tells model not to guess and suggests retry paths", () => {
    const out = formatNativeVisionUnavailable(2, ["HTTP 500"], ["img_2"]);
    expect(out).toContain('status="unavailable"');
    expect(out).toContain("Do NOT guess");
    expect(out).toContain("analyze_image");
    expect(out).toContain("img_2");
  });
});
