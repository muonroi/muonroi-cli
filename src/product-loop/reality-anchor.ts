import { isCodeFile } from "./language-registry.js";
import type { Criterion } from "./types.js";

export type { Criterion } from "./types.js";

/**
 * Reality Anchor implements evidence verification for Definition-of-Done criteria.
 * It ensures that claims of "met" or "partial" status are backed by concrete evidence.
 *
 * ## The file:line form asks `language-registry.ts`, and why
 *
 * This module used to carry its OWN extension alternation —
 * `ts|tsx|js|py|go|rs|java`, with no `.cs`. On a C# repo no criterion could ever
 * be marked `met` on a file:line citation: done-gate condition #2
 * (`evidence_regex`) rejected the only evidence a .NET sprint naturally produces.
 * It is the same defect `language-registry.ts` was built to end — its own header
 * records the previous instance, where `repo-audit.ts` lacked `.cs` and reported
 * "Source files: 1" for a 506-file C# repository — and this module was one of the
 * two consumers the migration missed.
 *
 * So the language half is no longer written here at all: `isCodeFile()` decides
 * it, and a language added to `SOURCE_LANGUAGES` reaches this gate with no edit.
 * Only the non-language surface (`.sln`, `.csproj`, …) is local, below.
 */

/**
 * Project/solution files a `file:line` citation may legitimately name, which are
 * NOT source languages and so are deliberately absent from
 * `language-registry.ts`.
 *
 * They earn a place here because a registration criterion is satisfied BY a line
 * in the solution or project file — which is exactly what
 * `project-registration-check.ts` adjudicates — and because the real run
 * artifacts name them: `muauw6u93e1c/sprints/1-goal-gate.json` `diffFiles`
 * contains `src/TCISLibraries.sln` and `.../TCIS.CodeStandards.csproj`.
 *
 * Same shape as `plan-target-paths.ts`'s `NON_CODE_FILE_EXTENSIONS`: registry for
 * the language set, a small explicit local addition for config/project surface.
 * Kept narrower than that list on purpose — this answers "can a line here be
 * CITED as evidence", not "is this token a file", so docs and CI config
 * (`.md`, `.yml`, `.json`) stay out.
 */
const PROJECT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".sln",
  ".slnx",
  ".csproj",
  ".fsproj",
  ".vbproj",
  ".props",
  ".targets",
]);

/**
 * The SHAPE of a `file.ext:line` citation — no language knowledge in it.
 *
 * The extension is captured, not enumerated, so the alternation problem is gone
 * with it: there is no `cs`-shadows-`csproj` case to order around, because the
 * extension is read off the basename and then asked about. `[\w.-]+` cannot
 * cross a `/`, so a path citation matches on its basename (`Foo.cs` out of
 * `src/x/Foo.cs:53`) and a dotted name keeps its real extension
 * (`Directory.Build.props` → `.props`, via the last dot).
 */
const FILE_LINE_SHAPE = /\b([\w.-]+)\.([A-Za-z0-9]{1,8}):\d+/g;

/**
 * True when the text carries a `file:line` citation whose file is one we
 * recognise — a registered source language, or a project/solution file.
 */
function hasFileLineCitation(text: string): boolean {
  for (const m of text.matchAll(FILE_LINE_SHAPE)) {
    const filename = `${m[1]}.${m[2]}`;
    if (isCodeFile(filename)) return true;
    if (PROJECT_FILE_EXTENSIONS.has(`.${m[2].toLowerCase()}`)) return true;
  }
  return false;
}

/**
 * Validates whether a given piece of evidence text matches one of the 5 allowed forms.
 * 1. file:line (e.g., src/sync.ts:42, Analyzer.cs:53)
 * 2. test name (e.g., test('handles empty input'))
 * 3. commit sha (7-40 hex chars)
 * 4. benchmark (e.g., p95: 240ms)
 * 5. HTTP test (e.g., GET /api/users → 200)
 */
export function evidenceLooksValid(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  if (hasFileLineCitation(text)) return true;

  const patterns = [
    /\btest\(['"`].+['"`]\)|describe\(['"`].+['"`]\)/,
    /\b[a-f0-9]{7,40}\b/,
    /\b(?:lighthouse|p95|p99|qps|throughput)[\s:=]+\d+/i,
    /\b(GET|POST|PUT|DELETE|PATCH)\s+\/[^\s]+\s*→\s*\d{3}\b/,
  ];

  return patterns.some((regex) => regex.test(text));
}

/**
 * Annotates each criterion with evidenceValid: boolean based on the evidence field.
 */
export function wrapSynthesisWithEvidence(criteria: Criterion[]): Criterion[] {
  return criteria.map((c) => {
    if (c.status === "unmet") {
      return { ...c, evidenceValid: true }; // Unmet criteria don't need evidence
    }
    return {
      ...c,
      evidenceValid: c.evidence ? evidenceLooksValid(c.evidence) : false,
    };
  });
}
