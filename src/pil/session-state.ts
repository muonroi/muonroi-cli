/**
 * src/pil/session-state.ts
 *
 * Per-session turn counter and discovery memo. PIL discovery (Layer 1.6
 * Clarity Interview + Layer 1.8 Acceptance) was originally stateless across
 * turns — every user prompt re-ran gap detection from scratch, with no
 * awareness that the user had already had N exchanges in the same session.
 *
 * Evidence (session 1f29e238a816): user typed "Can you fix it?" as a
 * follow-up after a completed CI-fix task. PIL classified the short
 * pronoun-prompt as taskType=debug, detected a scope gap ("no file
 * referenced"), and fired an interview askcard. When the user re-typed
 * their intent as freetext to the askcard, PIL treated it as a gap answer
 * rather than a fresh prompt, looping through accept/adjust → another
 * interview askcard.
 *
 * Root cause: PIL pipeline has no input that says "this is the Nth turn
 * of an ongoing conversation". This module supplies that signal. The
 * discovery layer can use it to short-circuit interview/acceptance on
 * continuation-style prompts.
 *
 * State lives on `globalThis.__muonroiPilSessionState` so it survives
 * across `runPipeline` calls within the same CLI process. There is no
 * persistence — restarting the CLI resets all session state, which
 * matches user mental model (a new session begins discovery from scratch).
 */

export interface PilSessionState {
  /** Number of user prompts seen in this session so far (incremented per pipeline run). */
  turnCount: number;
  /** Timestamp of the most-recent accepted discovery; null if no discovery has been accepted yet. */
  lastAcceptedDiscoveryAt: number | null;
}

interface PilSessionGlobals {
  __muonroiPilSessionState?: Map<string, PilSessionState>;
}

function getMap(): Map<string, PilSessionState> {
  const g = globalThis as PilSessionGlobals;
  let map = g.__muonroiPilSessionState;
  if (!(map instanceof Map)) {
    map = new Map<string, PilSessionState>();
    g.__muonroiPilSessionState = map;
  }
  return map;
}

export function getSessionState(sessionId: string | null | undefined): PilSessionState | null {
  if (!sessionId) return null;
  return getMap().get(sessionId) ?? null;
}

/**
 * Bump the turn counter for `sessionId`. Called once per `runPipeline`
 * invocation. The post-increment count is returned so the caller can act
 * on "first turn" (count===1) vs "follow-up" (count>1) without a second
 * lookup.
 */
export function bumpSessionTurn(sessionId: string | null | undefined): number {
  if (!sessionId) return 1;
  const map = getMap();
  const prior = map.get(sessionId);
  const next: PilSessionState = {
    turnCount: (prior?.turnCount ?? 0) + 1,
    lastAcceptedDiscoveryAt: prior?.lastAcceptedDiscoveryAt ?? null,
  };
  map.set(sessionId, next);
  return next.turnCount;
}

export function markDiscoveryAccepted(sessionId: string | null | undefined, at = Date.now()): void {
  if (!sessionId) return;
  const map = getMap();
  const prior = map.get(sessionId);
  map.set(sessionId, {
    turnCount: prior?.turnCount ?? 1,
    lastAcceptedDiscoveryAt: at,
  });
}

/** Test helper — clear all session state. Not exported for production use. */
export function _resetForTests(): void {
  (globalThis as PilSessionGlobals).__muonroiPilSessionState = undefined;
}

/**
 * Heuristic: is `raw` likely a continuation of a prior turn rather than a
 * fresh task description?
 *
 * Hits when the prompt is short AND either:
 *   - starts with a request modal that refers to prior context ("can you",
 *     "could you", "please", "now", "also", "what about", "try", "again",
 *     "redo", "do it", "fix it", "tiếp", "làm tiếp", "vậy thì")
 *   - contains a context pronoun ("it", "this", "that", "those", "them",
 *     "nó", "cái đó", "cái này") without any concrete noun anchor
 *
 * Does NOT match long detailed prompts even if they start with "can you"
 * (those genuinely describe a new task). The 80-char cap is empirically
 * tuned: real follow-ups in chat-export samples were 8-50 chars; new
 * task prompts averaged >100 chars.
 */
// ASCII-only prefix patterns. Vietnamese phrases are matched separately via
// lowercase substring checks because the JS `\b` boundary is ASCII-aware and
// fires inside multi-byte characters, breaking simple "starts with this
// phrase" intent. Splitting the two paths keeps each predicate simple and
// easy to reason about in unit tests.
const FOLLOW_UP_PREFIX_RE =
  /^\s*(can|could|would|will)\s+you\b|^\s*please\b|^\s*(now|also|then|next)\b|^\s*(what|how)\s+about\b|^\s*(try|redo|again|do|fix)\b/i;

// ASCII pronoun anchors. Order matters — checked alongside char-length cap.
const CONTEXT_PRONOUN_RE = /\b(it|this|that|those|them)\b/i;

// Vietnamese prefix phrases. Compared via lowercased startsWith so diacritics
// match exactly without relying on \b.
const VI_PREFIX_PHRASES: ReadonlyArray<string> = [
  "tiếp",
  "tiep",
  "làm tiếp",
  "lam tiep",
  "vậy thì",
  "vay thi",
  "thế thì",
  "the thi",
  "nó ",
  "no ",
  "cái đó",
  "cai do",
  "cái này",
  "cai nay",
  "và ",
  "va ",
];

const MAX_FOLLOWUP_CHARS = 80;

export function isLikelyFollowUp(raw: string): boolean {
  const t = (raw ?? "").trim();
  if (!t || t.length > MAX_FOLLOWUP_CHARS) return false;
  if (FOLLOW_UP_PREFIX_RE.test(t)) return true;
  const lower = t.toLowerCase();
  for (const phrase of VI_PREFIX_PHRASES) {
    if (lower === phrase.trim() || lower.startsWith(phrase)) return true;
  }
  // Pronoun-only path requires the prompt to be quite short (no concrete
  // file/module name anywhere). "fix the auth flow" is NOT a follow-up;
  // "fix it" IS. Bound at 40 chars to avoid false positives.
  if (t.length <= 40 && CONTEXT_PRONOUN_RE.test(t)) return true;
  return false;
}
