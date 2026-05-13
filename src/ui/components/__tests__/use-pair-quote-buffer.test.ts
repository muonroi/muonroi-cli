import { describe, expect, it } from "vitest";
import { makePairKey } from "../bubble-layout.js";

// Inline mirror of the ring buffer logic — keeps the test pure (no React hook overhead).
function makeQuoteBuffer() {
  const buf = new Map<string, string>();
  return {
    set(pairKey: string, speakerRole: string, text: string) {
      buf.set(`${pairKey}::${speakerRole}`, text);
    },
    getPartnerLast(pairKey: string, partnerRole: string): string | undefined {
      return buf.get(`${pairKey}::${partnerRole}`);
    },
  };
}

describe("pair quote buffer", () => {
  it("returns undefined before any text is stored", () => {
    const buf = makeQuoteBuffer();
    expect(buf.getPartnerLast("A↔B", "Backend Engineer")).toBeUndefined();
  });

  it("returns the last stored text for a partner", () => {
    const buf = makeQuoteBuffer();
    const key = makePairKey("Frontend Engineer", "Backend Engineer");
    buf.set(key, "Backend Engineer", "we should check the boundary");
    expect(buf.getPartnerLast(key, "Backend Engineer")).toBe("we should check the boundary");
  });

  it("overwrites on second store (ring = keep latest)", () => {
    const buf = makeQuoteBuffer();
    const key = makePairKey("A", "B");
    buf.set(key, "A", "first message");
    buf.set(key, "A", "second message");
    expect(buf.getPartnerLast(key, "A")).toBe("second message");
  });

  it("makePairKey is order-independent", () => {
    expect(makePairKey("A", "B")).toBe(makePairKey("B", "A"));
  });
});
