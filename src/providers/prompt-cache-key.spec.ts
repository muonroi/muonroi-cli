/**
 * Unit tests for computePromptCacheKey — the F1 fix for OpenAI prompt
 * cache key stability across rounds in a session.
 */

import { describe, expect, it } from "vitest";

import { computePromptCacheKey } from "./runtime.js";

describe("computePromptCacheKey", () => {
  it("returns a stable 32-char hex hash for a given session id", () => {
    const a = computePromptCacheKey("sess-abc-123");
    const b = computePromptCacheKey("sess-abc-123");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it("produces different keys for different session ids", () => {
    const a = computePromptCacheKey("sess-aaa");
    const b = computePromptCacheKey("sess-bbb");
    expect(a).not.toBe(b);
  });

  it("returns undefined when no session id is provided", () => {
    expect(computePromptCacheKey(undefined)).toBeUndefined();
    expect(computePromptCacheKey("")).toBeUndefined();
  });
});
