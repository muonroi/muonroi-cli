import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type VisualFrame } from "../src/protocol.js";
import { computeVisualQuality } from "../src/visual-quality.js";

function frame(lines: string[]): VisualFrame {
  return {
    mode: "visual",
    version: PROTOCOL_VERSION,
    seq: 0,
    ts: 0,
    cols: 80,
    rows: lines.length,
    cursor: null,
    lines: lines.map((text) => ({
      spans: [{ text, fg: "#ffffff", bg: "#000000", attrs: 0, width: text.length }],
    })),
  };
}

describe("computeVisualQuality", () => {
  it("flags the council refine-loop garbage pattern (near-empty rows)", () => {
    // Mirrors the 2217600e1f27 render: skeleton "↳" rows + blank separators
    // dominate, with only a couple of substantial lines.
    const rows = ["Council convening...", "", "  ↳", "", " · Skip", "", "  ↳", "", " · Skip", "", "  ↳", ""];
    const r = computeVisualQuality(frame(rows));
    expect(r.nearEmptyRows).toBeGreaterThanOrEqual(8);
    expect(r.score).toBeLessThan(70);
    expect(r.issues.some((i) => i.includes("near-empty"))).toBe(true);
  });

  it("detects mojibake (misdecoded UTF-8 clusters)", () => {
    // "≡ƒÆí" is 💡 mis-decoded; "ΓÇô" is an em-dash mis-decoded.
    const r = computeVisualQuality(frame(["[Experience] ≡ƒÆí loaded", "cost ΓÇô high"]));
    expect(r.mojibakeCount).toBeGreaterThan(0);
    expect(r.issues.some((i) => i.toLowerCase().includes("mojibake"))).toBe(true);
  });

  it("detects U+FFFD replacement chars", () => {
    const r = computeVisualQuality(frame(["broken �� text"]));
    expect(r.mojibakeCount).toBeGreaterThanOrEqual(2);
  });

  it("gives a clean, dense render a high score with no issues", () => {
    const rows = [
      "Agent: how can I help you build the parser today?",
      "You: add a JSON tokenizer with position tracking",
      "Assistant: Here is a tokenizer that tracks line and column.",
      "  1  export function tokenize(src: string): Token[] {",
      "  2    const out: Token[] = [];",
      "  3    return out;",
      "  4  }",
    ];
    const r = computeVisualQuality(frame(rows));
    expect(r.issues).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.mojibakeCount).toBe(0);
  });

  it("does not false-positive on ordinary accented text", () => {
    const r = computeVisualQuality(frame(["Chào bạn, café résumé naïve piñata"]));
    expect(r.mojibakeCount).toBe(0);
  });
});
