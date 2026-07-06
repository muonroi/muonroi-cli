import { describe, expect, it } from "vitest";
import { buildLeaderDirective, buildLeaderVerdict, leaderConductorEnabled, shortCriterion } from "../debate.js";

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
