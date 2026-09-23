/**
 * `evidenceLooksValid` must recognise the file:line citations the repos `/ideal`
 * actually targets on this machine produce.
 *
 * ## The link in the chain this closes
 *
 * The pattern read `ts|tsx|js|py|go|rs|java`. No `.cs`. So on a C# repo NO
 * criterion could ever be marked `met` on a file:line citation — done-gate
 * condition #2 (`evidence_regex`) rejected the only evidence a .NET sprint
 * naturally produces. That is one step past the `zero_coverage` floor defect on
 * the SAME path: fix the floor alone and a .NET run clears it and then loses its
 * criteria instead.
 *
 * ## Where the list comes from
 *
 * Not a language census — a scan of every `diffFiles`/`targetPaths` array in
 * `.muonroi-flow/runs/**` under `D:\sources\CompanyLibs\tcis-libraries` (3 runs:
 * `mu75rjiy5b32`, `mu75rurpf9ec`, `muauw6u93e1c`), which yields exactly
 * `{json: 2, sln: 1, cs: 4, csproj: 2, bak: 1}`. The justification for each
 * addition, grouped, is in `reality-anchor.ts` beside the list itself.
 */

import { describe, expect, it } from "vitest";
import { evidenceLooksValid, wrapSynthesisWithEvidence } from "../reality-anchor.js";

/**
 * Verbatim from `muauw6u93e1c/sprints/1-goal-gate.json` `diffFiles[2]`, with the
 * line `sprints/1-verify.md` names ("Line 53: `argList` is used before
 * declaration"). This exact string was REJECTED before the fold-in.
 */
const REAL_CS_CITATION = "src/src/TCIS.CodeStandards/Analyzers/TCIS0002_LineBreakStyleAnalyzer.cs:53";

describe("evidenceLooksValid — .NET citations (run muauw6u93e1c)", () => {
  it("accepts the real .cs file:line from that run's diffFiles", () => {
    expect(evidenceLooksValid(REAL_CS_CITATION)).toBe(true);
  });

  it("accepts a bare .cs basename:line with no path", () => {
    expect(evidenceLooksValid("TCIS0002_LineBreakStyleAnalyzer.cs:53")).toBe(true);
  });

  it("accepts the other two extensions the run's diffFiles name", () => {
    // `src/TCISLibraries.sln` and `.../TCIS.CodeStandards.csproj` are both in
    // diffFiles; a project-registration criterion is cited BY a line in them.
    expect(evidenceLooksValid("src/TCISLibraries.sln:12")).toBe(true);
    expect(evidenceLooksValid("src/src/TCIS.CodeStandards/TCIS.CodeStandards.csproj:7")).toBe(true);
  });

  it("does not let `cs` shadow `csproj` — the longer alternative still matches", () => {
    // `TCIS.CodeStandards.csproj:7` must match as `.csproj`, not fail because the
    // engine settled on `.cs` and then demanded a `:`.
    expect(evidenceLooksValid("TCIS.CodeStandards.csproj:7")).toBe(true);
  });

  it("accepts the MSBuild siblings that sit beside csproj/sln", () => {
    // `Directory.Build.props` is the marker `findDotnetMarkers` keys on and
    // `bb-ecosystem-apply.ts` edits.
    expect(evidenceLooksValid("Directory.Build.props:9")).toBe(true);
    expect(evidenceLooksValid("Directory.Build.targets:3")).toBe(true);
  });

  it("accepts the other first-class .NET languages compiled by the same dotnet build", () => {
    expect(evidenceLooksValid("Program.fs:11")).toBe(true);
    expect(evidenceLooksValid("Module1.vb:4")).toBe(true);
  });

  it("closes the gap in the extensions that were ALREADY listed", () => {
    // `js` and `tsx` were present; these siblings were not.
    expect(evidenceLooksValid("Button.jsx:18")).toBe(true);
    expect(evidenceLooksValid("build.mjs:2")).toBe(true);
    expect(evidenceLooksValid("postcss.config.cjs:5")).toBe(true);
  });

  it("keeps every extension that was already accepted", () => {
    for (const cite of [
      "src/sync.ts:42",
      "app.tsx:836",
      "index.js:1",
      "cli.py:12",
      "main.go:7",
      "lib.rs:99",
      "Main.java:3",
    ]) {
      expect(evidenceLooksValid(cite), cite).toBe(true);
    }
  });

  it("still rejects a file reference with no line number", () => {
    expect(evidenceLooksValid("src/src/TCIS.CodeStandards/Analyzers/TCIS0001_MaxLineLengthAnalyzer.cs")).toBe(false);
  });

  it("still rejects prose with no citation of any accepted form", () => {
    expect(evidenceLooksValid("the analyzer works now")).toBe(false);
    expect(evidenceLooksValid("")).toBe(false);
    expect(evidenceLooksValid("   ")).toBe(false);
  });

  it("does not accept an extension outside the justified set", () => {
    // Deliberately not added — no occurrence in any run artifact and no sibling
    // relationship to one. Guessing languages would make the list unfalsifiable.
    expect(evidenceLooksValid("script.ps1:4")).toBe(false);
    expect(evidenceLooksValid("app.rb:4")).toBe(false);
    expect(evidenceLooksValid("Main.kt:4")).toBe(false);
  });

  it("keeps the other four evidence forms working", () => {
    expect(evidenceLooksValid("test('handles empty input')")).toBe(true);
    // The baseline commit `verify-baseline.json` recorded for run muauw6u93e1c.
    expect(evidenceLooksValid("e4da0705637fdce927ac1fa799b541dc4d2f9580")).toBe(true);
    expect(evidenceLooksValid("p95: 240")).toBe(true);
    expect(evidenceLooksValid("GET /api/users → 200")).toBe(true);
  });
});

describe("wrapSynthesisWithEvidence — a met C# criterion now validates", () => {
  it("marks a .cs-cited met criterion evidenceValid, and an uncited one not", () => {
    const wrapped = wrapSynthesisWithEvidence([
      { id: "a", status: "met", evidence: REAL_CS_CITATION },
      { id: "b", status: "met", evidence: "I fixed the analyzer" },
      { id: "c", status: "unmet" },
    ]);

    expect(wrapped[0].evidenceValid).toBe(true);
    expect(wrapped[1].evidenceValid).toBe(false);
    // Unmet criteria never need evidence.
    expect(wrapped[2].evidenceValid).toBe(true);
  });
});
