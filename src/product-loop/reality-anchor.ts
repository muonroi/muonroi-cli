import type { Criterion } from "./types.js";

export type { Criterion } from "./types.js";

/**
 * Reality Anchor implements evidence verification for Definition-of-Done criteria.
 * It ensures that claims of "met" or "partial" status are backed by concrete evidence.
 */

/**
 * Source-file extensions a `file:line` citation may carry.
 *
 * ## Why this list needed .NET, and what justifies each entry
 *
 * It read `ts|tsx|js|py|go|rs|java` — no `.cs`. So on a C# repo NO criterion could
 * ever be marked `met` on a file:line citation: done-gate condition #2
 * (`evidence_regex`) rejected the only evidence a .NET sprint naturally produces.
 * That is the same chain as the `zero_coverage` defect one link further down —
 * a .NET run cleared the engineering floor and then lost its criteria instead.
 *
 * The list is derived from what the `/ideal` runs on this machine actually cite,
 * not from a language census. Scanning every `diffFiles`/`targetPaths` array in
 * `.muonroi-flow/runs/**` under `D:\sources\CompanyLibs\tcis-libraries` (3 runs:
 * `mu75rjiy5b32`, `mu75rurpf9ec`, `muauw6u93e1c`) yields exactly:
 * `{json: 2, sln: 1, cs: 4, csproj: 2, bak: 1}` — .NET only.
 *
 * Group A — NAMED by those artifacts:
 *  - `cs`    — 4 occurrences; `muauw6u93e1c/sprints/1-verify.md` cites
 *              `TCIS0002_LineBreakStyleAnalyzer.cs:53` verbatim.
 *  - `csproj`, `sln` — 2 and 1 occurrences. Not incidental: a registration
 *              criterion is cited BY a line in the solution/project file, which is
 *              exactly what `project-registration-check.ts` adjudicates.
 *
 * Group B — obvious siblings of Group A inside the same toolchain, each with a
 * concrete referent in this codebase:
 *  - `fs`, `vb` — the other two first-class .NET languages compiled by the very
 *              `dotnet build` that `detectDotnetRecipe` emits.
 *  - `props`, `targets` — MSBuild files that sit beside `csproj`/`sln`;
 *              `Directory.Build.props` is the marker `findDotnetMarkers` keys on
 *              and `bb-ecosystem-apply.ts` edits ("props minimalism").
 *
 * Group C — siblings of extensions ALREADY here, closing a gap the list had:
 *  - `jsx`, `mjs`, `cjs` — `js`/`tsx` were present, these were not.
 *              `pil/layer1_5-complexity-size.ts:49` already enumerates this exact
 *              set for file-reference detection, so the shapes do occur.
 *
 * Deliberately NOT added: no extension without evidence or a Group-A sibling
 * relationship (`rb`, `kt`, `swift`, `c`, `cpp`, `php`, `ex`, `ps1`, `razor`,
 * `cshtml`, …). Guessing twenty languages would make this list unfalsifiable,
 * which is the failure mode of the thing it is replacing.
 *
 * The asymmetry that argues for inclusion over minimalism: a MISSING extension
 * silently zeroes a criterion (the bug), while a superfluous one merely accepts a
 * citation shape that will not occur.
 */
const EVIDENCE_FILE_EXTENSIONS = [
  // already present
  "ts",
  "tsx",
  "js",
  "py",
  "go",
  "rs",
  "java",
  // Group A — named by the real run artifacts
  "cs",
  "csproj",
  "sln",
  // Group B — .NET/MSBuild siblings of Group A
  "fs",
  "vb",
  "props",
  "targets",
  // Group C — siblings of extensions already listed
  "jsx",
  "mjs",
  "cjs",
] as const;

/**
 * Longest-first so the alternation cannot settle on a prefix (`cs` inside
 * `csproj`). Regex alternation backtracks anyway, but ordering makes that
 * independent of engine behaviour rather than reliant on it.
 */
const FILE_LINE_RE = new RegExp(
  `\\b\\w+\\.(?:${[...EVIDENCE_FILE_EXTENSIONS].sort((a, b) => b.length - a.length).join("|")}):\\d+`,
);

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

  const patterns = [
    FILE_LINE_RE,
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
