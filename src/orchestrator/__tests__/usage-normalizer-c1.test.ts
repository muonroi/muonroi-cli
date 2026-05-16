/**
 * src/orchestrator/__tests__/usage-normalizer-c1.test.ts
 *
 * Phase C1 — DeepSeek cache-token field reading.
 *
 * Before the fix, `getUsage()` and `getBatchUsage()` only consulted
 * `event.usage.cachedInputTokens`, `event.usage.inputTokenDetails.*`, and
 * `event.usage.raw.cache_creation_input_tokens`. DeepSeek goes through
 * `@ai-sdk/openai-compatible`, which exposes its cache split via
 * `providerMetadata.deepseek.{promptCacheHitTokens, promptCacheMissTokens}`
 * (streaming events) or raw `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * fields (batch responses). Neither path was being read, so every DeepSeek
 * request recorded `cache_read_tokens = 0` — flagged by `usage forensics`
 * as "zero cache_creation across deepseek route — Phase C1 still open".
 *
 * This spec pins the new behavior:
 *   - DeepSeek-shaped batch usage → cacheReadTokens=700, noCacheInputTokens=300
 *   - DeepSeek-shaped streaming event (providerMetadata path) → same
 *   - OpenAI-shaped usage → unchanged (no DeepSeek-specific fields read)
 */

import { describe, expect, it } from "vitest";
import { getBatchUsage } from "../batch-utils";
import { getUsage } from "../tool-utils";

describe("C1: DeepSeek cache-token field reading", () => {
  describe("getBatchUsage (raw API response shape)", () => {
    it("reads DeepSeek prompt_cache_hit_tokens into cacheReadTokens and prompt_cache_miss_tokens into noCacheInputTokens", () => {
      const result = getBatchUsage({
        usage: {
          prompt_tokens: 1000,
          prompt_cache_hit_tokens: 700,
          prompt_cache_miss_tokens: 300,
          completion_tokens: 50,
        },
      } as unknown as Parameters<typeof getBatchUsage>[0]);

      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(50);
      expect(result.cacheReadTokens).toBe(700);
      expect(result.noCacheInputTokens).toBe(300);
      // DeepSeek has no explicit cache-creation field — leave undefined, do not
      // zero-fill (zero would mask a real provider regression).
      expect(result.cacheCreationTokens).toBeUndefined();
    });

    it("control: OpenAI-shaped batch usage is unchanged (no DeepSeek-specific fields)", () => {
      const result = getBatchUsage({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
        },
      } as unknown as Parameters<typeof getBatchUsage>[0]);

      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(50);
      expect(result.cacheReadTokens).toBeUndefined();
      expect(result.cacheCreationTokens).toBeUndefined();
      expect(result.noCacheInputTokens).toBeUndefined();
    });

    it("control: Anthropic-style cache_read_input_tokens still wins over DeepSeek fallback", () => {
      const result = getBatchUsage({
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
        },
      } as unknown as Parameters<typeof getBatchUsage>[0]);

      expect(result.cacheReadTokens).toBe(800);
      expect(result.cacheCreationTokens).toBe(200);
      expect(result.noCacheInputTokens).toBeUndefined();
    });
  });

  describe("getUsage (streamText onStepFinish event shape)", () => {
    it("reads DeepSeek providerMetadata.deepseek.promptCacheHitTokens / promptCacheMissTokens", () => {
      // Mirrors the shape AI SDK v6 produces for `@ai-sdk/openai-compatible`
      // pointed at DeepSeek: standardized usage fields PLUS a provider-specific
      // bucket on `event.providerMetadata`.
      const event = {
        finishReason: "stop",
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          totalTokens: 1050,
        },
        providerMetadata: {
          deepseek: {
            promptCacheHitTokens: 700,
            promptCacheMissTokens: 300,
          },
        },
      };

      const result = getUsage(event);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(50);
      expect(result.totalTokens).toBe(1050);
      expect(result.cacheReadTokens).toBe(700);
      expect(result.noCacheInputTokens).toBe(300);
      expect(result.cacheCreationTokens).toBeUndefined();
    });

    it("falls back to legacy usage.raw shape for batched DeepSeek responses", () => {
      const event = {
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          raw: {
            prompt_cache_hit_tokens: 700,
            prompt_cache_miss_tokens: 300,
          },
        },
      };

      const result = getUsage(event);
      expect(result.cacheReadTokens).toBe(700);
      expect(result.noCacheInputTokens).toBe(300);
    });

    it("reads OpenAI providerMetadata.openai.cachedPromptTokens for cacheReadTokens", () => {
      const event = {
        usage: { inputTokens: 1000, outputTokens: 50 },
        providerMetadata: {
          openai: { cachedPromptTokens: 256 },
        },
      };

      const result = getUsage(event);
      expect(result.cacheReadTokens).toBe(256);
      expect(result.noCacheInputTokens).toBeUndefined();
    });

    it("control: standardized cachedInputTokens still takes priority over providerMetadata", () => {
      const event = {
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          cachedInputTokens: 900, // standardized field — must win
        },
        providerMetadata: {
          deepseek: { promptCacheHitTokens: 700 },
        },
      };

      const result = getUsage(event);
      expect(result.cacheReadTokens).toBe(900);
    });

    it("control: OpenAI-shaped event with no DeepSeek fields → no cache metrics", () => {
      const event = {
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      };

      const result = getUsage(event);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(50);
      expect(result.cacheReadTokens).toBeUndefined();
      expect(result.cacheCreationTokens).toBeUndefined();
      expect(result.noCacheInputTokens).toBeUndefined();
    });

    it("handles missing usage gracefully", () => {
      expect(getUsage(undefined)).toEqual({});
      expect(getUsage({})).toEqual({});
      expect(getUsage({ usage: null })).toEqual({});
    });
  });
});
