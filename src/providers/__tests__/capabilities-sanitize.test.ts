/**
 * G2 sanitizeHistory coverage — verifies which capabilities strip assistant
 * `reasoning` parts. Per DeepSeek docs, reasoning_content must not round-trip
 * in subsequent turns, so both `deepseek` and `siliconflow` strip. Other
 * providers' capabilities return the input by reference.
 */
import { describe, expect, it } from "vitest";
import { getProviderCapabilities } from "../capabilities.js";
import type { ProviderId } from "../types.js";

const IDENTITY_PROVIDERS: ProviderId[] = ["anthropic", "openai", "google", "xai", "ollama"];
const STRIPPING_PROVIDERS: ProviderId[] = ["deepseek", "siliconflow"];

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

  describe("stripping providers", () => {
    for (const p of STRIPPING_PROVIDERS) {
      const caps = getProviderCapabilities(p);

      it(`${p} strips assistant reasoning parts from history`, () => {
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

      it(`${p} returns input by reference when no reasoning parts present`, () => {
        const messages = [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ];
        const out = caps.sanitizeHistory(messages);
        expect(out).toBe(messages);
      });

      it(`${p} still satisfies the deepseek supportsResponseTool override`, () => {
        expect(caps.supportsResponseTool("general")).toBe(false);
        expect(caps.supportsResponseTool("plan")).toBe(true);
      });
    }
  });
});
