import type { ModelMessage } from "ai";

/**
 * Pick the messages a finished sub-session turn should hand back to its parent.
 *
 * Prefer the persisted firstSeq boundary; the numeric array index is retained
 * for callers without persistent transcripts. The scan must not cross that
 * boundary: a sub-session is long-lived and resumed across turns, so its array
 * still holds every earlier turn's assistant reply. Session 708f0fc4ac8b showed
 * what happens without the bound — a turn that produced nothing handed the
 * PREVIOUS turn's answer to the parent, which surfaced as an off-topic reply
 * delivered 13 ms after the question (too fast for any model call).
 *
 * Returning an empty array is the correct outcome for a turn that produced no
 * answer: the caller logs it and absorbs nothing, so the failure stays visible
 * as a failure instead of masquerading as a stale answer.
 */
export function salvageSubSessionOutput(
  messages: ModelMessage[],
  boundary: number | { firstSeq: number; messageSeqs: Array<number | null> } = 0,
): ModelMessage[] {
  // Persisted sequence numbers survive compaction. Array lengths do not: a
  // compacted turn can be shorter than the old starting index and lose its
  // entire deliverable. Keep tool evidence BEFORE the final prose as well.
  const current =
    typeof boundary === "number"
      ? messages.slice(Math.max(0, Math.min(boundary, messages.length)))
      : messages.filter((_, i) => {
          const seq = boundary.messageSeqs[i];
          return typeof seq === "number" && seq >= boundary.firstSeq;
        });
  return current.filter((message) => message.role === "assistant" || message.role === "tool");
}
