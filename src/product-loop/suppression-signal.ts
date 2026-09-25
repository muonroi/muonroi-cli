/**
 * src/product-loop/suppression-signal.ts
 *
 * The ONE definition of "this sprint silenced a diagnostic instead of fixing it".
 *
 * ## The defect this exists to surface
 *
 * Commit `4230384e` made the LSP commit gate NAME its diagnostics instead of
 * counting them, and it worked: in a live `/ideal` run the gate printed four
 * diagnostics and the model produced a commit titled
 * `fix(sprint1): resolve 3 LSP errors in artifact-store smoke test`.
 *
 * How it resolved them, from that commit's own diff:
 *
 * | diagnostic                              | what the "fix" did                              |
 * |-----------------------------------------|-------------------------------------------------|
 * | `"_pytest" is not defined`              | FIXED — dropped the alias, used `pytest.raises` |
 * | `bytes` not assignable to `BinaryIO`    | `# type: ignore[arg-type]` — SILENCED           |
 * | `Import "sys" is not accessed`          | `# type: ignore[reportUnusedImport]` — SILENCED |
 * | `Import "importlib.util" is not accessed` | `# type: ignore[reportUnusedImport]` — SILENCED |
 *
 * One real fix, three suppressions. Deleting an unused import is a one-line
 * change; the model added a directive instead. No gate in the pipeline
 * distinguished "the error is gone because the code is right" from "the error is
 * gone because the checker was told to be quiet", so the sprint read as clean
 * either way.
 *
 * ## Why this SURFACES and never blocks
 *
 * A suppression is sometimes the correct engineering call. If `save()` genuinely
 * accepts `bytes`, the ANNOTATION is what is wrong and an `arg-type` ignore is a
 * reasonable stopgap. A hard block would refuse the legitimate cases and push a
 * model toward some other evasion (a wider type, a deleted assertion) that no
 * scanner can see at all. So this module produces a REPORT and nothing else: it
 * feeds one field on the sprint's plan-adherence artifact and one transcript
 * line. It changes no verdict, no threshold and no commit gate.
 *
 * ## Why a suppression is NOT a `deviation`
 *
 * `AdherenceVerdict.deviations` is a claim that the sprint diverged from its
 * approved plan — it is model-authored, it is fed into the next sprint's
 * `nextFocus`, and it drives the fixer prompt. A legitimate suppression diverges
 * from nothing, so filing it there would (a) assert something untrue and (b)
 * dispatch a fixer to "conform to the plan" over a line the plan never mentioned.
 * It lives in its own clearly-labelled field instead —
 * `SprintAdherenceRecord.suppressions` — so a human reading
 * `sprints/<n>-adherence.json` sees it beside the deviations without it BEING one.
 *
 * ## Why the expect-error form is reported too
 *
 * NOTE ON SPELLING: this prose writes the two TypeScript directives as
 * `ts-ignore` and `ts-expect-error` WITHOUT their leading at-sign. That is not a
 * typo. The pre-commit `biome check --write` runs `lint/suspicious/noTsIgnore`,
 * whose fix replaces the at-prefixed ignore spelling with the at-prefixed
 * expect-error spelling ANYWHERE in a comment — including a doc comment that is
 * merely describing the difference between the two. It did exactly that to an
 * earlier draft of this block: every mention of the ignore form became the
 * expect-error form, so the paragraph below read "unlike itself it cannot
 * outlive…" and asserted nothing. It then did it a SECOND time to the sentence
 * you are reading, which had spelled them out to explain the first. The
 * at-prefixed spellings therefore survive in this file only inside the string
 * and regex literals further down, which the rule does not touch.
 *
 * `ts-expect-error` fails the build if the error disappears, so unlike
 * `ts-ignore` it cannot outlive the problem it hides. That is a staleness
 * property, not a legitimacy one: at the moment it is added it silences a real,
 * present diagnostic exactly as `ts-ignore` does, and the reviewer's question
 * ("was the code wrong, or the annotation?") is identical. It is therefore
 * reported, but never conflated: `SuppressionFinding.directive` names it
 * verbatim, so a reader can tell the self-correcting form from the permanent one
 * without this module having to rank them.
 *
 * ## Which languages, and which are left out
 *
 * The set is the verify-recipe detector table in `src/verify/recipes.ts`
 * (`detectNodeRecipe`, `detectPythonRecipe`, `detectGoRecipe`,
 * `detectRustRecipe`, `detectJavaRecipe`, `detectDotnetRecipe` — plus
 * `detectMakeRecipe`, which has no suppression concept of its own). Every one of
 * those with a suppression directive is covered below.
 *
 * Deliberately left out: shell (`# shellcheck disable=SC2086`) and Ruby
 * (`# rubocop:disable`). Neither has a detector in that table, so neither is an
 * ecosystem `/ideal` can currently scaffold or verify — adding matchers for them
 * would be unexercised code whose false positives nobody would notice. They are
 * one entry each in `LANGUAGES` if that changes.
 *
 * ## Why a mention is not a match
 *
 * A line adding `"# type: ignore"` inside a test fixture, a regex or a document
 * silences nothing. Three rules keep those out:
 *
 * 1. **Extension gating.** Only the code extensions below are scanned at all, so
 *    a `.md` / `.rst` / `.txt` line quoting a directive can never match.
 * 2. **String awareness.** `scanLineStructure` walks the line tracking `'`, `"`
 *    and backtick literals (with backslash escapes) and reports the first comment
 *    opener found OUTSIDE a string. A directive inside a string literal is
 *    therefore neither a comment nor code.
 * 3. **Position.** A comment-form directive (`# type: ignore`, `// ts-ignore`)
 *    must sit at or after that comment opener; a code-form one
 *    (`#pragma warning disable`, `[SuppressMessage]`, `@SuppressWarnings`,
 *    `#[allow]`) must sit outside every string range.
 *
 * Known limits, stated rather than hidden: a directive inside a Python
 * triple-quoted docstring reads as a comment to a per-line scanner (cross-line
 * state would be needed, and a diff hands us only the added lines), and an
 * UNESCAPED `//` inside a JS regex literal would read as a comment opener — the
 * escaped form a regex actually needs (`/\/\/ ts-ignore/`) contains no adjacent
 * `//` and is correctly ignored, which is the case pinned in the tests.
 */

