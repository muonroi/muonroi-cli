/**
 * src/product-loop/test-failure-parse.ts
 *
 * Extracts the IDENTITY of each failing test from a test runner's own output.
 *
 * ## Why this exists
 *
 * The deterministic verify floor (`verify-floor.ts`) used to compare a test
 * command's exit code against zero. In a repository that has ANY pre-existing
 * failing test — which is most real repositories — that comparison can never be
 * satisfied, so every sprint fails for a reason no sprint caused.
 *
 * Measured: `/ideal` against `D:\sources\CompanyLibs\tcis-libraries` failed both
 * of its sprints on `failedCondition: "engineering_floor"`, score 0. The build
 * passed (32.7s, exit 0). 38 test assemblies passed. Three assemblies —
 * PostgreSql (19 tests), SqlServer (7), Kafka (5) — failed in 15-35ms each,
 * because they need a live database and broker that the machine does not run.
 * None of them were related to the analyzers the run was writing.
 *
 * To gate on the DELTA instead of the absolute, the floor needs to know WHICH
 * tests failed, not just that some did. That is this module's whole job.
 *
 * ## Design
 *
 * Every pattern is anchored to a line shape that only a real test runner emits.
 * That matters because the floor also feeds model-authored prose through
 * adjacent code paths, and a sentence like "the login test failed last week"
 * must never become a test identity. The same discipline as
 * `detectNoTestsExecuted` in `verify-result.ts`.
 *
 * The module names no project and no test. It recognises runner GRAMMARS, which
 * are properties of the tool, not of the repository under test.
 *
 * ## What a caller must do with an empty result
 *
 * An empty set from a FAILING test command means "this runner's output could not
 * be attributed", NOT "nothing failed". `verify-floor.ts` treats that as a hard
 * failure precisely so an unrecognised runner cannot be laundered into a pass.
 */

/** A runner grammar this module can read. Reported so an unattributable run can name what it saw. */
export type TestRunnerFormat = "xunit" | "vstest" | "vitest" | "jest" | "pytest" | "go" | "cargo";

export interface ParsedTestFailures {
  /** Unique, normalised, sorted failing test identities. */
  ids: string[];
  /** Which grammars contributed at least one id. Empty when nothing matched. */
  formats: TestRunnerFormat[];
}

/**
 * Strip SGR/CSI escapes so a coloured runner does not produce a distinct id from
 * a plain one. Built with `RegExp` rather than a literal because biome's
 * `noControlCharactersInRegex` rejects an ESC byte inside a regex literal.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}${String.raw`\[[0-9;]*[A-Za-z]`}`, "g");

/**
 * Trailing timing noise runners append to a test line. Removed so the SAME test
 * yields the SAME id across two runs whose durations differ — without this the
 * delta would report every pre-existing failure as new.
 */
const TRAILING_DURATION =
  /(?:\s*[[(]\s*[<>]?\s*\d+(?:[.,]\d+)?\s*(?:ms|s|m|µs|ns)\s*[\])])+$|\s+\d+(?:[.,]\d+)?\s*(?:ms|s)$/i;

interface Grammar {
  format: TestRunnerFormat;
  re: RegExp;
}

/**
 * One entry per runner grammar. Each regex is `m`-anchored and must capture the
 * test identity in group 1.
 */
const GRAMMARS: Grammar[] = [
  // xUnit console/`dotnet test` verbose:
  //   [xUnit.net 00:00:02.91]     Ns.Cls.Method [FAIL]
  //   Ns.Cls.Method(payload: "a\"b") [FAIL]
  { format: "xunit", re: /^[^\S\n]*(?:\[xUnit\.net[^\]\n]*\][^\S\n]*)?(\S[^\n]*?)[^\S\n]*\[FAIL\][^\S\n]*$/gm },

  // VSTest / `dotnet test` default reporter:
  //   Failed Ns.Cls.Method [12 ms]
  //     X Ns.Cls.Method [< 1 ms]
  { format: "vstest", re: /^[^\S\n]*(?:Failed|X)[^\S\n]+(\S[^\n]*?)[^\S\n]*\[[^\]\n]*\][^\S\n]*$/gm },

  // Vitest failure summary:
  //    FAIL  src/a.test.ts > suite > name
  //    × suite > name 3ms
  { format: "vitest", re: /^[^\S\n]*(?:FAIL|[×✕])[^\S\n]+(\S[^\n]*?)[^\S\n]*$/gm },

  // Jest failure header — the `›` separator is required so "● Console" cannot match.
  { format: "jest", re: /^[^\S\n]*●[^\S\n]+(\S[^\n]*›[^\n]*?)[^\S\n]*$/gm },

  // pytest short summary: FAILED tests/test_x.py::test_name - AssertionError
  { format: "pytest", re: /^[^\S\n]*FAILED[^\S\n]+(\S+)/gm },

  // go test: --- FAIL: TestFoo (0.00s)
  { format: "go", re: /^[^\S\n]*---[^\S\n]+FAIL:[^\S\n]+(\S+)/gm },

  // cargo test: test tests::foo ... FAILED
  { format: "cargo", re: /^[^\S\n]*test[^\S\n]+(\S+)[^\S\n]+\.\.\.[^\S\n]+FAILED[^\S\n]*$/gm },
];

/**
 * Lines that match a grammar's shape but carry a runner SUMMARY rather than a
 * test identity. Without this, vitest's `FAIL  src/a.test.ts [ src/a.test.ts ]`
 * and vstest's `Failed! - Failed: 31, Passed: 900` become "tests" whose names
 * churn between runs, and every run then looks like a regression.
 */
const SUMMARY_LINE =
  /^(?:!|Failed!|Passed!|Skipped!)|^(?:Failed|Passed|Total|Errors?):|\b(?:Failed|Passed|Total tests):\s*\d+/i;

function normalise(raw: string): string | null {
  let id = raw.trim().replace(TRAILING_DURATION, "").trim();
  // Collapse internal whitespace so indentation/alignment differences between
  // two runs cannot make the same test look like a different one.
  id = id.replace(/\s+/g, " ");
  if (id.length === 0 || id.length > 512) return null;
  if (SUMMARY_LINE.test(id)) return null;
  return id;
}

/**
 * Parse the failing-test identities out of a runner's combined stdout+stderr.
 *
 * Callers MUST pass the FULL output, not a truncated tail: a tail that clips the
 * first half of the failure list would make the missing half look newly-failing
 * on the next run.
 */
export function parseFailingTestIds(output: string): ParsedTestFailures {
  if (!output) return { ids: [], formats: [] };

  // Strip colour BEFORE matching, not after: every grammar is line-anchored, and
  // a leading SGR escape sits between the line start and the runner's own
  // prefix, so a coloured run would match nothing at all.
  const clean = output.replace(ANSI, "");

  const ids = new Set<string>();
  const formats: TestRunnerFormat[] = [];

  for (const { format, re } of GRAMMARS) {
    let hit = false;
    // Each grammar carries the `g` flag, so reset lastIndex — a module-level
    // RegExp is stateful and would skip matches on the second call otherwise.
    re.lastIndex = 0;
    for (const m of clean.matchAll(re)) {
      const id = normalise(m[1] ?? "");
      if (!id) continue;
      ids.add(id);
      hit = true;
    }
    if (hit) formats.push(format);
  }

  return { ids: [...ids].sort(), formats };
}
