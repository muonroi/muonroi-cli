/**
 * src/flow/compaction/input-guard.ts
 *
 * Guard the INPUT of the deliberate-compaction LLM calls (extractDecisions +
 * compressChat) against context-window overflow.
 *
 * Compaction fires precisely when a conversation has grown large — which is
 * exactly when the full serialized history can EXCEED the compaction model's
 * own context window. Both passes previously sent the whole serialized text as
 * a single prompt with no bound, so on a very long session the summarizing call
 * would fail (or the provider would hard-truncate the tail, dropping the most
 * recent — most relevant — context) and fall back to a dumb truncation.
 *
 * This keeps the HEAD (task setup / early decisions) and the TAIL (most recent
 * work) and elides the middle, so the summarizer always gets a coherent,
 * in-window view of both ends. Pure + dependency-free.
 */

/** Fraction of the model window we allow the compaction INPUT to occupy. */
const INPUT_WINDOW_FRACTION = 0.55;
/** Chars-per-token estimate (matches the rest of the compaction code). */
const CHARS_PER_TOKEN = 4;
/** Absolute floor so a tiny/unknown window never collapses the input to nothing. */
const MIN_INPUT_CHARS = 24_000;

/**
 * Cap `text` to a safe char budget derived from the compaction model's context
 * window. Returns the text unchanged when it already fits (or the window is
 * unknown and the text is under the floor). Otherwise keeps head+tail and marks
 * the elided middle.
 */
export function capCompactionInput(text: string, contextWindowTokens: number): string {
  const windowBudget =
    contextWindowTokens > 0 ? Math.floor(contextWindowTokens * CHARS_PER_TOKEN * INPUT_WINDOW_FRACTION) : 0;
  const budget = Math.max(MIN_INPUT_CHARS, windowBudget);
  if (text.length <= budget) return text;

  // Split the budget between head and tail, reserving room for the marker.
  const headChars = Math.floor(budget * 0.5);
  const tailChars = budget - headChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  const elided = text.length - headChars - tailChars;
  return `${head}\n\n[... ${elided} characters of the middle of the conversation elided to fit the compaction model's context window; the head (task setup) and tail (most recent work) are preserved ...]\n\n${tail}`;
}
