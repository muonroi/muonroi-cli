/**
 * src/product-loop/spec-layout-check.ts
 *
 * S7 — a deterministic check that the ProductSpec's own `folderStructure` text
 * is consistent with the repo's observed layout convention.
 *
 * ## The bug this closes
 *
 * `layout-convention.ts` (F4b) derives the repo's real layout and hands it to
 * the model as evidence, but prompt text alone has already failed on this
 * exact class of bug: on a .NET repo whose real convention is `src/src/<Name>/`
 * for projects and `src/tests/<Name>.Tests/` for tests, a spec's
 * `folderStructure` proposed `src/<Name>` and `src/<Name>.Tests` — neither path
 * matches either observed root. The project was created there, never
 * registered in the solution, and the sprint that followed ended
 * `zero_coverage`. `project-registration-check.ts` (S6) closes the enforcement
 * half for the SOLUTION side, after the fact, once files exist. This module
 * closes it earlier and on the other axis: it checks the SPEC TEXT itself,
 * before a single file is written, against the same observed convention.
 *
 * ## Contract
 *
 * `checkSpecLayout` is a pure function — no filesystem access, no LLM call —
 * so its three-way `status` is fully deterministic and unit-testable without a
 * repo fixture:
 *
 *  - `"unknown"` — nothing could be judged: no convention was observed (a
 *    weak/ambiguous layout, or an empty repo — `layout-convention.ts` already
 *    encodes both as `null`), or `folderStructure` contained no token that
 *    plausibly names a project or test directory. Never conflated with
 *    `"ok"`: silence about a signal is not the same as confirming it held.
 *  - `"ok"` — every path-shaped token found in `folderStructure` that could be
 *    judged (project or test, matched against the convention's observed root
 *    for that kind) sits under its expected root.
 *  - `"mismatch"` — at least one such token sits under a CLEARLY different
 *    root than the convention observed for its kind.
 *
 * Conservative by construction: a token is only judged when its kind (project
 * vs test) has an observed root to compare against, and a mismatch requires
 * the token's own path to fail a `startsWith("<root>/")` check against that
 * root — never a fuzzy or partial-overlap heuristic. A root of `""` (projects
 * live directly at repo root) is never used to judge a token, because "how
 * many segments deep is too deep" has no single correct answer for a
 * repo-root convention and guessing wrong there would produce exactly the
 * false positive this module exists to avoid.
 *
 * ## What is never judged (adversarial-input hardening)
 *
 * A raw regex match on `folderStructure` text over-collects: it happily
 * matches the tail of a URL, the remainder of an absolute path after its
 * drive/root prefix is stripped (because `/`, `\`, and `:` are not path
 * characters the extractor keeps), or a specific FILE reference that never
 * claimed to be a project root at all. Judging those produced false positives
 * on a 20-case adversarial review — two of them inverted (a CONFORMING
 * absolute path flagged as a mismatch because only its tail survived
 * extraction). A token is excluded from judgment entirely — contributing to
 * neither `"ok"` nor `"mismatch"` — when:
 *
 *  - it is immediately preceded by `/`, `:`, or `@` in the source text, which
 *    is what a URL (`https://host/...`, `git@host:...`) or an absolute path
 *    (`C:/...`, `/home/...`) leaves behind once the extractor's character
 *    class (word/dot/dash only) stops matching the scheme/drive/root prefix.
 *    The prefix is discarded rather than resolved against the repo root
 *    because this function has no filesystem access and no cwd — guessing
 *    that an arbitrary absolute prefix IS the repo root would silently trade
 *    one false-positive class for a false-negative one;
 *  - its first segment is a directory the convention never claims as a
 *    project or test root — build output (`dist`, `build`, `node_modules`,
 *    `obj`, `target`, `__pycache__`, via `BUILD_OUTPUT_DIRS`) or documentation
 *    (`docs`, `doc`, `documentation`) or a generic output root (`out`);
 *  - its last segment is a FILE with a known extension (`Program.cs`,
 *    `README.md`) — that segment is dropped and the parent directory is
 *    judged instead, but only when the parent still has enough segments to
 *    plausibly name a project directory (two or more); a single leftover
 *    segment (`src/Program.cs` → `src`) is not judged as a project claim.
 */
