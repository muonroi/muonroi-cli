import { describe, expect, it } from "vitest";
import { stripThinkBlocks } from "../strip-think.js";

describe("stripThinkBlocks", () => {
  it("removes a leading think block and keeps the answer", () => {
    const input = "<think>\nLet me draft this…\nword count ok\n</think>\n**Position:** approved.";
    expect(stripThinkBlocks(input)).toBe("**Position:** approved.");
  });

  it("removes multiple think blocks", () => {
    const input = "<think>a</think>hello<think>b</think> world";
    expect(stripThinkBlocks(input)).toBe("hello world");
  });

  it("removes an unclosed trailing think block (truncated output)", () => {
    const input = "final answer here\n<think>this got cut off by maxTok";
    expect(stripThinkBlocks(input)).toBe("final answer here");
  });

  it("removes a stray leading close tag (model omits the opener)", () => {
    const input = "reasoning tail…</think>\nreal answer";
    expect(stripThinkBlocks(input)).toBe("real answer");
  });

  it("returns empty string when the whole text is one unclosed think block", () => {
    expect(stripThinkBlocks("<think>only reasoning, truncated")).toBe("");
  });

  it("passes through text with no think markup unchanged", () => {
    const input = "**Position:** the approach is `sound`.\n- bullet";
    expect(stripThinkBlocks(input)).toBe(input);
  });

  it("is case-insensitive on the tag name", () => {
    expect(stripThinkBlocks("<THINK>x</THINK>answer")).toBe("answer");
  });
});
