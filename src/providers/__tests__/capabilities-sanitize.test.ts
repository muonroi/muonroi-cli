/**
 * sanitizeHistory coverage — every provider now returns the input array by
 * reference. The previous DeepSeek strip was removed once
 * reasoning-roundtrip.test.ts proved AI SDK 2.0.42 serializes assistant
 * reasoning parts as `reasoning_content` natively. Stripping them BEFORE the
 * send would re-introduce the original HTTP 400 code 20015 by breaking the
 * round-trip the DeepSeek thinking_mode guide requires.
 */
import { describe, expect, it } from "vitest";
import { getProviderCapabilities } from "../capabilities.js";
import type { ProviderId } from "../types.js";

const ALL_PROVIDERS: ProviderId[] = ["anthropic", "openai", "xai", "deepseek", "ollama"];

describe("ProviderCapabilities.sanitizeHistory — identity for every provider", () => {
  for (const p of ALL_PROVIDERS) {
    it(`${p} returns the input array by reference when reasoning parts present`, () => {
      const caps = getProviderCapabilities(p);
      const messages = [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "internal thought" },
            { type: "text", text: "Hello!" },
          ],
        },
      ];
      const out = caps.sanitizeHistory(messages);
      expect(out).toBe(messages);
    });

    it(`${p} returns the input array by reference when no reasoning parts present`, () => {
      const caps = getProviderCapabilities(p);
      const messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ];
      const out = caps.sanitizeHistory(messages);
      expect(out).toBe(messages);
    });
  }

  it("unknown provider id falls back to identity", () => {
    const caps = getProviderCapabilities("unknown-future-provider");
    const messages = [
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "x" }],
      },
    ];
    expect(caps.sanitizeHistory(messages)).toBe(messages);
  });

  it("deepseek still drops respond_general tool (separate quirk from reasoning)", () => {
    const caps = getProviderCapabilities("deepseek");
    expect(caps.supportsResponseTool("general")).toBe(false);
    expect(caps.supportsResponseTool("plan")).toBe(true);
  });
});
