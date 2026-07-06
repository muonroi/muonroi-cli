import { describe, expect, it } from "vitest";
import {
  autoRemedyWantsExtend,
  buildLeaderDirective,
  buildLeaderVerdict,
  diagnoseUnmetRemedy,
  leaderAutoRemedyEnabled,
  leaderConductorEnabled,
  shortCriterion,
} from "../debate.js";

describe("leaderConductorEnabled (B5 flag)", () => {
  it("defaults ON when the env var is unset", () => {
    const prev = process.env.MUONROI_LEADER_CONDUCTOR;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    expect(leaderConductorEnabled()).toBe(true);
    if (prev !== undefined) process.env.MUONROI_LEADER_CONDUCTOR = prev;
  });

  it("opts out only on exactly '0'", () => {
    const prev = process.env.MUONROI_LEADER_CONDUCTOR;
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    expect(leaderConductorEnabled()).toBe(false);
    process.env.MUONROI_LEADER_CONDUCTOR = "1";
    expect(leaderConductorEnabled()).toBe(true);
    if (prev === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
    else process.env.MUONROI_LEADER_CONDUCTOR = prev;
  });
});

describe("shortCriterion", () => {
  it("collapses whitespace and passes short text through", () => {
    expect(shortCriterion("  no   unhandled  crash ")).toBe("no unhandled crash");
  });

  it("truncates with an ellipsis at the limit", () => {
    expect(shortCriterion("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("buildLeaderDirective (B5 pre-round steering)", () => {
  const criteria = ["No crash on fatal error", "Clear diagnostic message", "Terminal restored"];

  it("round 1 with no prior status treats everything as unmet", () => {
    const out = buildLeaderDirective(1, criteria, []);
    expect(out).toContain("Establish concrete evidence");
    expect(out).toContain("Unmet (3/3):");
  });

  it("lists only the still-unmet criteria on later rounds and uses the carried focus", () => {
    const out = buildLeaderDirective(2, criteria, [true, false, false], "Prove the diagnostic path");
    expect(out).toContain("Focus: Prove the diagnostic path");
    expect(out).toContain("Unmet (2/3):");
    expect(out).not.toContain("No crash on fatal error"); // already met
  });

  it("switches to pressure-test wording when all criteria are met", () => {
    const out = buildLeaderDirective(3, criteria, [true, true, true]);
    expect(out).toContain("All criteria met so far");
  });
});

describe("buildLeaderVerdict (B5 post-round grading)", () => {
  const criteria = ["No crash on fatal error", "Clear diagnostic message"];

  it("renders per-criterion marks and the next focus while unmet remain", () => {
    const out = buildLeaderVerdict(criteria, [true, false], "one gap left", "Cover the rejection path");
    expect(out).toContain("1/2 criteria met — one gap left");
    expect(out).toContain("✓ No crash on fatal error");
    expect(out).toContain("○ Clear diagnostic message");
    expect(out).toContain("→ Next: Cover the rejection path");
  });

  it("drops the next-focus line once all criteria are met", () => {
    const out = buildLeaderVerdict(criteria, [true, true], "done", "irrelevant");
    expect(out).toContain("2/2 criteria met");
    expect(out).not.toContain("→ Next:");
  });
});

describe("leaderAutoRemedyEnabled (B4 flag)", () => {
  it("defaults ON when both env vars are unset", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevR = process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    delete process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    expect(leaderAutoRemedyEnabled()).toBe(true);
    if (prevC !== undefined) process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevR !== undefined) process.env.MUONROI_COUNCIL_AUTO_REMEDY = prevR;
  });

  it("is off when the conductor is off (auto-remedy is a conductor sub-feature)", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevR = process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    delete process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    expect(leaderAutoRemedyEnabled()).toBe(false);
    if (prevC === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
    else process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevR !== undefined) process.env.MUONROI_COUNCIL_AUTO_REMEDY = prevR;
  });

  it("opts out on exactly '0' with the conductor on", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevR = process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    process.env.MUONROI_LEADER_CONDUCTOR = "1";
    process.env.MUONROI_COUNCIL_AUTO_REMEDY = "0";
    expect(leaderAutoRemedyEnabled()).toBe(false);
    if (prevC === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
    else process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevR === undefined) delete process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    else process.env.MUONROI_COUNCIL_AUTO_REMEDY = prevR;
  });
});

describe("autoRemedyWantsExtend (B4 trigger)", () => {
  it("extends while criteria are unmet and progress is recent", () => {
    expect(autoRemedyWantsExtend(2, 0)).toBe(true);
    expect(autoRemedyWantsExtend(1, 1)).toBe(true);
  });

  it("does not extend once everything is met", () => {
    expect(autoRemedyWantsExtend(0, 0)).toBe(false);
  });

  it("stops burning the ceiling on a stuck criterion (no progress for 2 rounds)", () => {
    expect(autoRemedyWantsExtend(3, 2)).toBe(false);
    expect(autoRemedyWantsExtend(3, 5)).toBe(false);
  });
});

describe("diagnoseUnmetRemedy (B4 closing escalation)", () => {
  it("flags a stuck criterion as needing evidence / rescope, not more debate", () => {
    const out = diagnoseUnmetRemedy({ stuck: true, atCeiling: true, effectiveCeiling: 5, roundsSinceProgress: 3 });
    expect(out).toContain("made no progress across the last 3 rounds");
    expect(out).toContain("external evidence");
  });

  it("prioritises the stuck diagnosis over the ceiling one", () => {
    const stuckAndCeiling = diagnoseUnmetRemedy({
      stuck: true,
      atCeiling: true,
      effectiveCeiling: 3,
      roundsSinceProgress: 2,
    });
    expect(stuckAndCeiling).toContain("made no progress");
    expect(stuckAndCeiling).not.toContain("ceiling");
  });

  it("tells the user to raise the budget when the ceiling was the blocker", () => {
    const out = diagnoseUnmetRemedy({ stuck: false, atCeiling: true, effectiveCeiling: 3, roundsSinceProgress: 1 });
    expect(out).toContain("hit its 3-round ceiling");
    expect(out).toContain("higher round budget");
  });

  it("falls back to a generic remedy for an ordinary early stop", () => {
    const out = diagnoseUnmetRemedy({ stuck: false, atCeiling: false, effectiveCeiling: 5, roundsSinceProgress: 0 });
    expect(out).toContain("extended round budget");
    expect(out).not.toContain("ceiling");
    expect(out).not.toContain("no progress");
  });
});
