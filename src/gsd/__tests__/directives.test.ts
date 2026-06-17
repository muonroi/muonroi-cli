import { describe, expect, it } from "vitest";
import { scoreComplexity } from "../complexity";
import { buildDirective, mentionsEcosystemScope } from "../directives";
import { detectGrayAreas } from "../gray-areas";

describe("buildDirective", () => {
  it("emits a blocking heavy directive with mandatory steps", () => {
    const prompt = "redo the entire architecture and map everything across all repos";
    const complexity = scoreComplexity(prompt);
    expect(complexity.tier).toBe("heavy");

    const grayAreas = detectGrayAreas(prompt).questions;
    const out = buildDirective({ complexity, phase: null, grayAreas });

    expect(out.tier).toBe("heavy");
    expect(out.blocking).toBe(true);
    expect(out.text).toContain("MANDATORY");
    expect(out.text).toMatch(/AskUserQuestion/);
    expect(out.text).toMatch(/IN PARALLEL/);
    expect(out.text).toMatch(/research/i);
    expect(out.text).toMatch(/verify/i);
  });

  it("emits a non-blocking standard directive", () => {
    const complexity = scoreComplexity("add a /health endpoint");
    const out = buildDirective({ complexity, phase: "execute", grayAreas: [] });
    expect(out.tier).toBe("standard");
    expect(out.blocking).toBe(false);
    expect(out.text).toMatch(/GSD-quick/i);
  });

  it("emits a fix-first debug variant when phase is debug (session 7d56a049e1e3 regression)", () => {
    const complexity = scoreComplexity("fix CI fail");
    const out = buildDirective({ complexity, phase: "debug", grayAreas: [] });
    expect(out.tier).toBe("standard");
    expect(out.text).toMatch(/DEBUG task/);
    expect(out.text).toMatch(/FIX-FIRST/);
    expect(out.text).toMatch(/≤ 8 read_file/);
    expect(out.text).toMatch(/edit_file/);
  });

  it("standard non-debug phases use the generic GSD-quick directive (regression: don't apply fix-first cap to plan/execute)", () => {
    const complexity = scoreComplexity("add a counter feature");
    const out = buildDirective({ complexity, phase: "execute", grayAreas: [] });
    expect(out.text).not.toMatch(/FIX-FIRST/);
    expect(out.text).not.toMatch(/read_file calls before/);
  });

  it("emits a human-facing question directive for informational/meta prompts (session 829a83888dd2)", () => {
    // A self/meta CLI question routed through GSD must NOT get the
    // implement/verify scaffold — that leaked a "2-3 line plan" preamble +
    // process narration into the human-facing answer.
    const complexity = scoreComplexity("how does this CLI affect you?");
    const out = buildDirective({ complexity, phase: null, grayAreas: [], informational: true });
    expect(out.blocking).toBe(false);
    expect(out.text).toMatch(/QUESTION \/ explanatory/);
    expect(out.text).toMatch(/written for the HUMAN/);
    expect(out.text).not.toMatch(/2-3 line plan/);
    expect(out.text).not.toMatch(/Implement directly/);
  });

  it("informational overrides even a heavy tier (a question never implements)", () => {
    const complexity = scoreComplexity("redo the entire architecture and map everything across all repos");
    expect(complexity.tier).toBe("heavy");
    const out = buildDirective({ complexity, phase: null, grayAreas: [], informational: true });
    expect(out.blocking).toBe(false);
    expect(out.text).toMatch(/QUESTION \/ explanatory/);
    expect(out.text).not.toMatch(/MANDATORY/);
  });

  it("emits a minimal quick directive", () => {
    const complexity = scoreComplexity("fix typo");
    const out = buildDirective({ complexity, phase: null, grayAreas: [] });
    expect(out.tier).toBe("quick");
    expect(out.blocking).toBe(false);
    expect(out.text.length).toBeLessThan(300);
  });

  it("appends the muonroi-docs nudge for an ecosystem question (session 41ccfeb2ceee turn 1)", () => {
    const complexity = scoreComplexity("bạn hiểu thế nào về ecosystem muonroi nói chung");
    const out = buildDirective({ complexity, phase: null, grayAreas: [], informational: true, ecosystem: true });
    expect(out.text).toMatch(/QUESTION \/ explanatory/); // still the human-facing question directive
    expect(out.text).toMatch(/ECOSYSTEM SCOPE/);
    expect(out.text).toMatch(/muonroi-docs MCP is the AUTHORITATIVE source|AUTHORITATIVE source/);
    expect(out.text).toMatch(/call it FIRST/i);
  });

  it("does NOT append the ecosystem nudge for a plain question", () => {
    const complexity = scoreComplexity("how does this CLI affect you?");
    const out = buildDirective({ complexity, phase: null, grayAreas: [], informational: true });
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

  it("renders the recommended option first in gray-area block", () => {
    const prompt = "redo everything from scratch";
    const complexity = scoreComplexity(prompt);
    const grayAreas = detectGrayAreas(prompt).questions;
    const out = buildDirective({ complexity, phase: null, grayAreas });
    if (grayAreas.length > 0) {
      expect(out.text).toMatch(/\[recommended\]/);
    }
  });
});
