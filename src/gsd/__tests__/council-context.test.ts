import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCouncilContextBundle, renderCouncilContextBlock } from "../council-context.js";

describe("council context bundle — ASSESSMENT.md fold-in", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "council-context-"));
    mkdirSync(join(cwd, ".planning"), { recursive: true });
  });

  it("includes the assessor rationale in the bundle + rendered block", () => {
    writeFileSync(
      join(cwd, ".planning", "ASSESSMENT.md"),
      [
        "# Complexity Assessment",
        "",
        "depth: heavy",
        "autoCouncil: true",
        "leader: `some-model`",
        "",
        "## Rationale",
        "",
        "Requires multi-file changes across the routing layer.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(cwd, ".planning", "PLAN.md"), ["## Acceptance", "", "- Thing works"].join("\n"), "utf8");

    const bundle = buildCouncilContextBundle(cwd, { depth: "heavy" });
    expect(bundle.assessment).toContain("multi-file");

    const rendered = renderCouncilContextBlock(bundle);
    expect(rendered).toContain("Complexity assessment");
    expect(rendered).toContain("multi-file");
  });

  it("degrades gracefully (empty assessment, no section) when ASSESSMENT.md is absent", () => {
    const bundle = buildCouncilContextBundle(cwd, { depth: "standard" });
    expect(bundle.assessment).toBe("");

    const rendered = renderCouncilContextBlock(bundle);
    expect(rendered).not.toContain("Complexity assessment");
  });
});