/** One suppression directive added by the sprint's own diff. */
export interface SuppressionFinding {
  /** Path exactly as the diff's `+++ b/<path>` header names it, forward slashes. */
  file: string;
  /** 1-based line number in the NEW file. */
  line: number;
  /** Canonical directive name, e.g. `# type: ignore`, `// ts-expect-error`. */
  directive: string;
  /**
   * The rule name(s) the directive silences. EMPTY means the directive named
   * none — a bare `# type: ignore` silences every diagnostic on its line, which
   * is a materially wider claim than `# type: ignore[arg-type]` and is why this
   * is a list rather than a string.
   */
  rules: string[];
  /** The added line, trimmed and bounded to `SUPPRESSION_TEXT_MAX_CHARS`. */
  text: string;
}

/**
 * The result of scanning one diff. `findings` is capped; `total` is the true
 * count, so neither the renderer nor the persisted record can imply a cut list
 * is the whole list. An ABSENT scan (the field left undefined on its consumers)
 * means "no diff was scanned", which is not the same fact as
 * `{findings: [], total: 0}` — "scanned, nothing found".
 */
export interface SuppressionScan {
  findings: SuppressionFinding[];
  total: number;
}

/**
 * Cap on rendered/persisted findings, following `LSP_DETAIL_MAX_GATE`
 * (`src/lsp/manager.ts`, 20) rather than inventing a second convention. The
 * measured case had 3; 20 carries a realistic whole-file set at ≤200 chars each
 * (≈4 KB) regardless of how many a pathological sprint adds, and the omitted
 * count is always named — a SILENT cut would reproduce exactly the blindness
 * this module exists to remove.
 */
export const SUPPRESSION_DETAIL_MAX = 20;

/** Per-line budget, matching `LSP_DETAIL_MAX_MESSAGE_CHARS`. */
const SUPPRESSION_TEXT_MAX_CHARS = 200;

/** Where a directive must sit on its line to be silencing anything. */
type DirectivePosition = "comment" | "code";

interface DirectiveMatcher {
  /** Canonical name reported as `SuppressionFinding.directive`. */
  directive: string;
  position: DirectivePosition;
  pattern: RegExp;
  /** Pull the silenced rule names out of the match. `[]` = names none. */
  rules: (match: RegExpExecArray) => string[];
}

