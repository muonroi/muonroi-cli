import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../council/leader.js", () => ({ resolvePlanCouncilLeader: vi.fn(async () => ({ modelId: "leader" })) }));

import { resolvePlanCouncilLeader } from "../../council/leader.js";
import { assessComplexity, shouldAssess } from "../complexity-assessor.js";

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
    expect(existsSync(join(cwd, ".planning", "ASSESSMENT.md"))).toBe(true);
    expect(readFileSync(join(cwd, ".planning", "ASSESSMENT.md"), "utf8")).toContain("multi-file");
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
    expect(existsSync(join(cwd, ".planning", "ASSESSMENT.md"))).toBe(false);
  });
});
