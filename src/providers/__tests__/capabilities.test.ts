import { describe, expect, it } from "vitest";
import { getProviderCapabilities } from "../capabilities.js";

describe("ProviderCapabilities", () => {
  describe("supportsResponseTool — reliable providers", () => {
    for (const id of ["openai", "anthropic", "google", "xai"] as const) {
      it(`${id} reports true for all task types`, () => {
        const caps = getProviderCapabilities(id);
        expect(caps.supportsResponseTool("general")).toBe(true);
        expect(caps.supportsResponseTool("analyze")).toBe(true);
        expect(caps.supportsResponseTool("plan")).toBe(true);
        expect(caps.supportsResponseTool("debug")).toBe(true);
      });
    }
  });

  describe("supportsResponseTool — DeepSeek family", () => {
    for (const id of ["deepseek", "siliconflow"] as const) {
      it(`${id} reports false for general (token leak), true for structured`, () => {
        const caps = getProviderCapabilities(id);
        expect(caps.supportsResponseTool("general")).toBe(false);
        expect(caps.supportsResponseTool("analyze")).toBe(true);
        expect(caps.supportsResponseTool("plan")).toBe(true);
        expect(caps.supportsResponseTool("debug")).toBe(true);
      });
    }
  });

  describe("supportsResponseTool — Ollama (conservative)", () => {
    it("reports false for general, true for structured", () => {
      const caps = getProviderCapabilities("ollama");
      expect(caps.supportsResponseTool("general")).toBe(false);
      expect(caps.supportsResponseTool("analyze")).toBe(true);
    });
  });

  describe("unknown provider id", () => {
    it("falls back to reliable defaults", () => {
      const caps = getProviderCapabilities("does-not-exist");
      expect(caps.supportsResponseTool("general")).toBe(true);
      expect(caps.supportsResponseTool("analyze")).toBe(true);
    });
  });
});
