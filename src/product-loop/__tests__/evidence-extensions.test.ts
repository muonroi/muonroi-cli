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
 * ## Where the set comes from NOW
 *
 * `language-registry.ts` — THE single source of truth for "what does a source
 * file look like", which already registers C# (`.cs`), F# and Visual Basic. This
 * module holds no language list of its own any more: the file:line form captures
 * the extension and asks `isCodeFile()`, so a language added to
 * `SOURCE_LANGUAGES` reaches this gate with no edit here.
 *
 * The only local addition is project/solution surface (`.sln`, `.csproj`,
 * `.props`, …) — legitimately citable but not a programming language, so
 * deliberately absent from the registry. Same shape as `plan-target-paths.ts`'s
 * `NON_CODE_FILE_EXTENSIONS`.
 */

import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS } from "../language-registry.js";
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

  it("`cs` cannot shadow `csproj` — the extension is read off the name, not alternated", () => {
    // The old implementation alternated `cs|csproj|…` and had to be sorted
    // longest-first. The shape regex now CAPTURES the extension, so
    // `TCIS.CodeStandards.csproj:7` resolves to `.csproj` structurally — the
    // shadowing class of bug is gone rather than ordered around.
    expect(evidenceLooksValid("TCIS.CodeStandards.csproj:7")).toBe(true);
  });

  it("accepts the MSBuild siblings that sit beside csproj/sln", () => {
    // `Directory.Build.props` is the marker `findDotnetMarkers` keys on and
    // `bb-ecosystem-apply.ts` edits. Note the multi-dot name: the extension is the
    // LAST segment, so this resolves to `.props`.
    expect(evidenceLooksValid("Directory.Build.props:9")).toBe(true);
    expect(evidenceLooksValid("Directory.Build.targets:3")).toBe(true);
    expect(evidenceLooksValid("Acme.slnx:2")).toBe(true);
  });

  it("accepts the other first-class .NET languages, because the REGISTRY has them", () => {
    expect(evidenceLooksValid("Program.fs:11")).toBe(true);
    expect(evidenceLooksValid("Library.fsi:3")).toBe(true);
    expect(evidenceLooksValid("script.fsx:8")).toBe(true);
    expect(evidenceLooksValid("Module1.vb:4")).toBe(true);
  });

  it("closes the gap in the extensions that were ALREADY listed", () => {
    // `js` and `tsx` were present; these siblings were not.
    expect(evidenceLooksValid("Button.jsx:18")).toBe(true);
    expect(evidenceLooksValid("build.mjs:2")).toBe(true);
    expect(evidenceLooksValid("postcss.config.cjs:5")).toBe(true);
  });

  it("accepts EVERY registered source language — the registry is the only list", () => {
    // The load-bearing pin, mirroring `language-registry.test.ts`'s "the two
    // extension lists cannot diverge again". Enumerating the registry rather than
    // hand-writing a list here is what makes a newly registered language reach this
    // gate; a hand-written list would reintroduce the drift.
    for (const ext of CODE_EXTENSIONS) {
      expect(evidenceLooksValid(`SomeFile${ext}:12`), `${ext} must be citable evidence`).toBe(true);
    }
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

  it("rejects an extension that is neither a registered language nor a project file", () => {
    // The falsifiability pin: the accepted set is DERIVED, not "anything with a
    // dot". PowerShell is not in `SOURCE_LANGUAGES`, so a shell script is not
    // citable source evidence; nor are docs, CI config or data files.
    expect(evidenceLooksValid("script.ps1:4")).toBe(false);
    expect(evidenceLooksValid("notes.md:12")).toBe(false);
    expect(evidenceLooksValid("ci.yml:8")).toBe(false);
    expect(evidenceLooksValid("data.csv:3")).toBe(false);
  });

  it("DOES now accept .rb / .kt, because Ruby and Kotlin ARE registered languages", () => {
    // DECLARED behaviour change from the hand-written list, which rejected both.
    // Deriving the language half from the registry necessarily makes every
    // registered language citable — keeping one out would need a hand-written
    // exclusion list, which is the defect this removes.
    expect(CODE_EXTENSIONS.has(".rb")).toBe(true);
    expect(CODE_EXTENSIONS.has(".kt")).toBe(true);
    expect(evidenceLooksValid("app.rb:4")).toBe(true);
    expect(evidenceLooksValid("Main.kt:4")).toBe(true);
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
