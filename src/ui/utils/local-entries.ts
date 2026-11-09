/**
 * Reconcile the transcript rebuilt from saved history with what is on screen.
 *
 * At the end of a model turn the TUI replaces its entry list with
 * `agent.getChatEntries()` (rebuilt from the saved session). Host-local output
 * (`ChatEntry.local`: `/help`, `/skills`, `/ideal status`, …) was never saved —
 * it is not part of the conversation and must not reach the model — so a plain
 * replace silently deleted it. This module is the one place that rebuild is
 * defined: saved entries are the base, live on-screen texts are restored onto
 * the user entries, and local entries are re-inserted at their chronological
 * position.
 *
 * Pure and UI-framework free so it is unit-testable (use-app-logic.tsx is
 * `@ts-nocheck`).
 */
import type { ChatEntry } from "../../types/index.js";

/**
 * The n-th saved user message is the n-th MODEL-BOUND user entry on screen, so
 * restoring on-screen text (the saved copy may carry enhancements such as
 * expanded @-mentions) must skip local user echoes (`/ideal status`, …).
 * Counting them would hand the model prompt's entry the text of a slash command.
 */
function restoreUserContent(fresh: ChatEntry[], prev: readonly ChatEntry[]): ChatEntry[] {
  const out = fresh.slice();
  let prevUserIdx = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.type !== "user") continue;
    while (prevUserIdx < prev.length && (prev[prevUserIdx]!.type !== "user" || prev[prevUserIdx]!.local)) prevUserIdx++;
    if (prevUserIdx < prev.length) {
      out[i] = { ...out[i]!, content: prev[prevUserIdx]!.content };
      prevUserIdx++;
    }
  }
  return out;
}

/**
 * Insert `prev`'s local entries into `fresh` (already in time order) after the
 * last entry that is not newer than them; locals with equal timestamps keep
 * their on-screen order. Deterministic: depends only on the two lists.
 */
export function mergeLocalEntries(fresh: readonly ChatEntry[], prev: readonly ChatEntry[]): ChatEntry[] {
  const out = fresh.slice();
  for (const entry of prev) {
    if (!entry.local) continue;
    let at = out.length;
    for (let i = 0; i < out.length; i++) {
      if (out[i]!.timestamp.getTime() > entry.timestamp.getTime()) {
        at = i;
        break;
      }
    }
    out.splice(at, 0, entry);
  }
  return out;
}

/** The end-of-turn rebuild: saved history, live user text restored, local output kept. */
export function reconcileTranscript(fresh: ChatEntry[], prev: readonly ChatEntry[]): ChatEntry[] {
  return mergeLocalEntries(restoreUserContent(fresh, prev), prev);
}
