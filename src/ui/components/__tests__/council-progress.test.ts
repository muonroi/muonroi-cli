import { describe, expect, it } from "vitest";
import { leaderPendingRow } from "../council-round-group.js";
import { formatRoundHeader, turnsBar } from "../council-scoreboard.js";
import { formatCouncilElapsed } from "../council-tick.js";

describe("formatRoundHeader", () => {
  it("reads position against the planned budget", () => {
    expect(formatRoundHeader({ round: 2, budget: 3 })).toBe("Round 2/3");
  });

  it("omits the denominator when no budget is known", () => {
    expect(formatRoundHeader({ round: 2 })).toBe("Round 2");
  });

  // The case that made the naive version lie: a run past its plan would print
  // "Round 4/3", or clamp to "3/3" and claim it was finished.
  it("measures an emergent round against the ceiling and labels it", () => {
    expect(formatRoundHeader({ round: 4, budget: 3, ceiling: 5, emergent: true })).toBe("Round 4/5 ext");
  });

  it("treats round > budget as emergent even without the flag", () => {
    expect(formatRoundHeader({ round: 4, budget: 3, ceiling: 5 })).toBe("Round 4/5 ext");
  });

  // Better to say "4/4 ext" than to print a ceiling the run has already passed.
  it("falls back to the current round when the ceiling is stale or missing", () => {
    expect(formatRoundHeader({ round: 4, budget: 3, emergent: true })).toBe("Round 4/4 ext");
    expect(formatRoundHeader({ round: 6, budget: 3, ceiling: 5, emergent: true })).toBe("Round 6/6 ext");
  });

  it("renders nothing without a real round number", () => {
    expect(formatRoundHeader({ round: 0, budget: 3 })).toBe("");
  });
});

describe("turnsBar", () => {
  it("fills proportionally", () => {
    expect(turnsBar(0, 10, 10)).toBe("░░░░░░░░░░");
    expect(turnsBar(5, 10, 10)).toBe("▓▓▓▓▓░░░░░");
    expect(turnsBar(10, 10, 10)).toBe("▓▓▓▓▓▓▓▓▓▓");
  });

  // An invented denominator would put a wrong finish line in front of the user.
  it("renders nothing when the denominator is unknown", () => {
    expect(turnsBar(3, 0, 10)).toBe("");
  });

  it("clamps an over-count instead of overflowing the bar", () => {
    expect(turnsBar(14, 10, 10)).toBe("▓▓▓▓▓▓▓▓▓▓");
  });
});

describe("formatCouncilElapsed", () => {
  it("renders seconds under a minute and m/s above", () => {
    expect(formatCouncilElapsed(38_000)).toBe("38s");
    expect(formatCouncilElapsed(252_000)).toBe("4m12s");
  });

  it("renders nothing for missing or negative input", () => {
    expect(formatCouncilElapsed(undefined)).toBe("");
    expect(formatCouncilElapsed(-1)).toBe("");
  });
});

describe("leaderPendingRow", () => {
  it("counts the turns still outstanding, not the ones done", () => {
    const r = leaderPendingRow({ turnsDone: 3, turnsExpected: 5, criteriaTotal: 4 });
    expect(r?.headline).toBe("Leader · waiting on 2 of 5 turns");
    expect(r?.sub).toBe("Will grade 4 criteria, then decide: continue · extend · stop");
  });

  // Same silence, different reason — the panel is done and the leader is the
  // thing being waited on.
  it("switches to grading once every turn has landed", () => {
    expect(leaderPendingRow({ turnsDone: 5, turnsExpected: 5 })?.headline).toBe("Leader · grading the round now");
  });

  it("drops the criteria count when none are pinned", () => {
    expect(leaderPendingRow({ turnsDone: 1, turnsExpected: 4 })?.sub).toBe(
      "Will grade the round, then decide: continue · extend · stop",
    );
  });

  // An older round record carries no denominator; render nothing rather than
  // "waiting on NaN of 0 turns".
  it("returns null without a turn denominator", () => {
    expect(leaderPendingRow({ turnsDone: 2 })).toBeNull();
    expect(leaderPendingRow({ turnsDone: 2, turnsExpected: 0 })).toBeNull();
  });
});
