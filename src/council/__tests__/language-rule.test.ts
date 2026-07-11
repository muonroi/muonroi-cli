import { describe, expect, it } from "vitest";
import {
  buildLanguageRule,
  buildOpeningPrompt,
  buildResponsePrompt,
  buildRoundSummaryPrompt,
  buildSynthesisLanguageRule,
  buildSynthesisPrompt,
} from "../prompts.js";
import type { ClarifiedSpec } from "../types.js";

// Feature B — the chosen council language IS the debate language (no translate
// pass). buildLanguageRule selects the per-turn rule; the "english"/undefined
// branch must stay byte-identical so existing prompt-string tests and the
// machine-stability guarantee are unaffected.

const spec: ClarifiedSpec = {
  problemStatement: "Đánh giá cơ chế harness của muonroi-cli",
  constraints: [],
  successCriteria: ["Harness rõ ràng"],
  scope: "analysis",
  rawQA: [],
};

describe("debate scope discipline (F10 — no plan/file dumps in turns)", () => {
  it("opening + response prompts forbid file contents and implementation plans", () => {
    for (const built of [
      buildOpeningPrompt({ speakerRole: "research", partnerRole: "architect", spec }),
      buildResponsePrompt({
        speakerRole: "research",
        partnerRole: "architect",
        speakerPosition: "p",
        partnerPosition: "q",
        spec,
      }),
    ]) {
      const s = built.system.toLowerCase();
      expect(s).toContain("debate about direction");
      expect(s).toContain("implementation");
      expect(s).toContain("file content");
      expect(s).toContain("synthesis owns the plan");
    }
  });
});

describe("buildLanguageRule", () => {
  it("returns the historical English-only rule for undefined and 'english'", () => {
    const def = buildLanguageRule(undefined);
    const eng = buildLanguageRule("english");
    expect(def).toBe(eng);
    expect(def).toContain("Write your ENTIRE response in English");
    // No non-English token carve-out leaked into the English branch.
    expect(def).not.toContain("Only your prose/analysis text switches language");
  });

  it("'auto' instructs matching the brief's language and keeps tokens English", () => {
    const rule = buildLanguageRule("auto");
    expect(rule).toContain("SAME language the user used");
    expect(rule).toContain("citation tags");
    expect(rule).toContain("`type` field");
    // Must NOT force English prose.
    expect(rule).not.toContain("Write your ENTIRE response in English");
  });

  it("a pinned locale forces that language for prose", () => {
    const rule = buildLanguageRule("vietnamese");
    expect(rule).toContain("Write your ENTIRE response in vietnamese");
    expect(rule).toContain("Only your prose/analysis text switches language");
  });
});

describe("buildSynthesisLanguageRule", () => {
  it("undefined/'english' keep the English-forced-debate preamble + detect-from-brief", () => {
    const def = buildSynthesisLanguageRule(undefined);
    expect(def).toBe(buildSynthesisLanguageRule("english"));
    expect(def).toContain("The debate above is entirely in English");
    expect(def).toContain("Detect the user's language from the Problem Statement");
  });

  it("'auto' drops the false English-debate claim but still detects from the brief", () => {
    const rule = buildSynthesisLanguageRule("auto");
    expect(rule).not.toContain("entirely in English");
    expect(rule).toContain("Detect the user's language from the Problem Statement");
  });

  it("a pinned locale forces all prose into that language", () => {
    const rule = buildSynthesisLanguageRule("japanese");
    expect(rule).toContain("Write ALL prose");
    expect(rule).toContain("japanese");
    expect(rule).not.toContain("Detect the user's language from the Problem Statement");
  });
});

describe("builders thread the language param", () => {
  it("buildOpeningPrompt with 'auto' selects the auto rule", () => {
    const { system } = buildOpeningPrompt({
      speakerRole: "impl",
      partnerRole: "verify",
      spec,
      language: "auto",
    });
    expect(system).toContain("SAME language the user used");
    expect(system).not.toContain("Write your ENTIRE response in English");
  });

  it("buildOpeningPrompt without language stays English (default behavior)", () => {
    const { system } = buildOpeningPrompt({ speakerRole: "impl", partnerRole: "verify", spec });
    expect(system).toContain("Write your ENTIRE response in English");
  });

  it("buildRoundSummaryPrompt threads the positional language arg", () => {
    const { system } = buildRoundSummaryPrompt("ex", "topic", 1, "vietnamese");
    expect(system).toContain("Write your ENTIRE response in vietnamese");
  });

  it("buildSynthesisPrompt threads the language into its synthesis rule", () => {
    const { system } = buildSynthesisPrompt({
      spec,
      finalPositions: "pos",
      allExchanges: "ex",
      language: "vietnamese",
    });
    expect(system).toContain("Write ALL prose");
    expect(system).toContain("vietnamese");
  });
});
