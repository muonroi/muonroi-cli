import { describe, expect, it } from "vitest";
import { dark } from "../../theme.js";
import {
  collectDissent,
  markColor,
  markGlyph,
  roleAbbrev,
  stanceVerdictLabel,
  tallyStance,
  visibleColumnCount,
} from "../council-stance-matrix.js";

const ROSTER = ["architect", "skeptic", "research"];

describe("markGlyph", () => {
  it("renders each stance as its own glyph", () => {
    expect(markGlyph("+")).toBe("+");
    expect(markGlyph("-")).toBe("-");
    expect(markGlyph("~")).toBe("~");
  });

  // The single rule this component must never break.
  it("renders an unknown stance as '·', never as a mark", () => {
    expect(markGlyph(null)).toBe("·");
  });
});

describe("markColor", () => {
  it("colors supports, opposes and conditional distinctly", () => {
    const colors = new Set([markColor("+", dark), markColor("-", dark), markColor("~", dark)]);
    expect(colors.size).toBe(3);
  });

  it("renders a silent cell muted, not as an opposing red", () => {
    expect(markColor(null, dark)).toBe(dark.textMuted);
    expect(markColor(null, dark)).not.toBe(markColor("-", dark));
  });
});

describe("roleAbbrev", () => {
  it("takes the first three letters, lowercased", () => {
    expect(roleAbbrev("architect")).toBe("arc");
    expect(roleAbbrev("Skeptic")).toBe("ske");
  });

  it("strips punctuation so the column stays 3 cols wide", () => {
    expect(roleAbbrev("re-search")).toBe("res");
  });

  it("survives a short or odd role name", () => {
    expect(roleAbbrev("qa")).toBe("qa");
    expect(roleAbbrev("")).toBe("");
  });
});

describe("visibleColumnCount", () => {
  it("fits the whole roster when there is room", () => {
    expect(visibleColumnCount(122, 5, false)).toBe(5);
  });

  // The design's stated constraint: 8 panelists must still fit in 80 cols.
  it("fits 8 panelists in 80 cols using the narrow layout", () => {
    expect(visibleColumnCount(80, 8, true)).toBe(8);
  });

  it("pages instead of shrinking when the roster overflows", () => {
    expect(visibleColumnCount(60, 12, false)).toBeLessThan(12);
  });

  it("never returns zero columns at a pathological width", () => {
    expect(visibleColumnCount(10, 5, true)).toBeGreaterThanOrEqual(1);
  });
});

describe("tallyStance / stanceVerdictLabel", () => {
  const row = (stances: Record<string, "+" | "-" | "~" | null>, met = false) => ({
    criterion: "c",
    met,
    stances,
  });

  it("counts silence separately from opposition", () => {
    const t = tallyStance(row({ architect: "+", skeptic: null, research: null }), ROSTER);
    expect(t).toMatchObject({ supports: 1, opposes: 0, silent: 2, contested: false });
  });

  it("labels an ungraded row 'not argued', not 'agreed'", () => {
    expect(stanceVerdictLabel(row({ architect: null, skeptic: null, research: null }), ROSTER)).toBe("· not argued");
  });

  it("labels a real split with the vote counts", () => {
    expect(stanceVerdictLabel(row({ architect: "+", skeptic: "-", research: "+" }), ROSTER)).toBe("◐ 2 vs 1");
  });

  it("labels a met, uncontested row as agreed", () => {
    expect(stanceVerdictLabel(row({ architect: "+", skeptic: "+", research: null }, true), ROSTER)).toBe("✓ agreed");
  });
});

describe("collectDissent", () => {
  it("returns one entry per opposing role, carrying the split reason", () => {
    const rows = [
      { criterion: "latency", met: true, stances: { architect: "+", skeptic: "+", research: null } },
      {
        criterion: "rollout cost",
        met: false,
        stances: { architect: "+", skeptic: "-", research: "-" },
        split: "3 teams",
      },
    ] as Parameters<typeof collectDissent>[0];
    const d = collectDissent(rows, ROSTER);
    expect(d).toEqual([
      { role: "skeptic", criterion: "rollout cost", split: "3 teams" },
      { role: "research", criterion: "rollout cost", split: "3 teams" },
    ]);
  });

  it("reports a role once even when it opposes several criteria", () => {
    const rows = [
      { criterion: "a", met: false, stances: { architect: null, skeptic: "-", research: null } },
      { criterion: "b", met: false, stances: { architect: null, skeptic: "-", research: null } },
    ] as Parameters<typeof collectDissent>[0];
    expect(collectDissent(rows, ROSTER)).toHaveLength(1);
  });

  it("is empty when nobody opposes", () => {
    const rows = [
      { criterion: "a", met: true, stances: { architect: "+", skeptic: "~", research: null } },
    ] as Parameters<typeof collectDissent>[0];
    expect(collectDissent(rows, ROSTER)).toEqual([]);
  });
});
