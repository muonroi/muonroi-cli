import type { ToolResult } from "../types/index.js";

/**
 * Markers used to identify verification success or failure in tool output.
 * These are the canonical markers for the product loop Definition-of-Done.
 */
export const VERIFY_PASS_MARKER = "VERIFY_PASS";
export const VERIFY_FAIL_MARKER = "VERIFY_FAIL";
export const VERIFY_CHECK_MARKER = "✓ all checks passed";

export type VerifyVerdict = "PASS" | "FAIL" | "ERROR" | "UNKNOWN";

/**
 * Why a verify run produced zero executed tests.
 *
 * - `load_error`   — a test file was selected but could not be imported/compiled
 *                    (bad specifier, syntax error, transform failure). The suite
 *                    is broken.
 * - `empty_selection` — the runner ran fine but matched no tests at all.
 *
 * Both block PASS. They are reported separately because they need different
 * human responses (fix the import vs. fix the glob), but neither is evidence
 * that anything was verified: the engineering floor's contract is "tests ran
 * AND passed", and zero executed assertions is zero evidence. Absence of
 * evidence must never be read as evidence of correctness.
 */
export interface NoTestsSignal {
  kind: "load_error" | "empty_selection";
  /** The runner line that proved it, for the failure reason shown to a human. */
  evidence: string;
}

/**
 * Patterns that only appear in real test-runner output, anchored tightly enough
 * that model prose ("there were no tests for this module before") does not
 * match. Ordered load-error-first so a broken import is reported as such even
 * when the runner also prints a zero-test summary line.
 */
const LOAD_ERROR_PATTERNS: RegExp[] = [
  /\bCannot find module\b[^\n]*/,
  /\bFailed to load\b[^\n]*/,
  /\bCannot find package\b[^\n]*/,
  /\bTransform failed\b[^\n]*/,
  /^\s*Test Files\s+\d+\s+failed[^\n]*/m,
];

const EMPTY_SELECTION_PATTERNS: RegExp[] = [
  /^\s*Tests\s+no tests\b[^\n]*/m, // vitest summary line
  /\bNo test files found\b[^\n]*/, // vitest / jest
  /\bcollected 0 items\b[^\n]*/, // pytest
  /\bno tests ran in [\d.]+ ?s\b[^\n]*/, // pytest summary line (not prose)
  /^\s*Total tests:\s*0\b[^\n]*/m, // dotnet vstest
  /\bRan 0 tests in\b[^\n]*/, // python unittest
  /^\s*0 passing\b[^\n]*/m, // mocha
  /\[no test files\][^\n]*/, // go test (bracketed, so prose cannot match)
];

/**
 * Detects that a verify run executed zero tests, from the runner's own output.
 *
 * Returns null when the output shows tests actually ran, or shows nothing about
 * a test run at all (callers must not treat null as "tests ran" — it only means
 * "no zero-test evidence found").
 */
export function detectNoTestsExecuted(output: string): NoTestsSignal | null {
  if (!output) return null;

  // A load error is only meaningful alongside evidence that the run produced no
  // tests; a bare "Cannot find module" inside prose about some unrelated import
  // must not fail an otherwise-good run. `Test Files N failed` is itself such
  // evidence, so either it or a zero-test summary qualifies.
  const zeroTestLine = EMPTY_SELECTION_PATTERNS.map((re) => output.match(re)?.[0]).find(Boolean);
  const failedFilesLine = output.match(/^\s*Test Files\s+\d+\s+failed[^\n]*/m)?.[0];

  if (zeroTestLine || failedFilesLine) {
    for (const re of LOAD_ERROR_PATTERNS) {
      const m = output.match(re)?.[0];
      if (m) return { kind: "load_error", evidence: m.trim() };
    }
  }

  if (zeroTestLine) {
    return { kind: "empty_selection", evidence: zeroTestLine.trim() };
  }

  return null;
}

/**
 * Parses a ToolResult from the verify sub-agent into a deterministic verdict.
 *
 * PASS when: tr.success is true AND output contains a pass marker AND the
 *            output carries no evidence that zero tests executed
 * FAIL when: tr.success is false OR output contains a fail marker OR a claimed
 *            PASS is contradicted by zero executed tests
 * ERROR when: tr.error is present and non-empty
 * UNKNOWN when: none of the above match
 *
 * The zero-test override exists because the pass markers are emitted by an LLM
 * sub-agent narrating its own run. Without it, a suite that collected no tests
 * and a suite that ran 6388 of them are the same observation to the done-gate,
 * and the engineering floor passes on a claim rather than on evidence.
 */
export function parseVerifyResult(tr: ToolResult): VerifyVerdict {
  if (tr.error && tr.error.trim().length > 0) {
    return "ERROR";
  }

  const output = tr.output || "";
  const hasPassMarker = output.includes(VERIFY_PASS_MARKER) || output.includes(VERIFY_CHECK_MARKER);
  const hasFailMarker = output.includes(VERIFY_FAIL_MARKER);

  if (tr.success === true && hasPassMarker) {
    const noTests = detectNoTestsExecuted(output);
    if (noTests) {
      console.error(
        `[verify-result] claimed PASS rejected: zero tests executed (${noTests.kind}) — ${noTests.evidence}`,
      );
      return "FAIL";
    }
    return "PASS";
  }

  if (tr.success === false || hasFailMarker) {
    return "FAIL";
  }

  return "UNKNOWN";
}
