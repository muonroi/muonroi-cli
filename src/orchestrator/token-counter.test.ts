import { afterEach, describe, expect, it } from "vitest";
import { __forceFallbackForTests, countTokens, isTokenizerReady, setProviderHint } from "./token-counter";

describe("token-counter", () => {
  afterEach(() => {
    __forceFallbackForTests(false);
    setProviderHint(null);
  });

  it("returns 0 for empty input", () => {
    expect(countTokens("")).toBe(0);
  });

  it("uses BPE tokenizer when available — code is denser than chars/4", () => {
    __forceFallbackForTests(false);
    expect(isTokenizerReady()).toBe(true);
    // A short code-like string of 20 chars: chars/4 = 5, BPE typically 6–10.
    const code = "const x = foo(bar);";
    const bpe = countTokens(code);
    const heuristic = Math.ceil(code.length / 4);
    // BPE for code is generally >= heuristic (code uses more, denser tokens).
    expect(bpe).toBeGreaterThanOrEqual(heuristic - 1);
    // And it should NOT be a wild over-count.
    expect(bpe).toBeLessThan(heuristic * 3);
  });

  it("falls back to chars/4 when forced", () => {
    __forceFallbackForTests(true);
    expect(countTokens("hello world")).toBe(Math.ceil("hello world".length / 4));
    expect(isTokenizerReady()).toBe(false);
  });

  it("BPE is closer to ground truth on prose vs chars/4", () => {
    // English prose: chars/4 typically overcounts. BPE gives a smaller number.
    __forceFallbackForTests(false);
    const prose = "The quick brown fox jumps over the lazy dog. Repeated several times for a longer sample.";
    const bpe = countTokens(prose);
    const heuristic = Math.ceil(prose.length / 4);
    expect(bpe).toBeLessThan(heuristic);
  });

  it("applies the deepseek correction multiplier (~+5%) on top of cl100k_base", () => {
    __forceFallbackForTests(false);
    const text = "function add(a, b) { return a + b; }".repeat(10);

    setProviderHint(null);
    const baseline = countTokens(text);

    setProviderHint("deepseek");
    const adjusted = countTokens(text);

    // Multiplier of 1.05 must round up — adjusted is strictly greater than baseline.
    expect(adjusted).toBeGreaterThan(baseline);
    expect(adjusted).toBe(Math.ceil(baseline * 1.05));
  });

  it("unknown providers get no correction (multiplier = 1)", () => {
    __forceFallbackForTests(false);
    const text = "hello world this is some sample text for tokenization";

    setProviderHint(null);
    const baseline = countTokens(text);

    setProviderHint("some-unknown-provider");
    const adjusted = countTokens(text);

    expect(adjusted).toBe(baseline);
  });
});
