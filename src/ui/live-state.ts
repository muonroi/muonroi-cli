/**
 * Live (ref-mirrored) state for keyboard handlers that must act on what the
 * user selected, not on what React last rendered.
 *
 * `handleKey` (use-app-logic.tsx) is one `useCallback` closing over the last
 * committed render. OpenTUI drains a stdin chunk synchronously (`stdinListener`
 * → `stdinParser.push` → `drainStdinParser`, @opentui/core) and the root is a
 * ConcurrentRoot, so every key in one chunk runs against the SAME closure: the
 * `setState` from Down is scheduled, not committed, when Enter runs. A real
 * terminal delivers such a chunk whenever keys are typed while the event loop
 * is busy (queued input replays as one read). Measured on the tool-approval
 * card: Down+Enter in one chunk APPROVED the call
 * (tests/harness/safe-mode-tool-approval.spec.ts "Down+Enter in ONE batch").
 *
 * The fix is per surface, not a global `flushSync` around the handler: OpenTUI
 * runs global key listeners BEFORE the focused renderable
 * (`InternalKeyHandler.emitWithPriority`), so committing synchronously inside
 * the handler would re-focus the composer when a card closes and hand it the
 * very Enter that closed the card.
 *
 * `applyLiveUpdate` resolves an updater against the ref — the value every
 * earlier key in the same burst already wrote — stores it there synchronously,
 * then hands it to React. Same contract as `setCouncilCardStateSync` in
 * use-app-logic.tsx; handlers read `ref.current`, never the closure.
 */
import { useCallback, useRef, useState } from "react";

export type LiveUpdate<T> = T | ((prev: T) => T);

export interface LiveRef<T> {
  current: T;
}

export function applyLiveUpdate<T>(ref: LiveRef<T>, update: LiveUpdate<T>, commit: (next: T) => void): T {
  const next = typeof update === "function" ? (update as (prev: T) => T)(ref.current) : update;
  ref.current = next;
  commit(next);
  return next;
}

/**
 * `useState` whose setter also writes a ref synchronously. Render reads the
 * state; keyboard handlers read the ref. The setter is stable.
 */
export function useLiveState<T>(initial: T): [T, (update: LiveUpdate<T>) => void, LiveRef<T>] {
  const [state, setState] = useState<T>(initial);
  const ref = useRef<T>(initial);
  const set = useCallback((update: LiveUpdate<T>) => {
    applyLiveUpdate(ref, update, setState);
  }, []);
  return [state, set, ref];
}

/** Tool/worker approval card rows: 0 = "Allow once", 1 = "Deny". */
export const APPROVAL_ALLOW_INDEX = 0;

export function toggleApprovalSelection(selected: number): number {
  return selected === APPROVAL_ALLOW_INDEX ? 1 : APPROVAL_ALLOW_INDEX;
}

/** Only an explicit "Allow once" row approves; any other value denies. */
export function isApprovalAllowed(selected: number): boolean {
  return selected === APPROVAL_ALLOW_INDEX;
}
