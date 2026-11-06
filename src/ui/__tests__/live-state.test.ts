/**
 * live-state — the approval card's Enter must act on the row the
 * user moved to, even when Down and Enter arrive in one stdin chunk before
 * React commits (measured: that burst APPROVED a tool call;
 * tests/harness/safe-mode-tool-approval.spec.ts "Down+Enter in ONE batch").
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ALLOW_INDEX,
  applyLiveUpdate,
  isApprovalAllowed,
  type LiveRef,
  toggleApprovalSelection,
} from "../live-state.js";

type Card = { selected: number } | null;

describe("applyLiveUpdate", () => {
  it("a burst sees each prior update even though the commit is deferred", () => {
    const ref: LiveRef<Card> = { current: { selected: APPROVAL_ALLOW_INDEX } };
    // React's setState: queued, not yet applied — exactly the burst situation.
    const queued: Card[] = [];
    const commit = (next: Card) => queued.push(next);
    const rendered: Card = ref.current; // what the stale closure would read

    applyLiveUpdate(ref, (p) => (p ? { ...p, selected: toggleApprovalSelection(p.selected) } : p), commit); // Down
    const enterReadsLive = ref.current; // Enter in the same chunk

    expect(isApprovalAllowed(rendered!.selected)).toBe(true); // the old bug: stale read approves
    expect(isApprovalAllowed(enterReadsLive!.selected)).toBe(false); // live read denies
    expect(queued).toEqual([{ selected: 1 }]); // React still gets the same value
  });

  it("chains functional updates against the ref, not against the render", () => {
    const ref: LiveRef<Card> = { current: { selected: 0 } };
    const commits: Card[] = [];
    for (let i = 0; i < 3; i++) {
      applyLiveUpdate(
        ref,
        (p) => (p ? { selected: toggleApprovalSelection(p.selected) } : p),
        (n) => commits.push(n),
      );
    }
    expect(ref.current).toEqual({ selected: 1 });
    expect(commits.map((c) => c?.selected)).toEqual([1, 0, 1]);
  });

  it("plain values replace the ref and return the new value", () => {
    const ref: LiveRef<Card> = { current: { selected: 1 } };
    const out = applyLiveUpdate(ref, null, () => {});
    expect(out).toBeNull();
    expect(ref.current).toBeNull();
  });
});

describe("approval selection", () => {
  it("only row 0 approves; anything else denies", () => {
    expect(isApprovalAllowed(0)).toBe(true);
    expect(isApprovalAllowed(1)).toBe(false);
    expect(isApprovalAllowed(-1)).toBe(false);
    expect(isApprovalAllowed(7)).toBe(false);
  });

  it("Up/Down toggle between the two rows", () => {
    expect(toggleApprovalSelection(0)).toBe(1);
    expect(toggleApprovalSelection(1)).toBe(0);
  });
});