interface LanguageProfile {
  extensions: string[];
  /**
   * Comment openers for this language. `scanLineStructure` takes the FIRST one
   * that matches at a position, so a language whose openers share a prefix must
   * list the longer one first. The current set has no such pair (`//` and `/*`
   * are the same length and mutually exclusive at any one offset).
   */
  commentTokens: string[];
  matchers: DirectiveMatcher[];
}

const NO_RULES = (): string[] => [];

/** Split a comma/whitespace separated rule list, dropping empties. */
function splitRules(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * Pull every quoted string out of an annotation argument list —
 * `@SuppressWarnings({"unchecked", "rawtypes"})`,
 * `[SuppressMessage("Design", "CA1031:…")]`. Positive pattern (a quote, the
 * shortest run to the next quote) rather than a negated class, because the
 * pre-commit `biome check --write` rewrites a negated class containing a
 * literal backslash and silently changes its semantics.
 */
function quotedArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const re = /"(.*?)"/g;
  let m = re.exec(raw);
  while (m) {
    const val = m[1]?.trim();
    if (val) out.push(val);
    m = re.exec(raw);
  }
  return out;
}

/** `# type: ignore[a, b]` / `# noqa: A1,B2` / `//nolint:x,y` bracket-or-colon rule lists. */
const PY_TYPE_IGNORE: DirectiveMatcher = {
  directive: "# type: ignore",
  position: "comment",
  pattern: /#\s*type:\s*ignore(?:\[(.*?)\])?/,
  rules: (m) => splitRules(m[1]),
};

const PY_NOQA: DirectiveMatcher = {
  directive: "# noqa",
  position: "comment",
  pattern: /#\s*noqa(?::\s*([A-Za-z0-9,\s]*))?/,
  rules: (m) => splitRules(m[1]),
};

const PY_PYRIGHT_IGNORE: DirectiveMatcher = {
  directive: "# pyright: ignore",
  position: "comment",
  pattern: /#\s*pyright:\s*ignore(?:\[(.*?)\])?/,
  rules: (m) => splitRules(m[1]),
};

const TS_EXPECT_ERROR: DirectiveMatcher = {
  directive: "// @ts-expect-error",
  position: "comment",
  pattern: /@ts-expect-error/,
  rules: NO_RULES,
};

const TS_IGNORE: DirectiveMatcher = {
  directive: "// @ts-ignore",
  position: "comment",
  pattern: /@ts-ignore/,
  rules: NO_RULES,
};

const TS_BIOME_IGNORE: DirectiveMatcher = {
  directive: "// biome-ignore",
  position: "comment",
  pattern: /biome-ignore\s+(.*?):/,
  rules: (m) => splitRules(m[1]),
};

/**
 * `eslint-disable-next-line` and `-line` are matched ahead of the bare
 * `eslint-disable` so the more specific directive is the one reported.
 */
const TS_ESLINT_NEXT_LINE: DirectiveMatcher = {
  directive: "// eslint-disable-next-line",
  position: "comment",
  pattern: /eslint-disable-next-line\s*([A-Za-z0-9@/_,\s-]*)/,
  rules: (m) => splitRules(m[1]),
};

const TS_ESLINT_LINE: DirectiveMatcher = {
  directive: "// eslint-disable-line",
  position: "comment",
  pattern: /eslint-disable-line\s*([A-Za-z0-9@/_,\s-]*)/,
  rules: (m) => splitRules(m[1]),
};

const TS_ESLINT_DISABLE: DirectiveMatcher = {
  directive: "// eslint-disable",
  position: "comment",
  pattern: /eslint-disable\s*([A-Za-z0-9@/_,\s-]*)/,
  rules: (m) => splitRules(m[1]),
};

const GO_NOLINT: DirectiveMatcher = {
  directive: "//nolint",
  position: "comment",
  pattern: /\/\/\s*nolint(?::\s*([A-Za-z0-9,\s_-]*))?/,
  rules: (m) => splitRules(m[1]),
};

const CS_PRAGMA_DISABLE: DirectiveMatcher = {
  directive: "#pragma warning disable",
  position: "code",
  pattern: /#pragma\s+warning\s+disable\s*([A-Za-z0-9,\s]*)/,
  rules: (m) => splitRules(m[1]),
};

