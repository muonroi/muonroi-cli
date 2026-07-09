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

// count noun … : | = … number — the inverse shape ("total lines: 10026",
// "modules = 240"). Requires an explicit ':' or '=' separator so it stays a
// narrow "noun = value" assertion and never matches "line 42" prose. The span
// before the separator excludes '.' so it can't bridge across sentences.
const NOUN_SEP_NUM_RE = new RegExp(
  `\\b(?:${COUNT_NOUN})\\b[^.\\n:=]{0,40}?[:=]\\s*(\\d{1,3}(?:,\\d{3})+|\\d{2,})\\b`,
  "gi",
);

// filename.ext:line — basename only (the char class excludes "/").
const FILELINE_RE = /\b([\w.-]+\.[a-z]{1,5}):(\d+)\b/gi;

// read_file emits a header `[<path>: lines A-B of TOTAL]` (src/tools/file.ts:75).
// TOTAL is always the FULL file length (not the slice end B), so it is the
// ground truth for "does line N exist in this file". Path may use "/" or "\";
// the basename char class excludes both, so it captures just "planner.ts".
const READ_HEADER_RE = /([\w.-]+\.[a-z]{1,5}):\s*lines\s+\d+-\d+\s+of\s+(\d+)/gi;

/**
 * Map basename → largest known full-file line count, parsed from read_file
 * headers in the corpus. Used to catch a file:line that names a REAL (read)
 * file but a FABRICATED line number beyond the file's length — the failure the
 * basename-only check misses.
 */
function parseReadLineCounts(corpus: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const m of corpus.matchAll(READ_HEADER_RE)) {
    const base = m[1]!.toLowerCase();
    const total = Number.parseInt(m[2]!, 10);
    if (!Number.isFinite(total)) continue;
    const prev = totals.get(base);
    if (prev === undefined || total > prev) totals.set(base, total);
  }
  return totals;
}

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
  const readTotals = parseReadLineCounts(corpus);
  const out: UnverifiedClaim[] = [];
  const seen = new Set<string>();

  const push = (claim: UnverifiedClaim) => {
    const key = `${claim.kind}:${claim.value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(claim);
  };

  // Consider one count match: hedge-skip, corpus-check, then push.
  const considerCount = (raw: string, numberIdxInText: number, text: string) => {
    if (out.length >= MAX_CLAIMS) return;
    // Skip hedged numbers (the chars right before the digit say "estimate").
    const before = finalText.slice(Math.max(0, numberIdxInText - 16), numberIdxInText);
    if (HEDGE_RE.test(before)) return;
    const norm = stripCommas(raw);
    if (corpusNorm.includes(norm)) return; // value appears in a tool output → verified
    push({ kind: "count", value: norm, text: text.trim() });
  };

  // --- Count claims: number → noun ("67 tests") ---
  for (const m of finalText.matchAll(COUNT_RE)) {
    if (out.length >= MAX_CLAIMS) break;
    considerCount(m[1]!, m.index ?? 0, m[0]!);
  }

  // --- Count claims: noun → :|= → number ("total lines: 10026") ---
  for (const m of finalText.matchAll(NOUN_SEP_NUM_RE)) {
    if (out.length >= MAX_CLAIMS) break;
    const raw = m[1]!;
    // Locate the number within the match so the hedge look-back checks the
    // chars immediately before the digits, not before the noun.
    const numberIdxInText = (m.index ?? 0) + m[0]!.lastIndexOf(raw);
    considerCount(raw, numberIdxInText, m[0]!);
  }

  // --- file:line claims ---
  for (const m of finalText.matchAll(FILELINE_RE)) {
    if (out.length >= MAX_CLAIMS) break;
    const idx = m.index ?? 0;
    // Skip path/URL/port shapes ("http://host:8080", "a/b.ts:1" handled by basename).
    if (idx > 0 && finalText[idx - 1] === "/") continue;
    const basename = m[1]!;
    const lineNo = Number.parseInt(m[2]!, 10);
    const knownTotal = readTotals.get(basename.toLowerCase());
    // Provably-fabricated line: the file WAS read this turn (header parsed), but
    // the cited line exceeds its real length. Deterministic — flag even though
    // the basename appears in the corpus (the basename check below would pass).
    if (knownTotal !== undefined && Number.isFinite(lineNo) && lineNo > knownTotal) {
      push({
        kind: "fileline",
        value: `${basename}:${m[2]}`,
        text: `${basename}:${m[2]} (file has ${knownTotal} lines)`,
      });
      continue;
    }
    if (corpusLower.includes(basename.toLowerCase())) continue; // file was read/grepped & in-bounds → verified
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
