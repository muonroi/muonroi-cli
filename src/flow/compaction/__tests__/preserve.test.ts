import { describe, expect, it } from "vitest";
import { extractPreservedBlocks, PRESERVE_CLOSE, PRESERVE_OPEN, restorePreservedBlocks } from "../preserve.js";

describe("extractPreservedBlocks", () => {
  it("extracts single preserve block and replaces with placeholder", () => {
    const text = `Before\n${PRESERVE_OPEN}\nKeep this verbatim\n${PRESERVE_CLOSE}\nAfter`;
    const { cleaned, blocks } = extractPreservedBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("\nKeep this verbatim\n");
    expect(cleaned).toContain("__PRESERVED_0__");
    expect(cleaned).not.toContain(PRESERVE_OPEN);
    expect(cleaned).not.toContain("Keep this verbatim");
    expect(cleaned).toContain("Before");
    expect(cleaned).toContain("After");
  });

  it("extracts multiple preserve blocks", () => {
    const text = `A\n${PRESERVE_OPEN}\nBlock1\n${PRESERVE_CLOSE}\nB\n${PRESERVE_OPEN}\nBlock2\n${PRESERVE_CLOSE}\nC`;
    const { cleaned, blocks } = extractPreservedBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("\nBlock1\n");
    expect(blocks[1].content).toBe("\nBlock2\n");
    expect(cleaned).toContain("__PRESERVED_0__");
    expect(cleaned).toContain("__PRESERVED_1__");
  });

  it("returns empty blocks for text without markers", () => {
    const text = "No markers here";
    const { cleaned, blocks } = extractPreservedBlocks(text);
    expect(blocks).toHaveLength(0);
    expect(cleaned).toBe(text);
  });

  it("handles empty text", () => {
    const { cleaned, blocks } = extractPreservedBlocks("");
    expect(blocks).toHaveLength(0);
    expect(cleaned).toBe("");
  });

  it("handles malformed markers gracefully (open without close)", () => {
    const text = `Before\n${PRESERVE_OPEN}\nUnclosed content`;
    const { cleaned, blocks } = extractPreservedBlocks(text);
    // Unclosed marker is NOT extracted
    expect(blocks).toHaveLength(0);
    expect(cleaned).toBe(text);
  });
});

describe("restorePreservedBlocks", () => {
  it("round-trips extract + restore", () => {
    const original = `Start\n${PRESERVE_OPEN}\nVerbatim content\n${PRESERVE_CLOSE}\nEnd`;
    const { cleaned, blocks } = extractPreservedBlocks(original);
    const restored = restorePreservedBlocks(cleaned, blocks);
    expect(restored).toBe(original);
  });

  it("restores multiple blocks in order", () => {
    const original = `A\n${PRESERVE_OPEN}\nFirst\n${PRESERVE_CLOSE}\nB\n${PRESERVE_OPEN}\nSecond\n${PRESERVE_CLOSE}\nC`;
    const { cleaned, blocks } = extractPreservedBlocks(original);
    const restored = restorePreservedBlocks(cleaned, blocks);
    expect(restored).toBe(original);
  });

  it("returns text unchanged when no blocks provided", () => {
    const text = "No placeholders here";
    const restored = restorePreservedBlocks(text, []);
    expect(restored).toBe(text);
  });
});
