import { describe, expect, it } from "vitest";
import { pickStanceQuote, type StanceTurn, windowStart } from "../council-stance-matrix.js";

const turns: StanceTurn[] = [
  {
    role: "architect",
    text: "Keep REST at the edge. The public contract never moves, so contract stability is not contested.",
    round: 1,
    model: "deepseek-v4-pro",
  },
  {
    role: "skeptic",
    text: "Config is never just config. The transcoder descriptor set is published on every deploy — that IS the public contract as far as consumers are concerned.",
    round: 2,
    model: "glm-4.6",
  },
  { role: "skeptic", text: "Three teams have to coordinate the release order.", round: 2, model: "glm-4.6" },
];

describe("pickStanceQuote", () => {
  it("picks the panelist's own sentence that overlaps the criterion", () => {
    const q = pickStanceQuote({ criterion: "public contract stability", role: "skeptic", mark: "-", turns });
    expect(q?.matched).toBe(true);
    expect(q?.text).toContain("public contract");
    expect(q?.round).toBe(2);
    expect(q?.model).toBe("glm-4.6");
  });

  it("never crosses roles — a quote is attributed to whoever said it", () => {
    const q = pickStanceQuote({ criterion: "public contract stability", role: "architect", mark: "+", turns });
    expect(q?.text).toContain("contract stability is not contested");
  });

  // The honesty rule: with no passage on this criterion, say so rather than
  // presenting an unrelated paragraph as the evidence behind the mark.
  it("falls back to the latest turn and flags it as unmatched", () => {
    const q = pickStanceQuote({
      criterion: "kubernetes autoscaling headroom",
      role: "skeptic",
      mark: "-",
      turns,
    });
    expect(q?.matched).toBe(false);
    expect(q?.text).toBe("Three teams have to coordinate the release order.");
  });

  it("returns null when the panelist has not spoken", () => {
    expect(pickStanceQuote({ criterion: "anything", role: "security", mark: null, turns })).toBeNull();
  });

  it("truncates a long passage", () => {
    const long = "contract ".repeat(80);
    const q = pickStanceQuote({
      criterion: "contract",
      role: "r",
      mark: "+",
      turns: [{ role: "r", text: long }],
      maxChars: 40,
    });
    expect(q?.text.length).toBe(40);
    expect(q?.text.endsWith("…")).toBe(true);
  });
});

describe("windowStart", () => {
  it("keeps the caller's offset when the selection is already visible", () => {
    expect(windowStart(0, 2, 5, 8)).toBe(0);
  });

  it("scrolls right just far enough to reveal the selection", () => {
    expect(windowStart(0, 6, 5, 8)).toBe(2);
  });

  it("scrolls left to the selected column", () => {
    expect(windowStart(4, 1, 5, 8)).toBe(1);
  });

  it("never scrolls past the end of the roster", () => {
    expect(windowStart(99, null, 5, 8)).toBe(3);
  });

  it("is a no-op when every column fits", () => {
    expect(windowStart(0, 2, 8, 3)).toBe(0);
  });
});
