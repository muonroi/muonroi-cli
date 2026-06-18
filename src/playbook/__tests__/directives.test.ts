import { describe, expect, it } from "vitest";
import { buildDirective, mentionsEcosystemScope } from "../directives";

describe("buildDirective", () => {
  it("emits a blocking heavy directive with discuss → research → plan → check-plan → verify", () => {
    const out = buildDirective({ tier: "heavy", phase: null });

    expect(out.tier).toBe("heavy");
    expect(out.blocking).toBe(true);
    expect(out.text).toMatch(/HEAVY task/);
    expect(out.text).toMatch(/DISCUSS/);
    expect(out.text).toMatch(/RESEARCH/);
    expect(out.text).toMatch(/CHECK-PLAN/);
    expect(out.text).toMatch(/AskUserQuestion/);
    expect(out.text).toMatch(/VERIFY/);
    // Hybrid: the agent may de-escalate if the task is smaller than it reads.
    expect(out.text).toMatch(/STANDARD flow/);
  });

  it("emits a non-blocking standard directive with an explicit plan + check step", () => {
    const out = buildDirective({ tier: "standard", phase: "execute" });
    expect(out.tier).toBe("standard");
    expect(out.blocking).toBe(false);
    expect(out.text).toMatch(/STANDARD task/);
    expect(out.text).toMatch(/PLAN —/);
    expect(out.text).toMatch(/CHECK —/);
    expect(out.text).toMatch(/VERIFY —/);
    // Hybrid: escalate to HEAVY if it turns out architectural.
    expect(out.text).toMatch(/escalate to the HEAVY flow/);
  });

  it("emits a fix-first debug variant when phase is debug (session 7d56a049e1e3 regression)", () => {
    const out = buildDirective({ tier: "standard", phase: "debug" });
    expect(out.tier).toBe("standard");
    expect(out.text).toMatch(/DEBUG task/);
    expect(out.text).toMatch(/FIX-FIRST/);
    expect(out.text).toMatch(/≤ 8 read_file/);
    expect(out.text).toMatch(/edit_file/);
  });

  it("standard non-debug phases use the generic plan/check directive (regression: don't apply fix-first cap to plan/execute)", () => {
    const out = buildDirective({ tier: "standard", phase: "execute" });
    expect(out.text).not.toMatch(/FIX-FIRST/);
    expect(out.text).not.toMatch(/read_file calls before/);
  });

  it("emits a human-facing question directive for informational/meta prompts (session 829a83888dd2)", () => {
    // A self/meta CLI question routed through GSD must NOT get the
    // implement/verify scaffold — that leaked a "2-3 line plan" preamble +
    // process narration into the human-facing answer.
    const out = buildDirective({ tier: "quick", phase: null, informational: true });
    expect(out.blocking).toBe(false);
    expect(out.text).toMatch(/QUESTION \/ explanatory/);
    expect(out.text).toMatch(/written for the HUMAN/);
    expect(out.text).not.toMatch(/2-3 line plan/);
    expect(out.text).not.toMatch(/CHECK-PLAN/);
  });

  it("informational overrides even a heavy tier (a question never implements)", () => {
    const out = buildDirective({ tier: "heavy", phase: null, informational: true });
    expect(out.blocking).toBe(false);
    expect(out.text).toMatch(/QUESTION \/ explanatory/);
    expect(out.text).not.toMatch(/DISCUSS/);
    expect(out.text).not.toMatch(/CHECK-PLAN/);
  });

  it("emits a quick directive that stays short", () => {
    const out = buildDirective({ tier: "quick", phase: null });
    expect(out.tier).toBe("quick");
    expect(out.blocking).toBe(false);
    expect(out.text).toMatch(/QUICK task/);
    expect(out.text.length).toBeLessThan(600);
  });

  it("appends the muonroi-docs nudge for an ecosystem question (session 41ccfeb2ceee turn 1)", () => {
    const out = buildDirective({ tier: "quick", phase: null, informational: true, ecosystem: true });
    expect(out.text).toMatch(/QUESTION \/ explanatory/); // still the human-facing question directive
    expect(out.text).toMatch(/ECOSYSTEM SCOPE/);
    expect(out.text).toMatch(/muonroi-docs MCP is the AUTHORITATIVE source|AUTHORITATIVE source/);
    expect(out.text).toMatch(/call it FIRST/i);
  });

  it("does NOT append the ecosystem nudge for a plain question", () => {
    const out = buildDirective({ tier: "quick", phase: null, informational: true });
    expect(out.text).not.toMatch(/ECOSYSTEM SCOPE/);
  });

  it("mentionsEcosystemScope is tight: ecosystem/BB wording yes, bare CLI-internals no", () => {
    // Fires on genuine ecosystem scope (the case muonroi-docs exists to serve)…
    expect(mentionsEcosystemScope("ecosystem muonroi nói chung và muonroi-cli nói riêng")).toBe(true);
    expect(mentionsEcosystemScope("hệ sinh thái muonroi gồm những gì")).toBe(true);
    expect(mentionsEcosystemScope("how does the building-block rule engine work")).toBe(true);
    // …but NOT on a muonroi-cli internals question that merely names the product,
    // which would wrongly steer toward .NET package docs.
    expect(mentionsEcosystemScope("how does muonroi-cli compaction work")).toBe(false);
    expect(mentionsEcosystemScope("fix the off-by-one in the router")).toBe(false);
  });

  // Language nudge — re-anchors the "reply in user's language" rule INSIDE the
  // directive so layered brevity / FIX-FIRST directives can't drown it (live
  // miss: storyflow_ui session 22661c8de9f2).
  describe("language nudge", () => {
    it("appends the nudge when replyLanguage is set", () => {
      const out = buildDirective({ tier: "standard", phase: "debug", replyLanguage: "Vietnamese" });
      expect(out.text).toMatch(/LANGUAGE — the user wrote in Vietnamese/);
      expect(out.text).toMatch(/Reply in Vietnamese/);
      expect(out.text).toMatch(/OVERRIDES any brevity/);
    });

    it("omits the nudge when replyLanguage is undefined", () => {
      const out = buildDirective({ tier: "standard", phase: "debug" });
      expect(out.text).not.toMatch(/LANGUAGE —/);
    });

    it("stacks with the ecosystem nudge when both apply", () => {
      const out = buildDirective({
        tier: "heavy",
        phase: null,
        ecosystem: true,
        replyLanguage: "Vietnamese",
      });
      expect(out.text).toMatch(/ECOSYSTEM SCOPE/);
      expect(out.text).toMatch(/LANGUAGE —/);
      // ecosystem nudge precedes language nudge (deterministic order)
      expect(out.text.indexOf("ECOSYSTEM SCOPE")).toBeLessThan(out.text.indexOf("LANGUAGE —"));
    });
  });
});
