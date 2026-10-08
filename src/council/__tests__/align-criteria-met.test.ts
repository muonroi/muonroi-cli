import { describe, expect, it } from "vitest";
import { alignCriteriaDeferred, alignCriteriaEvidence, alignCriteriaMet } from "../debate.js";

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

describe("C2b — carry-forward for a criterion this round's reply never touched", () => {
  const pinned = ["Renders without OCR", "Colors captured", "No mojibake"];

  it("alignCriteriaMet: carries a MET prior verdict forward when the criterion is omitted (count mismatch)", () => {
    // Only "Colors captured" is reported this round (simulating perRoundFocus
    // narrowing the leader's reply to one item) — the other two are omitted,
    // not echoed.
    const status = [{ criterion: "colors captured", met: false }];
    const priorMet = [true, true, false]; // criterion 0 and 1 were MET last round
    expect(alignCriteriaMet(pinned, status, priorMet)).toEqual([
      true, // omitted -> carried from priorMet[0]
      false, // matched this round -> fresh verdict wins (downgrade honored)
      false, // omitted -> carried from priorMet[2]
    ]);
  });

  it("alignCriteriaMet: never upgrades an unmet criterion via carry-forward", () => {
    const status = [{ criterion: "colors captured", met: true }];
    const priorMet = [false, false, false];
    expect(alignCriteriaMet(pinned, status, priorMet)).toEqual([
      false, // omitted, prior was unmet -> stays unmet, not upgraded
      true, // matched this round, leader explicitly grants it -> fresh verdict wins
      false, // omitted, prior was unmet -> stays unmet
    ]);
  });

  it("alignCriteriaMet: a criterion matched this round always uses the fresh verdict, never the carried value", () => {
    // Count-matched (index-aligned) path: every pinned criterion is treated as
    // addressed, so a prior value must never leak through even when supplied.
    const status = [
      { criterion: "renders w/o ocr", met: false },
      { criterion: "colors", met: false },
      { criterion: "mojibake", met: false },
    ];
    const priorMet = [true, true, true];
    expect(alignCriteriaMet(pinned, status, priorMet)).toEqual([false, false, false]);
  });

  it("alignCriteriaMet: round 1 (no prior) behaves exactly as today — omitted criteria default to not-met", () => {
    const status = [{ criterion: "colors captured", met: true }];
    expect(alignCriteriaMet(pinned, status)).toEqual([false, true, false]);
    expect(alignCriteriaMet(pinned, status, undefined)).toEqual([false, true, false]);
  });

  it("alignCriteriaMet: an empty prior array (nothing pinned was ever graded) behaves like no prior", () => {
    const status = [{ criterion: "colors captured", met: true }];
    expect(alignCriteriaMet(pinned, status, [])).toEqual([false, true, false]);
  });

  it("alignCriteriaDeferred: carries a prior deferred flag forward when the criterion is omitted", () => {
    const status = [{ criterion: "colors captured", deferred: false }];
    const priorDeferred = [true, true, false];
    expect(alignCriteriaDeferred(pinned, status, priorDeferred)).toEqual([
      true, // omitted -> carried
      false, // matched this round -> fresh verdict wins
      false, // omitted -> carried
    ]);
  });

  it("alignCriteriaEvidence: carries prior evidence text forward when the criterion is omitted", () => {
    const status = [{ criterion: "colors captured", evidence: "round2: confirmed under test" }];
    const priorEvidence = ["round1: verified visually", "round1: not yet argued", ""];
    expect(alignCriteriaEvidence(pinned, status, priorEvidence)).toEqual([
      "round1: verified visually", // omitted -> carried
      "round2: confirmed under test", // matched this round -> fresh evidence wins
      "", // omitted, nothing to carry (prior was already empty)
    ]);
  });

  it("alignCriteriaEvidence: round 1 (no prior) still defaults an unmatched criterion to empty evidence", () => {
    const status = [{ criterion: "colors captured", evidence: "round1: confirmed" }];
    expect(alignCriteriaEvidence(pinned, status)).toEqual(["", "round1: confirmed", ""]);
  });
});
