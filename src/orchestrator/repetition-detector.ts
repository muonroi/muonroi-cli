/**
 * src/orchestrator/repetition-detector.ts
 *
 * Detects when the assistant text stream perseveres on the same opening
 * phrase across consecutive streamText rounds — the "YES still on scope"
 * anti-pattern observed in session 1f29e238a816 (15 consecutive bursts began
 * with the same 5-word phrase while the agent loop-failed past the natural
 * ceiling).
 *
 * The reminder system already softens past-ceiling pressure (see
 * scope-reminder.ts), but a model that latches onto a scope-acknowledgement
 * phrase will keep emitting it regardless of reminder volume. The detector
 * closes that gap with a one-shot system message asking the agent to state
 * the blocker explicitly instead of re-confirming scope.
 *
 * State lives on `globalThis.__muonroiRepetitionState: Map<sessionId, ...>`
 * so it survives across prepareStep calls but resets between CLI processes —
 * same pattern as scope-reminder soft-warn / ceiling-crossing one-shots.
 *
 * Pure functions; no side effects beyond globalThis state. The orchestrator
 * pipes assistant text into `recordAssistantBurst` after each step finishes
 * and consults `shouldInjectRepetitionReminder` from prepareStep.
 */

// 4 words captures the "YES still on scope" signature observed in session
// 1f29e238. 5+ words would have to include the varying tail ("commit pushed",
// "let me just check") and miss the perseveration pattern entirely.
const PHRASE_WORD_COUNT = 4;
const TRIGGER_RUN_LENGTH = 3;

export interface RepetitionState {
  /** Lowercased first-N words of the most-recent assistant burst, or null if not seen. */
  lastPhrase: string | null;
  /** How many consecutive bursts have started with `lastPhrase`. */
  runLength: number;
  /** True once we've injected a reminder this run — prevents re-injection on every step. */
  reminderFiredForRun: boolean;
}

interface RepetitionGlobals {
  __muonroiRepetitionState?: Map<string, RepetitionState>;
}

function getMap(): Map<string, RepetitionState> {
  const g = globalThis as RepetitionGlobals;
  let map = g.__muonroiRepetitionState;
  if (!(map instanceof Map)) {
    map = new Map<string, RepetitionState>();
    g.__muonroiRepetitionState = map;
  }
  return map;
}

/**
 * Extract the leading phrase used to detect repetition. Lowercased, trimmed,
 * punctuation-stripped to N words. Returns null when the text is empty or
 * has fewer than N usable words (don't trigger on stub one-word replies).
 */
export function extractLeadingPhrase(text: string | null | undefined): string | null {
  if (!text) return null;
  // Strip code fences first — `\`\`\`...\`\`\`` blocks are not repetition signals.
  const noFences = text.replace(/```[\s\S]*?```/g, " ");
  const cleaned = noFences
    .toLowerCase()
    .replace(/[^a-z0-9\s'À-ɏḀ-ỿ]+/g, " ")
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/);
  if (words.length < PHRASE_WORD_COUNT) return null;
  return words.slice(0, PHRASE_WORD_COUNT).join(" ");
}

/**
 * Record an assistant text burst for `sessionId` and return the updated run
 * length (1 = first burst with this phrase, 2 = matched once, ...).
 *
 * Sessions with null/empty sessionId no-op (run length always 1).
 */
export function recordAssistantBurst(sessionId: string | null | undefined, text: string | null | undefined): number {
  if (!sessionId) return 1;
  const phrase = extractLeadingPhrase(text);
  if (!phrase) {
    // Non-text burst (e.g. pure tool call) — leave state untouched so a
    // tool-call interlude between repeats does not reset the counter.
    return getMap().get(sessionId)?.runLength ?? 1;
  }
  const map = getMap();
  const prior = map.get(sessionId);
  if (prior && prior.lastPhrase === phrase) {
    const next: RepetitionState = {
      lastPhrase: phrase,
      runLength: prior.runLength + 1,
      reminderFiredForRun: prior.reminderFiredForRun,
    };
    map.set(sessionId, next);
    return next.runLength;
  }
  // New phrase — reset the run.
  map.set(sessionId, { lastPhrase: phrase, runLength: 1, reminderFiredForRun: false });
  return 1;
}

/**
 * True iff the session is in a repetition run of length >= TRIGGER_RUN_LENGTH
 * AND no reminder has been injected for the current run yet. Calling this
 * MARKS the run as fired — repeated calls inside the same run return false.
 */
export function shouldInjectRepetitionReminder(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const map = getMap();
  const state = map.get(sessionId);
  if (!state) return false;
  if (state.runLength < TRIGGER_RUN_LENGTH) return false;
  if (state.reminderFiredForRun) return false;
  map.set(sessionId, { ...state, reminderFiredForRun: true });
  return true;
}

/** Reminder text appended to tool_result channel when the trigger fires. */
export function buildRepetitionReminder(sessionId: string): string {
  const state = getMap().get(sessionId);
  const runLen = state?.runLength ?? TRIGGER_RUN_LENGTH;
  const phrase = state?.lastPhrase ?? "the same opening phrase";
  return (
    `[self-repetition detected] You have started ${runLen} consecutive responses with "${phrase}". ` +
    `This pattern indicates perseveration — re-confirming scope instead of making progress. ` +
    `In your next response, state EXPLICITLY what is blocking you (one short sentence), then either ` +
    `(a) take a concrete next action with a different tool, or (b) emit your best final answer with current context.`
  );
}

/** Test helper — clear all session state. */
export function _resetForTests(): void {
  (globalThis as RepetitionGlobals).__muonroiRepetitionState = undefined;
}

export const _internals = {
  PHRASE_WORD_COUNT,
  TRIGGER_RUN_LENGTH,
};
