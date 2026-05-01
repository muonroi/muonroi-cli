import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ollamaClassify } from "../ollama-classify.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(response),
  });
}

describe("ollamaClassify", () => {
  it("returns taskType when Ollama responds with valid category", async () => {
    mockFetch({ response: "debug" });
    const result = await ollamaClassify("something is broken");
    expect(result).toEqual({ taskType: "debug", confidence: 0.55 });
  });

  it('returns taskType for "refactor" response', async () => {
    mockFetch({ response: "refactor" });
    const result = await ollamaClassify("clean up this code");
    expect(result).toEqual({ taskType: "refactor", confidence: 0.55 });
  });

  it('returns null when Ollama responds with "none"', async () => {
    mockFetch({ response: "none" });
    const result = await ollamaClassify("hello world");
    expect(result).toBeNull();
  });

  it("returns null when Ollama responds with unrecognized text", async () => {
    mockFetch({ response: "I think this is a question about cooking" });
    const result = await ollamaClassify("how to make pasta");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (Ollama unavailable)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await ollamaClassify("test prompt");
    expect(result).toBeNull();
  });

  it("returns null when response is not ok (500)", async () => {
    mockFetch({}, false);
    const result = await ollamaClassify("test prompt");
    expect(result).toBeNull();
  });

  it("returns null when fetch is aborted (timeout)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const result = await ollamaClassify("test prompt");
    expect(result).toBeNull();
  });

  it("confidence is always 0.55 for Ollama results", async () => {
    mockFetch({ response: "plan" });
    const result = await ollamaClassify("design the architecture");
    expect(result?.confidence).toBe(0.55);
  });

  it("handles empty response field gracefully", async () => {
    mockFetch({ response: "" });
    const result = await ollamaClassify("test");
    expect(result).toBeNull();
  });

  it("handles missing response field gracefully", async () => {
    mockFetch({});
    const result = await ollamaClassify("test");
    expect(result).toBeNull();
  });
});