import { BUILD_OUTPUT_DIRS, CODE_EXTENSIONS, isTestDirName } from "./language-registry.js";
import type { LayoutConvention } from "./layout-convention.js";

export type SpecLayoutCheckStatus = "ok" | "mismatch" | "unknown";

export type SpecLayoutFindingKind = "project" | "test";

export interface SpecLayoutFinding {
  /** The path-shaped token found in `folderStructure`, verbatim. */
  path: string;
  /** The convention's observed root for this token's kind ("" = repo root). */
  expectedRoot: string;
  kind: SpecLayoutFindingKind;
}

export interface SpecLayoutCheckResult {
  status: SpecLayoutCheckStatus;
  findings: SpecLayoutFinding[];
}

/**
 * Path-shaped token: at least two `/`-separated segments of word/dot/dash
 * characters, with an optional trailing slash. Requiring a second segment
 * excludes bare directory mentions ("src/", "tests/") that are too shallow to
 * judge against a `<root>/<Name>/...` convention, and requiring the character
 * class excludes prose ("point to existing", "e.g.") that happens to contain
 * a period but no slash. Deliberately does not include `:`, `@`, or `\` — a
 * URL scheme, a `git@host:` prefix, and a Windows drive/backslash prefix are
 * exactly what must NOT be swallowed into the token; see `EXCLUDED_PRECEDING_CHARS`.
 */
const PATH_TOKEN_RE = /[\w.-]+(?:\/[\w.-]+)+\/?/g;

/**
 * A character sitting directly in front of a matched token that marks the
 * token as the REMAINDER of something this function must not judge:
 *  - `/` — an absolute POSIX path (`/home/...`) or the `//` of a URL scheme
 *    (`https://host/...`, where the match begins right at `host`);
 *  - `:` — a Windows drive prefix (`C:/...` — the match begins at `repo` in
 *    `C:/repo/...` once `C:` is dropped, immediately preceded by `/` at that
 *    point too, but `:` alone also covers `C:repo` with no separating slash);
 *  - `@` — a `git@host/...` / `git@host:...` SSH-style prefix.
 */
const EXCLUDED_PRECEDING_CHARS: ReadonlySet<string> = new Set(["/", ":", "@"]);

/**
 * Directories a repo's OWN layout convention never claims as a project or
 * test root, so a token that starts under one is never a folderStructure
 * violation — it is legitimately outside the convention. `BUILD_OUTPUT_DIRS`
 * is shared with the rest of the repo-audit stack (layout-convention.ts,
 * repo-audit.ts) so this list cannot silently diverge from theirs; `docs`
 * variants and `out` are added because they name CONTENT/output roots the
 * project-layout convention was never observed against.
 */
const NON_PROJECT_ROOTS: ReadonlySet<string> = new Set([...BUILD_OUTPUT_DIRS, "docs", "doc", "documentation", "out"]);

/**
 * Extensions naming a FILE rather than a directory. Reuses the shared
 * `CODE_EXTENSIONS` registry (so a new source language is recognised here
 * automatically) plus a short list of common non-code single-file extensions
 * that registry does not cover (docs, manifests, data).
 */
const KNOWN_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...CODE_EXTENSIONS,
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".csproj",
  ".fsproj",
  ".vbproj",
  ".sln",
  ".slnx",
  ".lock",
  ".log",
  ".csv",
]);

function fileExtensionOf(segment: string): string {
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return "";
  return segment.slice(dot).toLowerCase();
}

