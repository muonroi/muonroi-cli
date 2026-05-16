/**
 * Helpers for attributing usage_events to the most recent persisted message.
 *
 * `messageSeqs` is the orchestrator's parallel array to `this.messages`:
 * - `number` entries are DB-persisted message sequence numbers
 * - `null`   entries are in-memory messages not yet persisted (e.g. interrupted
 *   stubs, system notifications inserted between turns, transient state)
 *
 * Returning the last persisted seq lets `usage_events.message_seq` link a token
 * cost back to a specific user prompt or assistant turn, instead of `null`
 * (which made per-prompt cost analysis impossible).
 */
export function lastPersistedSeq(messageSeqs: ReadonlyArray<number | null>): number | null {
  for (let i = messageSeqs.length - 1; i >= 0; i--) {
    const seq = messageSeqs[i];
    if (typeof seq === "number") return seq;
  }
  return null;
}
