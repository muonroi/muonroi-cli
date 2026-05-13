import type { Criterion } from "./types.js";

export type { Criterion } from "./types.js";

/**
 * Reality Anchor implements evidence verification for Definition-of-Done criteria.
 * It ensures that claims of "met" or "partial" status are backed by concrete evidence.
 */

/**
 * Validates whether a given piece of evidence text matches one of the 5 allowed forms.
 * 1. file:line (e.g., src/sync.ts:42)
 * 2. test name (e.g., test('handles empty input'))
 * 3. commit sha (7-40 hex chars)
 * 4. benchmark (e.g., p95: 240ms)
 * 5. HTTP test (e.g., GET /api/users → 200)
 */
export function evidenceLooksValid(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  const patterns = [
    /\b\w+\.(ts|tsx|js|py|go|rs|java):\d+/,
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
