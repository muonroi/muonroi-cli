import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateContextBundle } from "../pil-gate-context.js";

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "pil-gate-ctx-"));
}

describe("buildGateContextBundle", () => {
  it("returns empty strings when nothing is available (tolerant)", () => {
    const b = buildGateContextBundle({ cwd: tempCwd() });
    expect(b.conversationDigest).toBe("");
    expect(b.eeContext).toBe("");
    expect(b.priorPlan).toBe("");
    expect(b.projectHints).toBe("");
    expect(b.totalChars).toBe(0);
  });

  it("includes the digest and caps oversized inputs", () => {
    const b = buildGateContextBundle({ cwd: tempCwd(), conversationDigest: "x".repeat(5000) });
    expect(b.conversationDigest.length).toBeLessThanOrEqual(1200);
    expect(b.totalChars).toBeGreaterThan(0);
  });

  it("reads a prior PLAN.md when present", () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, ".planning"), { recursive: true });
    writeFileSync(join(cwd, ".planning", "PLAN.md"), "# PLAN\n\n## Steps\n1. do the thing", "utf8");
    const b = buildGateContextBundle({ cwd });
    expect(b.priorPlan).toContain("do the thing");
  });

  it("formats brainData principles/patterns into eeContext", () => {
    const b = buildGateContextBundle({
      cwd: tempCwd(),
      brainData: { t0_principles: ["Prefer library over bespoke"], t2_patterns: ["auth lives in providers"] },
    });
    expect(b.eeContext).toContain("Prefer library");
    expect(b.eeContext).toContain("auth lives in providers");
  });
});