const CS_SUPPRESS_MESSAGE: DirectiveMatcher = {
  directive: "[SuppressMessage]",
  position: "code",
  pattern: /\[(?:System\.Diagnostics\.CodeAnalysis\.)?SuppressMessage\((.*?)\)\]/,
  rules: (m) => quotedArgs(m[1]),
};

const JAVA_SUPPRESS_WARNINGS: DirectiveMatcher = {
  directive: "@SuppressWarnings",
  position: "code",
  pattern: /@SuppressWarnings\s*\((.*?)\)/,
  rules: (m) => quotedArgs(m[1]),
};

const RUST_ALLOW: DirectiveMatcher = {
  directive: "#[allow]",
  position: "code",
  pattern: /#!?\[allow\((.*?)\)\]/,
  rules: (m) => splitRules(m[1]),
};

const TS_MATCHERS = [
  TS_EXPECT_ERROR,
  TS_IGNORE,
  TS_BIOME_IGNORE,
  TS_ESLINT_NEXT_LINE,
  TS_ESLINT_LINE,
  TS_ESLINT_DISABLE,
];

const LANGUAGES: LanguageProfile[] = [
  {
    extensions: ["py", "pyi"],
    commentTokens: ["#"],
    matchers: [PY_TYPE_IGNORE, PY_PYRIGHT_IGNORE, PY_NOQA],
  },
  {
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    commentTokens: ["//", "/*"],
    matchers: TS_MATCHERS,
  },
  { extensions: ["cs"], commentTokens: ["//", "/*"], matchers: [CS_PRAGMA_DISABLE, CS_SUPPRESS_MESSAGE] },
  { extensions: ["go"], commentTokens: ["//", "/*"], matchers: [GO_NOLINT] },
  { extensions: ["java"], commentTokens: ["//", "/*"], matchers: [JAVA_SUPPRESS_WARNINGS] },
  { extensions: ["rs"], commentTokens: ["//", "/*"], matchers: [RUST_ALLOW] },
];

const LANGUAGE_BY_EXTENSION = new Map<string, LanguageProfile>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) LANGUAGE_BY_EXTENSION.set(ext, lang);
}

function languageFor(file: string): LanguageProfile | undefined {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANGUAGE_BY_EXTENSION.get(base.slice(dot + 1).toLowerCase());
}

const QUOTE_CHARS = new Set(["'", '"', "`"]);

/**
 * Walk a source line once, recording every string-literal range and the offset
 * of the first comment opener that is NOT inside one. Written as a character
 * loop rather than a regex on purpose: the pre-commit `biome check --write`
 * rewrites a negated character class containing a literal backslash, which is
 * exactly the shape a "not a quote, not an escape" regex would need.
 */
function scanLineStructure(
  line: string,
  commentTokens: string[],
): { commentStart: number | null; stringRanges: Array<[number, number]> } {
  const stringRanges: Array<[number, number]> = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (QUOTE_CHARS.has(ch)) {
      const start = i;
      i += 1;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      stringRanges.push([start, Math.min(i, line.length)]);
      continue;
    }
    for (const token of commentTokens) {
      if (line.startsWith(token, i)) return { commentStart: i, stringRanges };
    }
    i += 1;
  }
  return { commentStart: null, stringRanges };
}

