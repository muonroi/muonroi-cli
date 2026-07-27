import type { ModelMessage } from "ai";

/**
 * Pick the messages a finished sub-session turn should hand back to its parent.
 *
 * `turnStartIndex` is the length of the sub-session's message array BEFORE this
 * turn ran — everything at or after it belongs to this turn. The scan must not
 * cross it: a sub-session is long-lived and resumed across turns, so its array
 * still holds every earlier turn's assistant reply. Session 708f0fc4ac8b showed
 * what happens without the bound — a turn that produced nothing handed the
 * PREVIOUS turn's answer to the parent, which surfaced as an off-topic reply
 * delivered 13 ms after the question (too fast for any model call).
 *
 * Returning an empty array is the correct outcome for a turn that produced no
 * answer: the caller logs it and absorbs nothing, so the failure stays visible
 * as a failure instead of masquerading as a stale answer.
 */
export function salvageSubSessionOutput(messages: ModelMessage[], turnStartIndex = 0): ModelMessage[] {
  const floor = Math.max(0, Math.min(turnStartIndex, messages.length));

  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= floor; i--) {
    if (messages[i].role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }
  if (lastAsstIdx < 0) return [];

  const finalMessages: ModelMessage[] = [messages[lastAsstIdx]];
  for (let i = lastAsstIdx + 1; i < messages.length; i++) {
    if (messages[i].role === "tool") finalMessages.push(messages[i]);
  }
  return finalMessages;
}
