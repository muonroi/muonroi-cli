import { describe, expect, it } from "vitest";
import type { CouncilStanceRow } from "../../types/index.js";
import { formatDuration, formatRunReceipt, pickLoudestDissent, totalLedgerUsd } from "../run-receipt.js";

const ROSTER = ["architect", "skeptic", "research"];
const row = (criterion: string, met: boolean, stances: CouncilStanceRow["stances"], split?: string): CouncilStanceRow =>
  ({ criterion, met, stances, ...(split ? { split } : {}) }) as CouncilStanceRow;

describe("formatRunReceipt", () => {
  it("reports the full run", () => {
    expect(
      formatRunReceipt({
        rounds: 2,
        turns: 14,
        criteriaMet: 3,
        criteriaTotal: 4,
        ledger: [
          { role: "architect", turns: 3, usd: 0.12 },
          { role: "skeptic", turns: 3, usd: 0.07 },
        ],
        elapsedMs: 252_000,
      }),
    ).toBe("2 rounds · 14 turns · 3/4 criteria met · $0.19 · 4m12s");
  });

  // "$0.00" reads as free when it usually means no model in the run had catalog
  // pricing; "0/0 criteria met" reads as total failure when it means none were
  // pinned. Both segments are dropped instead.
  it("omits spend and criteria when there is nothing measured behind them", () => {
    expect(formatRunReceipt({ rounds: 1, turns: 2, criteriaTotal: 0, ledger: [] })).toBe("1 round · 2 turns");
  });

  it("reports sub-cent spend as <$0.01 rather than rounding it to free", () => {
    expect(formatRunReceipt({ rounds: 1, turns: 1, ledger: [{ role: "a", turns: 1, usd: 0.004 }] })).toContain(
      "<$0.01",
    );
  });

  it("singularises a one-round, one-turn run", () => {
    expect(formatRunReceipt({ rounds: 1, turns: 1 })).toBe("1 round · 1 turn");
  });

  it("is empty when the debate produced nothing", () => {
    expect(formatRunReceipt({ rounds: 0, turns: 0 })).toBe("");
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatDuration(48_000)).toBe("48s");
    expect(formatDuration(252_000)).toBe("4m12s");
    expect(formatDuration(0)).toBe("");
  });
});

describe("totalLedgerUsd", () => {
  it("ignores a non-finite entry rather than producing NaN", () => {
    expect(
      totalLedgerUsd([
        { role: "a", turns: 1, usd: 0.1 },
        { role: "b", turns: 1, usd: Number.NaN },
      ]),
    ).toBeCloseTo(0.1);
  });
});

describe("pickLoudestDissent", () => {
  it("picks the criterion with the most opposition", () => {
    const d = pickLoudestDissent(
      [
        row("contract", false, { architect: "+", skeptic: "-" }),
        row("rollout", false, { architect: "+", skeptic: "-", research: "-" }),
      ],
      ROSTER,
    );
    expect(d?.criterion).toBe("rollout");
    expect(d?.role).toBe("skeptic");
  });

  it("prefers a row that recorded WHY the panel split", () => {
    const d = pickLoudestDissent(
      [
        row("contract", false, { skeptic: "-" }),
        row("rollout", false, { research: "-" }, "descriptor publishing adds a release order"),
      ],
      ROSTER,
    );
    expect(d?.criterion).toBe("rollout");
    expect(d?.split).toBe("descriptor publishing adds a release order");
  });

  it("ignores criteria the panel actually met", () => {
    expect(pickLoudestDissent([row("contract", true, { skeptic: "-" })], ROSTER)).toBeNull();
  });

  // Never manufacture an objection for the card to offer.
  it("returns null when nobody opposed", () => {
    expect(pickLoudestDissent([row("c", false, { architect: "+", skeptic: null })], ROSTER)).toBeNull();
    expect(pickLoudestDissent([], ROSTER)).toBeNull();
    expect(pickLoudestDissent(undefined, ROSTER)).toBeNull();
  });
});
