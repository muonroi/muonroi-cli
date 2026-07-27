import { describe, expect, it } from "vitest";
import type { CouncilRoundRecord } from "../../../types/index.js";
import { buildRoundReceipt, consensusBar } from "../council-round-group.js";

const ROSTER = ["architect", "skeptic", "research"];

const rec = (patch: Partial<CouncilRoundRecord>): CouncilRoundRecord => ({
  round: 2,
  state: "done",
  participants: ROSTER,
  pairCount: 2,
  emergent: false,
  ...patch,
});

describe("buildRoundReceipt", () => {
  // Without a stance snapshot the receipt would be an empty but
  // authoritative-looking block; the caller needs null to fall back.
  it("returns null when the round carries no stance snapshot", () => {
    expect(buildRoundReceipt(rec({}), ROSTER)).toBeNull();
    expect(buildRoundReceipt(rec({ stanceRows: [] }), ROSTER)).toBeNull();
  });

  it("counts only criteria that flipped THIS round as locked", () => {
    const r = buildRoundReceipt(
      rec({
        prevCriteriaMet: [true, false],
        stanceRows: [
          { criterion: "latency", met: true, stances: { architect: "+", skeptic: "+", research: "+" } },
          { criterion: "observability", met: true, stances: { architect: "+", skeptic: "+", research: null } },
        ],
      }),
      ROSTER,
    );
    // latency was already met going in — it is not this round's contribution.
    expect(r!.locked.map((l) => l.criterion)).toEqual(["observability"]);
  });

  // 4/5 must not read as "one panelist opposed" when it was an abstention.
  it("names abstainers on a locked criterion instead of implying opposition", () => {
    const r = buildRoundReceipt(
      rec({
        stanceRows: [
          { criterion: "observability", met: true, stances: { architect: "+", skeptic: "+", research: null } },
        ],
      }),
      ROSTER,
    );
    expect(r!.locked[0]).toMatchObject({ agree: 2, of: 3, silent: ["research"] });
  });

  it("separates a contested criterion from one that was never argued", () => {
    const r = buildRoundReceipt(
      rec({
        stanceRows: [
          {
            criterion: "contract",
            met: false,
            stances: { architect: "+", skeptic: "-", research: null },
            split: "descriptor",
          },
          { criterion: "rollout", met: false, stances: { architect: null, skeptic: null, research: null } },
        ],
      }),
      ROSTER,
    );
    expect(r!.open[0]).toMatchObject({
      criterion: "contract",
      argued: true,
      supports: 1,
      opposes: 1,
      split: "descriptor",
    });
    expect(r!.open[0]!.minority).toEqual(["skeptic"]);
    expect(r!.open[1]).toMatchObject({ criterion: "rollout", argued: false, supports: 0, opposes: 0 });
  });

  it("reports the consensus delta from the previous round's met-set", () => {
    const r = buildRoundReceipt(
      rec({
        prevCriteriaMet: [true, false, false],
        stanceRows: [
          { criterion: "a", met: true, stances: {} },
          { criterion: "b", met: true, stances: {} },
          { criterion: "c", met: false, stances: {} },
        ],
      }),
      ROSTER,
    );
    expect(r).toMatchObject({ before: 1, after: 2, total: 3 });
  });

  // The signal to stop paying for more rounds.
  it("shows a zero delta for a round that moved nothing", () => {
    const r = buildRoundReceipt(
      rec({
        prevCriteriaMet: [true, false],
        stanceRows: [
          { criterion: "a", met: true, stances: {} },
          { criterion: "b", met: false, stances: {} },
        ],
      }),
      ROSTER,
    );
    expect(r!.before).toBe(r!.after);
    expect(r!.locked).toEqual([]);
  });

  it("treats a missing prevCriteriaMet as 'nothing was met going in'", () => {
    const r = buildRoundReceipt(
      rec({ stanceRows: [{ criterion: "a", met: true, stances: { architect: "+" } }] }),
      ROSTER,
    );
    expect(r!.before).toBe(0);
    expect(r!.locked).toHaveLength(1);
  });

  it("counts a conditional '~' as support, not as opposition", () => {
    const r = buildRoundReceipt(
      rec({ stanceRows: [{ criterion: "a", met: false, stances: { architect: "~", skeptic: "~", research: null } }] }),
      ROSTER,
    );
    expect(r!.open[0]).toMatchObject({ supports: 2, opposes: 0 });
    expect(r!.open[0]!.minority).toEqual([]);
  });
});

describe("consensusBar", () => {
  it("fills proportionally", () => {
    expect(consensusBar(2, 4)).toBe("▓▓░░");
    expect(consensusBar(4, 4)).toBe("▓▓▓▓");
    expect(consensusBar(0, 4)).toBe("░░░░");
  });

  it("returns an empty bar when there are no criteria", () => {
    expect(consensusBar(0, 0)).toBe("");
  });

  it("never overflows the requested width", () => {
    expect(consensusBar(9, 3, 4)).toHaveLength(4);
  });
});
