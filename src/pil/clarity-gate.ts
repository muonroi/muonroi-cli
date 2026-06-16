/**
 * src/pil/clarity-gate.ts
 *
 * Phase 2 (2026-06-16): the regex/keyword ASK gate (`shouldAutoPass`,
 * `canInferOutcome`, and the per-modality scope detectors) was removed. The
 * configured chat model is now the sole decider of whether a turn needs
 * clarification — see `proposeModelGaps` in `discovery.ts`. Keyword heuristics
 * deciding what/whether to ask were "bad bad bad UX" (miss billions of cases)
 * per the user directive; there is no regex fallback by design.
 *
 * Two helpers survive because they are NOT ask-gating:
 *   - `detectNoClarifySignal` — honours an explicit USER instruction ("don't
 *     ask" / "đừng hỏi"). That is user consent, not classification.
 *   - `hasOperationalScope` — used only by `getAutofilledOutcome` to pick a
 *     better outcome LABEL for CI/build/deploy debug turns (output polish, not
 *     a decision about whether to interview).
 */

/**
 * Operational-domain detector (CI / deploy / build / lint). Used by
 * `getAutofilledOutcome` to refine the resolved outcome label for pipeline
 * debug turns; it no longer gates any askcard.
 */
export function hasOperationalScope(raw: string): boolean {
  return /\b(ci|cd|build|deploy(?:ment)?|action(?:s)?|workflow|pipeline|lint|tests?|coverage|gh\s+(check|run|workflow))\b/i.test(
    raw,
  );
}

// The user explicitly told the agent NOT to clarify ("don't ask", "trả lời
// thẳng"). When present, discovery skips ALL interview + acceptance cards. Narrow
// on purpose: the idiom "don't ask me why" (seeking an explanation, not a
// directive to skip questions) is excluded via a negative lookahead. EN + VI
// (with diacritics + bare-ASCII transliterations).
const NO_CLARIFY_RE =
  /\b(?:don'?t|do not)\s+ask(?!\s+me\s+(?:why|how|what))\b|\bno\s+(?:questions?|clarif(?:ication|ying)|interview)\b|\bwithout\s+asking\b|\bjust\s+answer\b|\banswer\s+(?:me\s+)?directly\b|\bstop\s+asking\b|đừng\s+hỏi|không\s+(?:cần\s+)?hỏi|khỏi\s+hỏi|trả\s+lời\s+(?:thẳng|luôn|liền|ngay|trực\s*tiếp)|\bdung\s+hoi\b|\bkhong\s+(?:can\s+)?hoi\b|\btra\s+loi\s+(?:thang|luon|lien|ngay)\b/i;

export function detectNoClarifySignal(raw: string): boolean {
  return !!raw && NO_CLARIFY_RE.test(raw);
}
