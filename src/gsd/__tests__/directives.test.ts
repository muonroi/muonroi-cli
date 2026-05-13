import { describe, expect, it } from "vitest";
import { scoreComplexity } from "../complexity";
import { buildDirective } from "../directives";
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

  it("emits a minimal quick directive", () => {
    const complexity = scoreComplexity("fix typo");
    const out = buildDirective({ complexity, phase: null, grayAreas: [] });
    expect(out.tier).toBe("quick");
    expect(out.blocking).toBe(false);
    expect(out.text.length).toBeLessThan(300);
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