function insideAnyString(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Bound one added line for the record. */
function boundText(text: string): string {
  const t = text.trim();
  return t.length > SUPPRESSION_TEXT_MAX_CHARS ? `${t.slice(0, SUPPRESSION_TEXT_MAX_CHARS)}…` : t;
}

/**
 * EVERY directive that really sits in a comment (or in code, per its `position`)
 * on this added line, in the order they appear on it.
 *
 * One line can carry two independent suppressions, and the measured commit does:
 * `from shared.contracts.artifact_store import (  # noqa: F401  # type: ignore[import]`
 * silences a flake8 rule AND a pyright one. Reporting only the first would
 * understate that commit by two findings, so OVERLAP — not order — is what
 * excludes a match: a matcher whose hit overlaps an already-accepted one is
 * dropped, which is how `// eslint-disable-next-line foo` is counted once rather
 * than also matching the bare `eslint-disable` prefix inside it. `LANGUAGES`
 * therefore lists the more specific directive of an overlapping pair FIRST.
 */
function matchAddedLine(line: string, lang: LanguageProfile): Array<{ matcher: DirectiveMatcher; rules: string[] }> {
  const { commentStart, stringRanges } = scanLineStructure(line, lang.commentTokens);
  const accepted: Array<{ at: number; end: number; matcher: DirectiveMatcher; rules: string[] }> = [];
  for (const matcher of lang.matchers) {
    const m = matcher.pattern.exec(line);
    if (!m) continue;
    const at = m.index;
    const end = at + m[0].length;
    if (insideAnyString(at, stringRanges)) continue;
    if (matcher.position === "comment") {
      if (commentStart === null || at < commentStart) continue;
    } else if (commentStart !== null && at > commentStart) {
      continue;
    }
    if (accepted.some((a) => at < a.end && a.at < end)) continue;
    accepted.push({ at, end, matcher, rules: matcher.rules(m) });
  }
  accepted.sort((a, b) => a.at - b.at);
  return accepted.map(({ matcher, rules }) => ({ matcher, rules }));
}

/** Strip the `a/` or `b/` prefix and any surrounding quotes git added. */
function normalizeDiffPath(raw: string): string | null {
  let p = raw.trim();
  // `git diff` quotes a path containing unusual bytes; the quotes are not part of it.
  if (p.startsWith('"') && p.endsWith('"') && p.length > 1) p = p.slice(1, -1);
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p.replace(/\\/g, "/");
}

/**
 * Scan a unified diff for suppression directives on its ADDED lines only.
 *
 * The diff is the caller's — `runPlanAdherenceReview` passes the SAME
 * `git diff HEAD` text it already read for the reviewer prompt, so this can
 * never disagree with the reviewer about what the sprint changed. A context
 * line (a suppression that was already in the file) and a removed line are both
 * ignored: they are not this sprint's doing.
 */
export function scanDiffForSuppressions(diff: string): SuppressionScan {
  const findings: SuppressionFinding[] = [];
  let total = 0;
  let file: string | null = null;
  let lang: LanguageProfile | undefined;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      file = null;
      lang = undefined;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      // The `+++` header only precedes the first `@@`; inside a hunk a `+++`
      // is an added line whose content happens to start with `++`.
      file = normalizeDiffPath(raw.slice(4));
      lang = file ? languageFor(file) : undefined;
      continue;
    }
    if (raw.startsWith("@@")) {
      inHunk = true;
      const hunk = /\+(\d+)/.exec(raw);
      newLine = hunk ? Number.parseInt(hunk[1] as string, 10) : 1;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("+")) {
      const content = raw.slice(1);
      if (file && lang) {
        for (const hit of matchAddedLine(content, lang)) {
          total += 1;
          if (findings.length < SUPPRESSION_DETAIL_MAX) {
            findings.push({
              file,
              line: newLine,
              directive: hit.matcher.directive,
              rules: hit.rules,
              text: boundText(content),
            });
          }
        }
      }
      newLine += 1;
      continue;
    }
    // Context line (leading space) — and a bare empty line, which some diff
    // producers emit for an empty context line.
    newLine += 1;
  }

  return { findings, total };
}

/**
 * Render a scan for the sprint transcript, or null when there is nothing to
 * report. Never says "fix this": the report's whole job is to let a human decide
 * whether the CODE or the ANNOTATION was the wrong thing.
 */
export function formatSuppressionNote(scan: SuppressionScan): string | null {
  if (scan.total === 0) return null;
  const lines = [
    `\n> [adherence] ${scan.total} suppression directive(s) added in this sprint's diff — each silences a ` +
      `diagnostic rather than resolving it. Not a failure: review whether the code or the annotation was wrong.\n`,
  ];
  for (const f of scan.findings) {
    const what =
      f.rules.length > 0 ? `silences ${f.rules.join(", ")}` : "silences EVERY diagnostic on the line (no rule named)";
    lines.push(`  - ${f.file}:${f.line} — \`${f.directive}\` ${what}\n`);
  }
  const omitted = scan.total - scan.findings.length;
  if (omitted > 0) lines.push(`  (+${omitted} more not shown)\n`);
  return lines.join("");
}