/** Test kind when ANY segment reads as a test directory — mirrors `toHit` in layout-convention.ts. */
function classifyKind(segments: readonly string[]): SpecLayoutFindingKind {
  return segments.some((s) => isTestDirName(s)) ? "test" : "project";
}

/** Never judges a `""` (repo-root) convention root — see module doc comment. */
function isUnderRoot(candidate: string, root: string): boolean {
  if (root === "") return true;
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * One judgeable candidate extracted from `folderStructure`: the verbatim
 * token (for reporting) and the segments to actually compare against the
 * convention (which may be shorter than the token when a trailing file
 * segment was stripped — see the module doc comment).
 */
interface Candidate {
  raw: string;
  judgeSegments: readonly string[];
}

/**
 * Walk every path-shaped token in `folderStructure` and keep only the ones
 * that plausibly name a project or test directory — see the module doc
 * comment's "What is never judged" section for the exclusion rules. Dedupes
 * on the verbatim token so a path mentioned twice is judged once.
 */
function extractCandidates(folderStructure: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];

  for (const match of folderStructure.matchAll(PATH_TOKEN_RE)) {
    const raw = match[0].replace(/\/+$/, "");
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);

    const precedingChar = match.index > 0 ? folderStructure[match.index - 1] : undefined;
    if (precedingChar !== undefined && EXCLUDED_PRECEDING_CHARS.has(precedingChar)) continue;

    const segments = raw.split("/");
    const firstSegment = (segments[0] ?? "").toLowerCase();
    if (NON_PROJECT_ROOTS.has(firstSegment)) continue;

    const lastSegment = segments[segments.length - 1] ?? "";
    let judgeSegments: readonly string[] = segments;
    if (KNOWN_FILE_EXTENSIONS.has(fileExtensionOf(lastSegment))) {
      const withoutFile = segments.slice(0, -1);
      // A single leftover segment ("src/Program.cs" -> "src") is not a
      // plausible project-directory claim on its own — skip rather than
      // judge a bare top-level directory as if the spec had named it.
      if (withoutFile.length < 2) continue;
      judgeSegments = withoutFile;
    }

    out.push({ raw, judgeSegments });
  }

  return out;
}

export function checkSpecLayout(folderStructure: string, convention: LayoutConvention | null): SpecLayoutCheckResult {
  if (!convention) return { status: "unknown", findings: [] };

  const candidates = extractCandidates(folderStructure ?? "");
  if (candidates.length === 0) return { status: "unknown", findings: [] };

  const findings: SpecLayoutFinding[] = [];
  let judged = 0;

  for (const { raw, judgeSegments } of candidates) {
    const kind = classifyKind(judgeSegments);
    const expectedRoot = kind === "test" ? convention.testsDir : convention.projectsDir;
    if (expectedRoot === undefined) continue; // no observed root for this kind — cannot judge
    if (expectedRoot === "") continue; // repo-root convention — never judged, see doc comment
    judged++;
    if (!isUnderRoot(judgeSegments.join("/"), expectedRoot)) {
      findings.push({ path: raw, expectedRoot, kind });
    }
  }

  if (judged === 0) return { status: "unknown", findings: [] };
  return findings.length > 0 ? { status: "mismatch", findings } : { status: "ok", findings: [] };
}

/**
 * One-line, model-facing correction naming the repo's real root(s) — appended
 * to the sprint planner's context (sprint-runner.ts) so the mismatch a spec
 * shipped with is not silently repeated at planning time.
 */
export function formatSpecLayoutCorrection(result: SpecLayoutCheckResult): string | null {
  if (result.status !== "mismatch" || result.findings.length === 0) return null;
  const lines = [
    "Correction: the ProductSpec's folderStructure did not match the repo's observed layout convention.",
    ...result.findings.map(
      (f) => `  - "${f.path}" (${f.kind}) does not sit under the observed ${f.kind} root "${f.expectedRoot}".`,
    ),
    "New code MUST use the observed root(s) above, not the folderStructure text as written.",
  ];
  return lines.join("\n");
}
