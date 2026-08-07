import { describe, expect, it } from "vitest";
import { alignCriteriaDeferred, alignCriteriaMet } from "../debate.js";

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

describe("alignCriteriaDeferred (criteria a debate cannot close)", () => {
  const pinned = ["Identify the overlapping layers", "Land the code change", "Behaviour preserved after the change"];

  it("index-aligns the leader's deferred flags when counts match", () => {
    const status = [
      { criterion: "identify layers", deferred: false },
      { criterion: "land the change", deferred: true },
      { criterion: "behaviour preserved", deferred: true },
    ];
    expect(alignCriteriaDeferred(pinned, status)).toEqual([false, true, true]);
  });

  it("falls back to substring match when the model drifts", () => {
    const status = [
      { criterion: "Behaviour preserved after the change is in", deferred: true },
      { criterion: "Identify the overlapping layers properly", deferred: false },
    ];
    expect(alignCriteriaDeferred(pinned, status)).toEqual([false, false, true]);
  });

  it("defaults to NOT deferred on any drift or omission", () => {
    // Deliberately asymmetric with alignCriteriaMet's default: wrongly marking a
    // debatable criterion "deferred" would silently retire it from the debate's
    // goals, which is worse than briefly over-reporting it as open.
    expect(alignCriteriaDeferred(pinned, [{ criterion: "unrelated", deferred: true }])).toEqual([false, false, false]);
    expect(alignCriteriaDeferred(pinned, [])).toEqual([false, false, false]);
    expect(alignCriteriaDeferred(pinned, [{ criterion: "a" }, { criterion: "b" }, { criterion: "c" }])).toEqual([
      false,
      false,
      false,
    ]);
  });
});
