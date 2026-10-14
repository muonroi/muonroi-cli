// src/pil/file-ref-extensions.ts
/**
 * "Does this prompt name a FILE?" — the extension vocabulary shared by the two
 * PIL heuristics that ask that question.
 *
 * ## Why this is not just `CODE_EXTENSIONS`
 *
 * `layer1-intent.ts`'s `FILE_REF_RE` and `layer1_5-complexity-size.ts`'s
 * `PATH_TOKEN_RE` are NOT asking "is this a source file". They are asking whether
 * a user's prompt carries a concrete file anchor, and `"update the release notes
 * in CHANGELOG.md"` carries one just as much as `"fix Analyzer.cs"`. Both
 * deliberately matched `.md` / `.json` / `.yml` / `.sh` / `.ps1` before the
 * language half was derived, and a straight substitution of `CODE_EXTENSIONS`
 * would have narrowed what they detect.
 *
 * So this follows the shape `reality-anchor.ts` and `plan-target-paths.ts`
 * already established: `language-registry.ts` owns the LANGUAGE set — a language
 * added to `SOURCE_LANGUAGES` reaches both heuristics with no edit here — and
 * {@link PROMPT_FILE_EXTENSIONS} is a small, documented local addition for the
 * non-language surface a prompt names.
 *
 * ## Why the addition is shared rather than written at each call site
 *
 * `reality-anchor.ts` keeps its local addition private because it is genuinely
 * narrower than the others (docs and CI config are not citable evidence). These
 * two are asking the SAME question in the SAME directory, so two private copies
 * would be one more instance of exactly the divergence this module exists to
 * prevent. One list, two regexes built from it.
 */

import { CODE_EXTENSIONS } from "../product-loop/language-registry.js";

/**
 * Non-language file types a prompt routinely names. Lowercase, leading dot.
 *
 * Two groups, both evidenced by what the sites matched or should have matched:
 *  - Docs / config / scripts: the pre-convergence alternation of
 *    `PATH_TOKEN_RE` carried `json|md|yml|yaml|toml|sh|ps1` verbatim, and
 *    `FILE_REF_RE` carried `json|md`. Dropping any of them would narrow
 *    detection, so all seven are kept for both.
 *  - Project / solution files: `.csproj` and `.sln` are named constantly in a
 *    .NET sprint — `muauw6u93e1c/sprints/1-goal-gate.json` `diffFiles` holds
 *    `src/TCISLibraries.sln` and `.../TCIS.CodeStandards.csproj`. They are not
 *    source languages, so the registry rightly excludes them; the same set is
 *    the local addition in `plan-target-paths.ts` and `reality-anchor.ts`.
 *    Naming them is also load-bearing here: see {@link buildFileRefAlternation}
 *    on why a trailing boundary is required, which without `.csproj` in the
 *    vocabulary would stop `Foo.csproj` being seen as a file at all.
 */
export const PROMPT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // docs / config / scripts
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".sh",
  ".ps1",
  // project / solution files
  ".sln",
  ".slnx",
  ".csproj",
  ".fsproj",
  ".vbproj",
  ".props",
  ".targets",
]);

/**
 * Module-load invariant, mirroring `language-registry.ts`'s ambiguous-extension
 * throw: the local addition must be an ADDITION. An entry that is also a
 * registered language would mean the language set is being re-stated here, which
 * is how a "local addition" quietly becomes a sixth hand-written copy.
 */
for (const ext of PROMPT_FILE_EXTENSIONS) {
  if (CODE_EXTENSIONS.has(ext)) {
    throw new Error(
      `file-ref-extensions: "${ext}" is already a registered source language, so it must not be ` +
        "restated in PROMPT_FILE_EXTENSIONS. Remove it — the language half is derived.",
    );
  }
}

/**
 * Every extension that makes a token look like a file to the PIL heuristics.
 * Deliberately NOT exported: callers want the regex fragment, and a second
 * exported set would be one more thing that can be read instead of derived.
 */
const FILE_REF_EXTENSIONS: ReadonlySet<string> = new Set([...CODE_EXTENSIONS, ...PROMPT_FILE_EXTENSIONS]);

/**
 * The alternation body for a `\.(…)` group — extensions without their leading
 * dot, **longest first**.
 *
 * Longest-first matters because a regex alternation is ordered: with `cs` before
 * `csproj`, `Foo.csproj` matches the prefix `cs` and yields the truncated token
 * `Foo.cs`. That is not hypothetical — it is what `PATH_TOKEN_RE` did on
 * f70968ec, because it had no trailing boundary either.
 *
 * ## Callers MUST terminate the group
 *
 * The registry includes C/C++ and Objective-C, so the vocabulary contains the
 * single-letter `.c`, `.h` and `.m`. Measured on f70968ec's `PATH_TOKEN_RE`
 * shape with those folded in and NO terminator: `TCIS.CodeStandards` yields
 * `tcis.c`, `Muonroi.Core` yields `muonroi.c` and `file.command` yields
 * `file.c` — false file references in ordinary dotted identifiers and English
 * prose. A trailing `\b` (as `FILE_REF_RE` already had) or `(?![\w-])` (needed
 * where the token may contain `-`) removes all three.
 */
export function buildFileRefAlternation(): string {
  return [...FILE_REF_EXTENSIONS]
    .map((ext) => ext.slice(1))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}
