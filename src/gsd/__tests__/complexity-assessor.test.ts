import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../council/leader.js", () => ({ resolvePlanCouncilLeader: vi.fn(async () => ({ modelId: "leader" })) }));

import { resolvePlanCouncilLeader } from "../../council/leader.js";
import { assessComplexity, shouldAssess } from "../complexity-assessor.js";
import { planningArtifact } from "../paths.js";

describe("shouldAssess pre-filter", () => {
  it("skips a high-confidence quick task", () => {
    expect(shouldAssess("quick", 0.95)).toBe(false);
  });
  it("runs on any standard/heavy task", () => {
    expect(shouldAssess("standard", 0.95)).toBe(true);
    expect(shouldAssess("heavy", 0.9)).toBe(true);
  });
  it("runs on a low-confidence quick task", () => {
    expect(shouldAssess("quick", 0.4)).toBe(true);
  });

  describe("continuation raises the skip bar for quick", () => {
    const prev = process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR;
    afterEach(() => {
      if (prev === undefined) delete process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR;
      else process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR = prev;
    });

    it("first-turn (no prior context) still skips a mid-confidence quick", () => {
      delete process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR;
      // 0.75 ≥ base floor 0.7 → skip when there is no conversation to reference.
      expect(shouldAssess("quick", 0.75, false)).toBe(false);
    });

    it("continuation double-checks the SAME mid-confidence quick (default floor 0.85)", () => {
      delete process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR;
      // The exact classifier default (0.75) on a follow-up now gets the leader check.
      expect(shouldAssess("quick", 0.75, true)).toBe(true);
    });

    it("continuation still skips a very-high-confidence quick", () => {
      delete process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR;
      expect(shouldAssess("quick", 0.9, true)).toBe(false);
    });

    it("honours the env override for the continuation floor", () => {
      process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR = "0.7"; // = base → disables the extra bar
      expect(shouldAssess("quick", 0.75, true)).toBe(false);
    });

    it("clamps an out-of-range env floor into [0.7, 1]", () => {
      process.env.MUONROI_GSD_CONTINUATION_CONF_FLOOR = "5";
      // clamped to 1 → any quick continuation below full confidence is checked.
      expect(shouldAssess("quick", 0.99, true)).toBe(true);
    });
  });
});

describe("assessComplexity", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "assess-"));
  });

  it("short-circuits (assessed=false, keeps priorDepth) when pre-filter says skip", async () => {
    const r = await assessComplexity({
      cwd,
      raw: "fix typo",
      priorDepth: "quick",
      confidence: 0.95,
      sessionModelId: "m",
    });
    expect(r.assessed).toBe(false);
    expect(r.depth).toBe("quick");
    expect(r.source).toBe("prefilter-skip");
  });

  it("runs the leader assessor and writes ASSESSMENT.md when the pre-filter passes", async () => {
    const runAssessor = vi.fn(
      async () => '```complexity-verdict\n{"depth":"heavy","autoCouncil":true,"rationale":"multi-file"}\n```',
    );
    const r = await assessComplexity({
      cwd,
      raw: "rebuild routing",
      priorDepth: "standard",
      confidence: 0.9,
      sessionModelId: "m",
      runAssessor,
    });
    expect(r.assessed).toBe(true);
    expect(r.depth).toBe("heavy");
    expect(r.autoCouncil).toBe(true);
    expect(existsSync(planningArtifact(cwd, "ASSESSMENT.md"))).toBe(true);
    expect(readFileSync(planningArtifact(cwd, "ASSESSMENT.md"), "utf8")).toContain("multi-file");
  });

  it("falls back to priorDepth (no throw) when the assessor emits no structured verdict", async () => {
    const runAssessor = vi.fn(async () => "waffle, no verdict block");
    const r = await assessComplexity({
      cwd,
      raw: "x",
      priorDepth: "standard",
      confidence: 0.9,
      sessionModelId: "m",
      runAssessor,
    });
    expect(r.depth).toBe("standard");
    expect(r.source).toBe("parse-failed-fallback");
  });

  it("does not throw and keeps priorDepth when runAssessor rejects", async () => {
    const runAssessor = vi.fn(async () => {
      throw new Error("upstream call failed");
    });
    const r = await assessComplexity({
      cwd,
      raw: "x",
      priorDepth: "heavy",
      confidence: 0.9,
      sessionModelId: "m",
      runAssessor,
    });
    expect(r.assessed).toBe(false);
    expect(r.depth).toBe("heavy");
    expect(r.source).toBe("parse-failed-fallback");
  });

  it("does not throw and keeps priorDepth when leader resolution fails after a valid verdict", async () => {
    vi.mocked(resolvePlanCouncilLeader).mockRejectedValueOnce(new Error("uncataloged model id"));
    const runAssessor = vi.fn(
      async () => '```complexity-verdict\n{"depth":"heavy","autoCouncil":true,"rationale":"multi-file"}\n```',
    );
    const r = await assessComplexity({
      cwd,
      raw: "rebuild routing",
      priorDepth: "standard",
      confidence: 0.9,
      sessionModelId: "m",
      runAssessor,
    });
    expect(r.assessed).toBe(false);
    expect(r.depth).toBe("standard");
    expect(r.source).toBe("parse-failed-fallback");
    expect(existsSync(planningArtifact(cwd, "ASSESSMENT.md"))).toBe(false);
  });

  it("passes bundle context into the assessor prompt and returns quality + enrichedPrompt", async () => {
    let seenPrompt = "";
    const res = await assessComplexity({
      cwd,
      raw: "fix the login bug",
      priorDepth: "heavy",
      confidence: 0.75,
      sessionModelId: "test-model",
      bundle: {
        conversationDigest: "prior: user asked about oauth login",
        eeContext: "- pattern: auth lives in providers",
        priorPlan: "",
        projectHints: "",
        totalChars: 60,
      },
      runAssessor: async (prompt) => {
        seenPrompt = prompt;
        return [
          "```complexity-verdict",
          JSON.stringify({
            depth: "heavy",
            autoCouncil: false,
            rationale: "auth change",
            quality: { verdict: "enriched", missing: ["acceptance"], noiseRisk: "low" },
            enrichedPrompt: "Intent: fix login\nLikely area: providers (confirm via grep before anchoring)",
          }),
          "```",
        ].join("\n");
      },
    });
    expect(seenPrompt).toContain("prior: user asked about oauth login");
    expect(seenPrompt).toContain("auth lives in providers");
    expect(res.quality?.verdict).toBe("enriched");
    expect(res.enrichedPrompt).toContain("confirm via grep");
  });

  it("fail-open returns empty enrichedPrompt + priorDepth on parse failure", async () => {
    const res = await assessComplexity({
      cwd,
      raw: "x",
      priorDepth: "standard",
      confidence: 0.75,
      sessionModelId: "test-model",
      runAssessor: async () => "garbage, no fenced block",
    });
    expect(res.depth).toBe("standard");
    expect(res.enrichedPrompt).toBe("");
    expect(res.quality).toBeUndefined();
  });
});
