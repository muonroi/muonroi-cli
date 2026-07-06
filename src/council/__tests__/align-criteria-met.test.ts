import { describe, expect, it } from "vitest";
import { alignCriteriaMet } from "../debate.js";

describe("alignCriteriaMet (B3: grade rounds against pinned criteria)", () => {
  const pinned = ["Renders without OCR", "Colors captured", "No mojibake"];

  it("index-aligns when counts match (primary path)", () => {
    const status = [
      { criterion: "renders w/o ocr", met: true },
      { criterion: "colors", met: false },
      { criterion: "mojibake", met: true },
    ];
    expect(alignCriteriaMet(pinned, status)).toEqual([true, false, true]);
  });

  it("falls back to substring match when counts differ", () => {
    // Model dropped one criterion + reordered — match by text, unmatched → false.
    const status = [
      { criterion: "the No mojibake requirement holds", met: true },
      { criterion: "Renders without OCR fully", met: true },
    ];
    expect(alignCriteriaMet(pinned, status)).toEqual([true, false, true]);
  });

  it("defaults unmatched criteria to not-met (no silent all-met)", () => {
    expect(alignCriteriaMet(pinned, [{ criterion: "unrelated", met: true }])).toEqual([false, false, false]);
  });

  it("treats missing/undefined met as not-met", () => {
    const status = [{ criterion: "a" }, { met: true }, { criterion: "c", met: false }];
    expect(alignCriteriaMet(pinned, status)).toEqual([false, true, false]);
  });

  it("returns all-false for empty status", () => {
    expect(alignCriteriaMet(pinned, [])).toEqual([false, false, false]);
  });
});
