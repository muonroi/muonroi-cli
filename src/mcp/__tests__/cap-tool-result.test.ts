import { describe, expect, it } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS } from "../../tools/registry.js";
import { capMcpToolResult } from "../cap-tool-result.js";

const cap = 1_000;

describe("capMcpToolResult()", () => {
  it("truncates an over-cap string result", () => {
    const big = "X".repeat(cap + 5_000);
    const out = capMcpToolResult(big, cap);
    expect(typeof out).toBe("string");
    expect((out as string).length).toBeLessThan(big.length);
    expect(out as string).toContain("truncated");
  });

  it("leaves an under-cap string result unchanged", () => {
    const small = "hello world";
    expect(capMcpToolResult(small, cap)).toBe(small);
  });

  it("truncates a huge text part inside a content result", () => {
    const big = "Y".repeat(cap + 5_000);
    const result = { type: "content", value: [{ type: "text", text: big }] };
    const out = capMcpToolResult(result, cap) as { type: string; value: Array<{ type: string; text: string }> };
    expect(out.type).toBe("content");
    expect(out.value[0]!.text.length).toBeLessThan(big.length);
    expect(out.value[0]!.text).toContain("truncated");
  });

  it("leaves non-text parts (e.g. images) untouched", () => {
    const image = { type: "image", data: "BASE64DATA", mediaType: "image/png" };
    const result = { type: "content", value: [image] };
    const out = capMcpToolResult(result, cap) as { value: unknown[] };
    expect(out.value[0]).toEqual(image);
  });

  it("enforces a cumulative budget across multiple text parts", () => {
    const partLen = cap; // each part alone is exactly the cap
    const result = {
      type: "content",
      value: [
        { type: "text", text: "A".repeat(partLen) },
        { type: "text", text: "B".repeat(partLen) },
        { type: "text", text: "C".repeat(partLen) },
      ],
    };
    const out = capMcpToolResult(result, cap) as { value: Array<{ type: string; text: string }> };
    const total = out.value.reduce((n, p) => n + p.text.length, 0);
    // First part consumes the budget; later parts are elided to short markers,
    // so the combined text stays close to the cap (plus small marker overhead).
    expect(total).toBeLessThan(cap * 2);
    expect(out.value[2]!.text).toContain("omitted");
  });

  it("returns structured (non-content, non-string) results unchanged", () => {
    const structured = { ok: true, rows: [1, 2, 3] };
    expect(capMcpToolResult(structured, cap)).toEqual(structured);
  });

  it("defaults to MAX_TOOL_OUTPUT_CHARS when no cap is passed", () => {
    const big = "Z".repeat(MAX_TOOL_OUTPUT_CHARS + 10_000);
    const out = capMcpToolResult(big) as string;
    expect(out.length).toBeLessThan(big.length);
  });
});
