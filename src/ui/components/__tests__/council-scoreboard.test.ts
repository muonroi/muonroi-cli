import { describe, expect, it } from "vitest";
import type { CouncilStanceMark, CouncilStanceRow } from "../../../types/index.js";
import { criterionMark, fitLabel, formatLedgerUsd, pendingSpeakers, stanceSides } from "../council-scoreboard.js";

const ROSTER = ["architect", "skeptic", "research"];

const row = (stances: Record<string, CouncilStanceMark>, met = false): CouncilStanceRow => ({
  criterion: "c",
  met,
  stances,
});

describe("criterionMark", () => {
  it("marks a met criterion done", () => {
    expect(criterionMark(row({ architect: "+" }, true), ROSTER)).toBe("✓");
  });

  // The distinction the old rail lost: both used to render as a bare ○.
  it("distinguishes 'argued but unresolved' from 'never argued'", () => {
    expect(criterionMark(row({ architect: "+", skeptic: "-", research: null }), ROSTER)).toBe("◐");
    expect(criterionMark(row({ architect: null, skeptic: null, research: null }), ROSTER)).toBe("○");
  });

  it("treats a role missing from the map as silent", () => {
    expect(criterionMark(row({}), ROSTER)).toBe("○");
  });
});

describe("stanceSides", () => {
  it("puts supports and conditionals on the left, opposes on the right", () => {
    const sides = stanceSides(row({ architect: "+", skeptic: "-", research: "~" }), ROSTER);
    expect(sides).toEqual({ supporting: ["architect", "research"], opposing: ["skeptic"] });
  });

  // A silent panelist drawn on either side would read as taking that side.
  it("omits panelists who have not spoken from both sides", () => {
    const sides = stanceSides(row({ architect: "+", skeptic: null, research: null }), ROSTER);
    expect(sides).toEqual({ supporting: ["architect"], opposing: [] });
  });

  it("preserves roster order so a panelist keeps its position", () => {
    const sides = stanceSides(row({ research: "+", architect: "+", skeptic: "+" }), ROSTER);
    expect(sides.supporting).toEqual(["architect", "skeptic", "research"]);
  });
});

describe("formatLedgerUsd", () => {
  it("drops the leading zero to fit a 6-col rail column", () => {
    expect(formatLedgerUsd(0.072)).toBe(".072");
    expect(formatLedgerUsd(0.0495)).toBe(".050");
  });

  // A cheap panelist must not be mistaken for a free one.
  it("floors sub-tenth-of-a-cent spend to <.001 rather than .000", () => {
    expect(formatLedgerUsd(0.0004)).toBe("<.001");
  });

  it("renders no-spend-yet as an em dash, not $0", () => {
    expect(formatLedgerUsd(0)).toBe("—");
    expect(formatLedgerUsd(Number.NaN)).toBe("—");
    expect(formatLedgerUsd(-1)).toBe("—");
  });

  it("keeps a large figure inside the column", () => {
    expect(formatLedgerUsd(12.4)).toBe("12");
  });
});

describe("fitLabel", () => {
  it("passes a short label through untouched", () => {
    expect(fitLabel("  latency  ", 20)).toBe("latency");
  });

  it("ellipsizes to exactly the budget", () => {
    const out = fitLabel("public contract stability", 10);
    expect(out).toBe("public co…");
    expect(out).toHaveLength(10);
  });

  it("degrades safely at a pathological budget", () => {
    expect(fitLabel("latency", 1)).toBe("l");
    expect(fitLabel("latency", 0)).toBe("");
  });
});

describe("pendingSpeakers", () => {
  it("returns the roster members who have not spoken this round, in order", () => {
    expect(pendingSpeakers(ROSTER, ["skeptic"])).toEqual(["architect", "research"]);
  });

  it("is empty once everyone has spoken", () => {
    expect(pendingSpeakers(ROSTER, [...ROSTER])).toEqual([]);
  });

  it("ignores a spoken role that is not on the roster", () => {
    expect(pendingSpeakers(ROSTER, ["ghost"])).toEqual(ROSTER);
  });
});
