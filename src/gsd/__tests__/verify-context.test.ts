import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildVerifyContextBundle } from "../verify-context.js";

describe("buildVerifyContextBundle", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "gsd-vctx-"));
    const d = join(cwd, ".planning");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "PLAN.md"), "# Plan\n\n## Acceptance\n- login returns a token\n", "utf8");
    writeFileSync(
      join(d, "STATE.md"),
      "# STATE\n\n| Field | Value |\n|---|---|\n| Phase | verify |\n| Depth | heavy |\n",
      "utf8",
    );
    writeFileSync(join(d, "PLAN-VERIFY.md"), "verdict: pass\n", "utf8");
  });

  it("carries acceptance criteria, evidence, and diff into the bundle", () => {
    const b = buildVerifyContextBundle(cwd, {
      depth: "heavy",
      evidence: "42 tests passed",
      diff: "diff --git a b\n+token",
    });
    expect(b.base.acceptanceCriteria).toContain("login returns a token");
    expect(b.evidence).toContain("42 tests passed");
    expect(b.diff).toContain("token");
    expect(b.planVerdict).toBe("pass");
    expect(b.diffChars).toBeGreaterThan(0);
  });

  it("degrades to empty diff/evidence without throwing", () => {
    const b = buildVerifyContextBundle(cwd, { depth: "heavy" });
    expect(b.diff).toBe("");
    expect(b.evidence).toBe("");
  });
});
