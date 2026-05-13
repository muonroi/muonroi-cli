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
 * Parses a ToolResult from the verify sub-agent into a deterministic verdict.
 *
 * PASS when: tr.success is true AND output contains a pass marker
 * FAIL when: tr.success is false OR output contains a fail marker
 * ERROR when: tr.error is present and non-empty
 * UNKNOWN when: none of the above match
 */
export function parseVerifyResult(tr: ToolResult): VerifyVerdict {
  if (tr.error && tr.error.trim().length > 0) {
    return "ERROR";
  }

  const output = tr.output || "";
  const hasPassMarker = output.includes(VERIFY_PASS_MARKER) || output.includes(VERIFY_CHECK_MARKER);
  const hasFailMarker = output.includes(VERIFY_FAIL_MARKER);

  if (tr.success === true && hasPassMarker) {
    return "PASS";
  }

  if (tr.success === false || hasFailMarker) {
    return "FAIL";
  }

  return "UNKNOWN";
}
