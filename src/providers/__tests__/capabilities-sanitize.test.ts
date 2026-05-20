/**
 * G2 sanitizeHistory coverage — verifies the capability hook added in Phase
 * 12.2 group 2 strips assistant `reasoning` parts only on the SiliconFlow
 * capability. Every other provider's capability returns input by reference.
 *
 * Backs commit isolating the inline `provider === "siliconflow"` check that
 * previously lived in src/orchestrator/orchestrator.ts at two call sites.
 */
import { describe, expect, it } from "vitest";
import { getProviderCapabilities } from "../capabilities.js";
import type { ProviderId } from "../types.js";

const IDENTITY_PROVIDERS: ProviderId[] = ["anthropic", "openai", "google", "xai", "deepseek", "ollama"];

describe("ProviderCapabilities.sanitizeHistory — G2", () => {
  describe("identity providers", () => {
    for (const p of IDENTITY_PROVIDERS) {
      it(`${p} returns the input array by reference (no rewrite)`, () => {
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
  });

  describe("siliconflow", () => {
    const caps = getProviderCapabilities("siliconflow");

    it("strips assistant reasoning parts from history", () => {
      const messages = [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "think" },
            { type: "text", text: "Hello!" },
          ],
        },
      ];
      const out = caps.sanitizeHistory(messages);
      expect(out).not.toBe(messages);
      expect(out).toHaveLength(2);
      expect((out[1] as { content: unknown[] }).content).toEqual([{ type: "text", text: "Hello!" }]);
    });

    it("returns input by reference when no reasoning parts present", () => {
      const messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ];
      const out = caps.sanitizeHistory(messages);
      expect(out).toBe(messages);
    });

    it("still satisfies the deepseek supportsResponseTool override (inheritance)", () => {
      expect(caps.supportsResponseTool("general")).toBe(false);
      expect(caps.supportsResponseTool("plan")).toBe(true);
    });
  });
});
