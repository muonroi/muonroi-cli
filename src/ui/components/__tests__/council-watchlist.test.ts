import { describe, expect, it } from "vitest";
import type { CouncilStanceRow } from "../../../types/index.js";
import { buildWatchlist, type WatchlistState, watchlistStateFrom } from "../council-watchlist.js";

const ROSTER = ["architect", "skeptic", "research"];

const row = (criterion: string, met: boolean, stances: CouncilStanceRow["stances"], split?: string): CouncilStanceRow =>
  ({ criterion, met, stances, ...(split ? { split } : {}) }) as CouncilStanceRow;

const state = (patch: Partial<WatchlistState> = {}): WatchlistState => ({
  met: [],
  split: [],
  usd: 0,
  turns: 0,
  ...patch,
});

describe("watchlistStateFrom", () => {
  it("classifies met, split, and merely-unargued criteria", () => {
    const s = watchlistStateFrom(
      [
        row("latency", true, { architect: "+" }),
        row("contract", false, { architect: "+", skeptic: "-" }),
        row("rollout", false, { architect: null, skeptic: null, research: null }),
      ],
      ROSTER,
      0.19,
      7,
    );
    expect(s.met).toEqual(["latency"]);
    // An unargued criterion is NOT a split — the two call for opposite actions.
    expect(s.split).toEqual(["contract"]);
    expect(s.usd).toBe(0.19);
    expect(s.turns).toBe(7);
  });

  it("does not count a one-sided criterion as split", () => {
    const s = watchlistStateFrom([row("c", false, { architect: "+", skeptic: "+" })], ROSTER, 0, 0);
    expect(s.split).toEqual([]);
  });
});

describe("buildWatchlist", () => {
  it("reports a criterion that flipped to met", () => {
    const out = buildWatchlist(state(), state({ met: ["rollout cost"] }));
    expect(out).toContainEqual({ kind: "met", text: "rollout cost now met" });
  });

  // Silently dropping a regression would let the band claim progress a later
  // round took back — the failure that would make it untrustworthy.
  it("reports a criterion that went back to unmet", () => {
    const out = buildWatchlist(state({ met: ["rollout cost"] }), state());
    expect(out).toContainEqual({ kind: "unmet", text: "rollout cost reopened" });
  });

  it("carries the split reason on a new split", () => {
    const out = buildWatchlist(state(), state({ split: ["contract"] }), { contract: "descriptor set" });
    expect(out).toContainEqual({ kind: "split", text: "new split on contract", detail: "descriptor set" });
  });

  // A split that closed without the criterion being met means the objection was
  // dropped, not answered — worth surfacing separately from a "now met".
  it("distinguishes a closed split from a met criterion", () => {
    const out = buildWatchlist(state({ split: ["contract"] }), state());
    expect(out).toContainEqual({ kind: "resolved", text: "split on contract closed" });
    const alsoMet = buildWatchlist(state({ split: ["contract"] }), state({ met: ["contract"] }));
    expect(alsoMet.some((e) => e.kind === "resolved")).toBe(false);
    expect(alsoMet).toContainEqual({ kind: "met", text: "contract now met" });
  });

  it("reports turn and spend deltas", () => {
    const out = buildWatchlist(state({ usd: 0.11, turns: 4 }), state({ usd: 0.19, turns: 6 }));
    expect(out).toContainEqual({ kind: "turns", text: "2 turns since" });
    expect(out).toContainEqual({ kind: "spend", text: "$0.11 → $0.19" });
  });

  // Nothing changed → no band at all, rather than an empty header taking rail
  // space away from the scoreboard.
  it("returns nothing when the two snapshots match", () => {
    const s = state({ met: ["a"], split: ["b"], usd: 0.2, turns: 3 });
    expect(buildWatchlist(s, s)).toEqual([]);
  });

  it("does not report a spend decrease", () => {
    expect(buildWatchlist(state({ usd: 0.3 }), state({ usd: 0.2 }))).toEqual([]);
  });
});
