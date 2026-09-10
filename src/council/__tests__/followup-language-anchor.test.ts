/**
 * Council defect (c) — language drift at round 2.
 *
 * Measured in run mttwpmu8ee5b: rounds 0 and 1 were Vietnamese for all four
 * speakers; in round 2 the Skeptic switched to English while the other three
 * stayed Vietnamese.
 *
 * Rounds 0 and 1 are built by `buildOpeningPrompt` / `buildResponsePrompt`,
 * which BOTH embed `## Discussion Brief\nProblem: <spec.problemStatement>` —
 * the user's own words, in the user's own language. Round 2+ is built by
 * `buildFollowupPrompt`, which embedded no brief at all, while the "auto"
 * language rule told the speaker to match "the Discussion Brief / topic below".
 * With nothing below to match, the only text left in the turn is the running
 * summary, the leader directive and the partner's message — so the rule had no
 * anchor and a speaker could silently land in English.
 */
import { describe, expect, it } from "vitest";
import { buildFollowupPrompt, buildLanguageRule, buildResponsePrompt } from "../prompts.js";
import type { ClarifiedSpec } from "../types.js";

const spec: ClarifiedSpec = {
  problemStatement: "Chuẩn hoá thư viện TCIS và đóng gói NuGet cho toàn hệ sinh thái",
  constraints: [],
  successCriteria: ["Đóng gói NuGet có phiên bản rõ ràng"],
  scope: "implementation",
  rawQA: [],
} as unknown as ClarifiedSpec;

const followup = (round: number) =>
  buildFollowupPrompt({
    speakerRole: "skeptic",
    partnerRole: "architect",
    partnerPosition: "Their latest.",
    speakerLastPosition: "Mine.",
    round,
    runningSummary: "AGREED: ship rule 2 first.",
    spec,
    language: "auto",
  });

describe("buildFollowupPrompt keeps the language anchor rounds 0-1 had", () => {
  it("embeds the problem statement, like buildResponsePrompt does", () => {
    const r1 = buildResponsePrompt({
      speakerRole: "skeptic",
      partnerRole: "architect",
      speakerPosition: "a",
      partnerPosition: "b",
      spec,
      language: "auto",
    });
    expect(r1.system).toContain(spec.problemStatement);
    // Round 2+ must carry the same anchor — this is the drift.
    expect(followup(2).system).toContain(spec.problemStatement);
  });

  it("still emits a byte-identical system prefix across rounds (cache stability)", () => {
    expect(followup(2).system).toBe(followup(5).system);
  });
});

describe("buildLanguageRule('auto') does not depend on a section that may be absent", () => {
  it("binds to the problem statement rather than a 'below' section", () => {
    const rule = buildLanguageRule("auto");
    expect(rule).toContain("SAME language the user used");
    expect(rule).not.toContain("Discussion Brief / topic below");
  });

  it("forbids switching language between rounds", () => {
    for (const lang of ["auto", "vietnamese"]) {
      expect(buildLanguageRule(lang)).toContain("Never switch language between rounds");
    }
  });

  it("leaves the English branch byte-identical (machine-stability guarantee)", () => {
    expect(buildLanguageRule(undefined)).toBe(buildLanguageRule("english"));
    expect(buildLanguageRule("english")).not.toContain("Never switch language between rounds");
  });
});
