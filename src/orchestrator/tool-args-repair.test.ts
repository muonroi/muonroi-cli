/**
 * Regression for Qwen3-30B malformed tool-call args observed in sessions
 *   080fe2fcbf24 and 11bb9218f605 (2026-05-26).
 *
 * Each describe block locks one observed failure mode plus controls that
 * the repair must NOT corrupt valid JSON, ambiguous patterns outside open
 * strings, or unrelated malformations.
 */
import { describe, expect, it } from "vitest";
import { _internals, repairToolCallArgs } from "./tool-args-repair.js";

describe("repairToolCallArgs — observed Qwen samples", () => {
  it("repairs session 11bb9218f605: missing close-quote + trailing brace + </tool_call>", () => {
    // Raw input as seen in interaction_logs.tool_call.argsPreview for the
    // 3 consecutive grep failures.
    const raw = '{"pattern": "catch\\\\s*\\\\{[^}]*\\\\}, "path": "src", "include": "*.ts"}}\n</tool_call>';
    const result = repairToolCallArgs(raw);
    if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result)}`);
    expect(result.value).toEqual({
      pattern: "catch\\s*\\{[^}]*\\}",
      path: "src",
      include: "*.ts",
    });
    // Confirm the repair pipeline applied the expected transforms.
    expect(result.transforms).toContain("strip-native-tags");
    expect(result.transforms).toContain("strip-trailing-braces");
    expect(result.transforms).toContain("insert-missing-close-quote");
  });

  it("repairs session 080fe2fcbf24: missing close-quote + space-after-comma", () => {
    const raw = '{"pattern": "catch\\\\s*\\\\{\\\\s*\\\\}, "path": ".", "include": "*.ts"}';
    const result = repairToolCallArgs(raw);
    if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result)}`);
    expect(result.value).toEqual({
      pattern: "catch\\s*\\{\\s*\\}",
      path: ".",
      include: "*.ts",
    });
    expect(result.transforms).toContain("insert-missing-close-quote");
  });
});

describe("repairToolCallArgs — must NOT corrupt valid input", () => {
  it("returns fast-path with no transforms on already-valid JSON", () => {
    const valid = '{"pattern": "catch\\\\s*\\\\{[^}]*\\\\}", "path": "src"}';
    const result = repairToolCallArgs(valid);
    if (!result.ok) throw new Error("valid JSON must parse on fast path");
    expect(result.value).toEqual({ pattern: "catch\\s*\\{[^}]*\\}", path: "src" });
    expect(result.transforms).toEqual([]);
  });

  it("does not insert a quote when \\\\} appears outside an open string", () => {
    // Object body contains `\\}` only inside a properly-closed string; the
    // comma + key that follows is at the top level, not a malformed string.
    // Note: the input below is intentionally NOT malformed — repair must be
    // a no-op (initial parse succeeds).
    const valid = '{"a": "x\\\\}", "b": "y"}';
    const result = repairToolCallArgs(valid);
    if (!result.ok) throw new Error("valid JSON must parse");
    expect(result.transforms).toEqual([]);
  });

  it("refuses to repair when more than 5 extra trailing braces (input too damaged)", () => {
    const raw = '{"a": 1}}}}}}}}';
    const result = repairToolCallArgs(raw);
    expect(result.ok).toBe(false);
  });

  it("refuses to repair empty / non-string inputs", () => {
    expect(repairToolCallArgs("").ok).toBe(false);
    // @ts-expect-error — runtime guard for non-string
    expect(repairToolCallArgs(null).ok).toBe(false);
    // @ts-expect-error — runtime guard for non-string
    expect(repairToolCallArgs(undefined).ok).toBe(false);
  });

  it("refuses to repair inputs > 50KB (out-of-scope adversarial)", () => {
    const big = `{"x": "${"y".repeat(60_000)}"}`;
    const result = repairToolCallArgs(big);
    expect(result.ok).toBe(false);
  });

  it("returns ok=false (not throw) on totally unrelated garbage", () => {
    expect(repairToolCallArgs("this is not json at all").ok).toBe(false);
    expect(repairToolCallArgs("<xml>foo</xml>").ok).toBe(false);
  });
});

describe("stripNativeFormatLeak", () => {
  const { stripNativeFormatLeak } = _internals;

  it("strips trailing </tool_call>", () => {
    expect(stripNativeFormatLeak('{"a": 1}\n</tool_call>')).toBe('{"a": 1}');
  });

  it("strips trailing </tool_calls> plural variant", () => {
    expect(stripNativeFormatLeak('{"a": 1}</tool_calls>')).toBe('{"a": 1}');
  });

  it("strips trailing <|tool_call_end|> Qwen sentinel", () => {
    expect(stripNativeFormatLeak('{"a": 1}<|tool_call_end|>')).toBe('{"a": 1}');
  });

  it("only strips at end — interior occurrences are preserved (data, not control)", () => {
    expect(stripNativeFormatLeak('{"description": "see </tool_call> in docs"}')).toBe(
      '{"description": "see </tool_call> in docs"}',
    );
  });

  it("is case-insensitive on the tag", () => {
    expect(stripNativeFormatLeak('{"a": 1}</TOOL_CALL>')).toBe('{"a": 1}');
  });
});

describe("stripUnbalancedTrailingBraces", () => {
  const { stripUnbalancedTrailingBraces } = _internals;

  it("strips a single extra trailing brace", () => {
    expect(stripUnbalancedTrailingBraces('{"a": 1}}')).toBe('{"a": 1}');
  });

  it("does not strip when braces are balanced", () => {
    expect(stripUnbalancedTrailingBraces('{"a": {"b": 1}}')).toBe('{"a": {"b": 1}}');
  });

  it("does not count braces inside string values", () => {
    // 2 `{` open, 1 `}` close, plus literal `{` in string — must NOT touch.
    expect(stripUnbalancedTrailingBraces('{"x": "{{{"}')).toBe('{"x": "{{{"}');
  });

  it("respects escape sequences inside strings", () => {
    // `\\}` inside a string is one regex character, not a brace.
    expect(stripUnbalancedTrailingBraces('{"x": "a\\\\}b"}')).toBe('{"x": "a\\\\}b"}');
  });
});

describe("insertMissingCloseQuote", () => {
  const { insertMissingCloseQuote } = _internals;

  it('inserts close-quote after \\\\} when followed by `, "key"`', () => {
    const before = '{"a": "x\\\\}, "b": 1}';
    const after = insertMissingCloseQuote(before);
    expect(after).toBe('{"a": "x\\\\}", "b": 1}');
  });

  it("handles \\\\] terminator", () => {
    const before = '{"a": "x\\\\], "b": 1}';
    const after = insertMissingCloseQuote(before);
    expect(after).toBe('{"a": "x\\\\]", "b": 1}');
  });

  it("returns input unchanged when no inside-string match", () => {
    const balanced = '{"a": "x", "b": 1}';
    expect(insertMissingCloseQuote(balanced)).toBe(balanced);
  });
});
