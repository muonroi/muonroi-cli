/**
 * Build the ONE transcript record for an answered council askcard (U1).
 *
 * Before this existed, answering a card produced TWO independent renders and
 * NEVER showed the question: the UI's own optimistic bubble
 * (`use-app-logic.tsx`'s askcard answer branch) plus the council generator's
 * own `\n  ↳ <answer>\n` echo (`clarifier.ts` / `council/index.ts`) both
 * landed in the transcript, and neither carried the question text — the
 * question lives only on the live `CouncilQuestionCard`, which unmounts the
 * instant it is answered. Re-observed live twice (2026-09-15, 2026-09-17;
 * see `project_askcard_transcript_qa_pairing` memory).
 *
 * Fix: the UI site now owns the transcript record (it is immediate and
 * survives a run that dies mid-stream), and the generator echo is gated off
 * whenever the answer carried a question (see `QuestionResponder.
 * wasAnsweredByCard` in `src/council/types.ts` + `CouncilManager
 * .respondToQuestion`) — the same "no human is rendering this a second time"
 * shape as the existing `sprintPlanningMode` echo gate in `council/index.ts`.
 * Headless never passes a question, so its `wasAnsweredByCard` check is
 * always false and its echo is untouched.
 *
 * Design: ONE compact block, not two boxes — `ChatEntry.sourceLabel` already
 * renders as a dim/muted line directly above `content` inside the SAME user
 * bubble (`message-view.tsx`'s `case "user"`), so the question becomes the
 * label and the answer stays the entry's content. No new rendering surface.
 *
 * Extracted as a plain, typed, independently-testable function (not inlined
 * in the hook) because `use-app-logic.tsx` is `@ts-nocheck` — a wrong
 * argument here would fail silently at runtime, not at compile time. Mirrors
 * the `sprint-failed-halt.ts` pattern.
 */
import type { ChatEntry, CouncilQuestionData } from "../types/index.js";
import { formatQuestionCounter } from "./components/council-question-card.js";
import { buildUserEntry, formatAnswerForLog } from "./utils/format.js";

/** Same shape `formatAnswerForLog` already takes — kept separate so this module has no new coupling. */
export interface AskcardAnswerContext {
  selectedOptionLabel?: string;
  questionId?: string;
}

/**
 * The muted label line shown above the answer, e.g.
 * `"2 / 3 · Roslyn analyzer compile-time chuẩn hay dùng dotnet format?"`.
 * Reuses `formatQuestionCounter` (the live `CouncilQuestionCard`'s own "n / m"
 * counter) so the transcript record matches the card's own convention exactly
 * — including "" for a single-question round, where a "1 / 1" counter is
 * noise, not information.
 *
 * `undefined` when there is no question to pair (defensive — every real
 * askcard sets `.question`, but `use-app-logic.tsx` is `@ts-nocheck` so a
 * stale/absent reference must not throw).
 */
export function formatAskcardQuestionLabel(question: CouncilQuestionData | undefined | null): string | undefined {
  if (!question) return undefined;
  const text = question.question?.trim();
  if (!text) return undefined;
  const counter = formatQuestionCounter(question);
  return counter ? `${counter} · ${text}` : text;
}

/**
 * Build the single `ChatEntry` for an answered askcard: the question as
 * `sourceLabel`, the answer as `content` (via the existing
 * `formatAnswerForLog`, unchanged so the answer's own formatting — e.g.
 * `accept · productType="internal-tool"` — is not touched by this fix).
 *
 * Callers still own the `isNoopSkip` decision (whether to push this entry to
 * `messages` at all) — that guard is unrelated to the question/answer pairing
 * and stays exactly where it is in `use-app-logic.tsx`.
 */
export function buildAskcardAnswerEntry(
  question: CouncilQuestionData | undefined | null,
  ans: { kind: string; text: string },
  ctx: AskcardAnswerContext,
): ChatEntry {
  const content = formatAnswerForLog(ans, ctx);
  const sourceLabel = formatAskcardQuestionLabel(question);
  return buildUserEntry(content, sourceLabel ? { sourceLabel } : {});
}
