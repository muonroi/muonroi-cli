/**
 * src/council/prior-synthesis.ts
 *
 * Evidence rule for a SETTLED prior council synthesis: parses and scores a
 * `[Council Memory] {...}` record — the code-authored, structured artifact
 * `runCouncil` persists (via `appendSystemMessage`, see council/index.ts) at
 * the end of every completed debate. Only a message matching that exact
 * prefix, with valid JSON and non-empty `topic`/`synthesis`, counts as
 * evidence — never a fuzzy scan of assistant prose.
 *
 * Why this exists (session 115a59c9bb9e -> child 49f6b8c1d8d6, 2026-09-23):
 * a parent session ran a full council debate to an "Agreed Integration
 * Architecture" synthesis. The user's very next message ("ok, proceed to
 * implement per the plan, with a sub-agent") forked a child sub-session —
 * yet the child re-ran a FRESH 4-round debate that reproduced nearly the
 * same conclusion, at real dollar cost, before doing any implementation
 * work.
 *
 * The single consumer is `findSettledSynthesisInSessionChain` in
 * src/orchestrator/settled-synthesis-gate.ts, which reads the marker from
 * the session's DB parent chain (`appendSystemMessage` is DB-only — nothing
 * ever pushes it into the orchestrator's in-memory `this.messages`, so an
 * in-memory scan cannot detect the fork case this exists for; see that
 * module's doc for the full reasoning and why an in-memory path was removed
 * rather than kept as a second, redundant definition of "what counts as
 * evidence").
 *
 * Topic-similarity is NOT the discriminator (measured against the real
 * incident and rejected): a `[Council Memory]` record's `topic` is the RAW
 * user message that triggered the debate ("ok bây giờ bạn đi vào mode
 * council để bàn luận..."), while the current turn's topic is a DIFFERENT
 * later message ("ok tiến hành implement theo plan kết hợp sub agent") — two
 * sentences describing "what the user wants done now" at two different
 * points, which structurally do not overlap lexically even when the second
 * is squarely "go build what we just agreed on". Measured Jaccard
 * similarity on the real pair: 0.032. `similarity` is still computed and
 * returned here for observability (decision-log meta), but callers must not
 * veto on it — the actual discriminators are structural: is this turn
 * implementation-shaped (pil/turn-intent.ts), and is the record recent
 * enough (settled-synthesis-gate.ts's RECENCY_BOUND_MS).
 */

import type { CouncilMemoryRecord } from "./types.js";

export interface PriorSynthesisEvidence {
  /** True when a valid `[Council Memory]` record was found (topic match is NOT required — see module doc). */
  found: boolean;
  /** The topic recorded on the council memory entry that was inspected. */
  recordTopic?: string;
  /** First 2000 chars of the record's synthesis — enough to hand forward as settled input. */
  synthesisExcerpt?: string;
  /** Jaccard token-overlap between `recordTopic` and `currentTopic` — observability only, never a veto. */
  similarity?: number;
}

/** Drop tokens too short to be distinctive (articles, short verbs, etc.). */
const MIN_TOKEN_LENGTH = 3;

/**
 * Common filler words that would otherwise inflate overlap between two
 * genuinely unrelated topics (e.g. "the", "and" appear in almost any English
 * sentence). Deliberately small and conservative — this is a noise filter,
 * not a language-detection step.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "using",
  "from",
  "this",
  "that",
  "into",
  "are",
  "was",
  "were",
  "been",
  "have",
  "has",
  "had",
  "you",
  "your",
  "not",
  "but",
  "all",
  "can",
  "will",
]);

function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(matches.filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** The literal, code-authored prefix `runCouncil` writes via `appendSystemMessage`. */
export const COUNCIL_MEMORY_MARKER = "[Council Memory] ";

export interface CouncilMemoryCandidate {
  topic: string;
  synthesis: string;
}

/**
 * Parse a raw message content string as a `[Council Memory]` record. Returns
 * `null` when the string does not carry the marker, is not valid JSON, or has
 * an empty `topic`/`synthesis` (malformed or an in-progress record — no real
 * evidence of a settled outcome).
 */
export function parseCouncilMemoryRecord(content: string): CouncilMemoryCandidate | null {
  if (!content.startsWith(COUNCIL_MEMORY_MARKER)) return null;

  let parsed: Partial<CouncilMemoryRecord> | null = null;
  try {
    parsed = JSON.parse(content.slice(COUNCIL_MEMORY_MARKER.length)) as Partial<CouncilMemoryRecord>;
  } catch (err) {
    console.error(`[council/prior-synthesis] failed to parse [Council Memory] record: ${(err as Error).message}`);
    return null;
  }

  const topic = typeof parsed?.topic === "string" ? parsed.topic.trim() : "";
  const synthesis = typeof parsed?.synthesis === "string" ? parsed.synthesis.trim() : "";
  if (!topic || !synthesis) return null;
  return { topic, synthesis };
}

/**
 * Build the evidence verdict for a single valid `[Council Memory]` candidate.
 * `currentTopic` is used ONLY to compute `similarity` for observability — it
 * is NOT a discriminator (see module doc: measured 0.032 on the real
 * incident pair). A valid candidate (non-empty topic + synthesis, already
 * guaranteed by `parseCouncilMemoryRecord`) always yields `found: true`
 * here; the caller applies the real discriminators (turn-intent, recency).
 */
export function evaluateCouncilMemoryCandidate(
  candidate: CouncilMemoryCandidate,
  currentTopic: string,
): PriorSynthesisEvidence {
  const similarity = jaccard(tokenize(candidate.topic), tokenize(currentTopic));
  return {
    found: true,
    recordTopic: candidate.topic,
    synthesisExcerpt: candidate.synthesis.slice(0, 2000),
    similarity,
  };
}
