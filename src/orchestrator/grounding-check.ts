/**
 * src/orchestrator/grounding-check.ts
 *
 * Summary-phase grounding validator (the runtime half of the Agent Operating
 * Contract — see src/pil/agent-operating-contract.ts for the prompt half).
 *
 * At turn finalize, the orchestrator scans the model's FINAL synthesis text for
 * factual claims that are cheap to fabricate and high-impact when wrong:
 *   - exact COUNTS ("67 tests", "1,273 commits"), and
 *   - FILE:LINE references ("app.tsx:836"),
 * then cross-references them against the corpus of tool outputs produced THIS
 * turn. A claim whose value never appears in any tool output is "unverified".
 *
 * Behaviour is SOFT-FLAG only: the caller emits a `grounding-flag` event and a
 * warn toast, and may append an advisory footnote. It never blocks the turn or
 * rewrites the model's text. The classic case it catches: deepseek-v4-flash
 * reporting "67 tests" (actual 401) with no command output containing 67.
 *
 * This module is PURE (no I/O, no globals) so it is trivially unit-testable; the
 * caller builds the corpus string and handles the env gate / chitchat skip.
 *
 * Designed for LOW false positives because it can surface a user-visible toast
 * on EVERY tier:
 *   - only integers >= 10 (single digits are too common to be claims),
 *   - only when immediately followed by a recognised count noun,
 *   - hedged/approximate numbers ("~130,220", "about 500") are skipped — they
 *     are presented as estimates, not asserted facts,
 *   - percentages / multipliers / versions / money never match (no whitespace
 *     after the digit, or excluded by the count-noun requirement),
 *   - file:line only flags when the file name is absent from the corpus.
 */

export interface UnverifiedClaim {
  kind: "count" | "fileline";
  /** Normalised claim value: "67", "1273", or "app.tsx:836". */
  value: string;
  /** The literal claim text as written, e.g. "67 tests" or "app.tsx:836". */
  text: string;
}

const MAX_CLAIMS = 5;

// Count nouns whose preceding integer is a verifiable codebase metric.
const COUNT_NOUN =
  "tests?|specs?|files?|commits?|lines?|errors?|warnings?|modules?|packages?|functions?|classes?|methods?|dependencies|deps|endpoints?|routes?|components?|contributors?|branches?|tables?|columns?|rows?|occurrences?|matches?|references?|callers?|imports?|exports?|todos?|issues?";

// number (2+ digits, or thousands-separated) + up to 2 filler words + count noun.
const COUNT_RE = new RegExp(`\\b(\\d{1,3}(?:,\\d{3})+|\\d{2,})\\b(?:\\s+(?:\\w+\\s+){0,2}?)(?:${COUNT_NOUN})\\b`, "gi");

// filename.ext:line — basename only (the char class excludes "/").
const FILELINE_RE = /\b([\w.-]+\.[a-z]{1,5}):(\d+)\b/gi;

// Hedge markers immediately before a number mean it is an estimate, not a fact.
const HEDGE_RE = /(~|≈|\babout\b|\bapprox(?:imately)?\b|\broughly\b|\baround\b|\bnearly\b|\best\.?\b)\s*$/i;

function stripCommas(s: string): string {
  return s.replace(/,/g, "");
}

/**
 * Find factual claims in `finalText` that are NOT supported by `corpus` (the
 * concatenation of this turn's tool outputs). Returns at most MAX_CLAIMS,
 * deduped by (kind, value).
 */
export function findUnverifiedClaims(finalText: string, corpus: string): UnverifiedClaim[] {
  if (!finalText) return [];
  const corpusNorm = stripCommas(corpus).toLowerCase();
  const corpusLower = corpus.toLowerCase();
  const out: UnverifiedClaim[] = [];
  const seen = new Set<string>();

  const push = (claim: UnverifiedClaim) => {
    const key = `${claim.kind}:${claim.value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(claim);
  };

  // --- Count claims ---
  for (const m of finalText.matchAll(COUNT_RE)) {
    if (out.length >= MAX_CLAIMS) break;
    const raw = m[1]!;
    const idx = m.index ?? 0;
    // Skip hedged numbers (the chars right before the digit say "estimate").
    const before = finalText.slice(Math.max(0, idx - 16), idx);
    if (HEDGE_RE.test(before)) continue;
    const norm = stripCommas(raw);
    if (corpusNorm.includes(norm)) continue; // value appears in a tool output → verified
    push({ kind: "count", value: norm, text: m[0]!.trim() });
  }

  // --- file:line claims ---
  for (const m of finalText.matchAll(FILELINE_RE)) {
    if (out.length >= MAX_CLAIMS) break;
    const idx = m.index ?? 0;
    // Skip path/URL/port shapes ("http://host:8080", "a/b.ts:1" handled by basename).
    if (idx > 0 && finalText[idx - 1] === "/") continue;
    const basename = m[1]!;
    if (corpusLower.includes(basename.toLowerCase())) continue; // file was read/grepped → verified
    push({ kind: "fileline", value: `${basename}:${m[2]}`, text: `${basename}:${m[2]}` });
  }

  return out.slice(0, MAX_CLAIMS);
}

/**
 * Build an advisory footnote for the flagged claims. Non-accusatory — the
 * numbers MAY be legitimately derived; the note just asks the user to confirm.
 * Returns "" when there are no claims.
 */
export function buildGroundingFootnote(claims: UnverifiedClaim[]): string {
  if (claims.length === 0) return "";
  const list = claims.map((c) => c.text).join(", ");
  return `\n\n> ⚠ Unverified (not found in this turn's tool output): ${list}. These may be derived — confirm before relying on them.`;
}
