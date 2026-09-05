/**
 * Regression pin for the modal-collision steerability dead end.
 *
 * Measured 2026-09-05 on a live `/ideal` run driven over the MCP harness: a
 * council escalation askcard and the init-new form were open at the same time,
 * `tui.query "focus"` returned null, `tui.press "Enter"` did nothing, and
 * `tui.focus` returned "ok" while moving nothing. The run was alive, correct
 * and unreachable.
 *
 * These tests pin the invariant that removes it: **whenever any modal is open,
 * exactly one surface owns the keyboard, and it is the one most recently
 * opened.** The last block drives the REAL askcard reducer through a chain
 * built in the same branch order as `handleKey` in
 * `src/ui/use-app-logic.tsx`, so a keypress provably resolves the top card and
 * not the stale one underneath.
 */

import { describe, expect, it } from "vitest";
import type { CouncilQuestionData } from "../../types/index.js";
import { type CouncilCardState, initialCardState, reduceCardKey } from "../components/council-question-card.js";
import {
  collectOpenModalSurfaces,
  createModalOpenOrder,
  MODAL_SURFACE_PRIORITY,
  type ModalSurfaceId,
  modalOwnsKeyboard,
  reconcileModalOpenOrder,
  resolveModalKeyboardOwner,
} from "../modal-focus.js";

type OpenFlags = Parameters<typeof collectOpenModalSurfaces>[0];

function ownerAfter(sequence: OpenFlags[]): ModalSurfaceId | null {
  const order = createModalOpenOrder();
  let owner: ModalSurfaceId | null = null;
  for (const flags of sequence) {
    const open = collectOpenModalSurfaces(flags);
    reconcileModalOpenOrder(order, open);
    owner = resolveModalKeyboardOwner(order, open);
  }
  return owner;
}

describe("modal keyboard ownership", () => {
  it("no modal open: nobody owns the keyboard (the composer keeps it)", () => {
    expect(ownerAfter([{}])).toBeNull();
  });

  it("one modal open: that modal owns the keyboard", () => {
    expect(ownerAfter([{ askcard: true }])).toBe("askcard");
    expect(ownerAfter([{ initNewForm: true }])).toBe("init-new-form");
  });

  it("two modals open: exactly one owner, and it is the one opened LAST", () => {
    // The measured collision: escalation askcard first, then the halt path
    // raises the init-new form on top of it.
    const owner = ownerAfter([{ askcard: true }, { askcard: true, initNewForm: true }]);
    expect(owner).toBe("init-new-form");

    // Exactly one. `modalOwnsKeyboard` is the guard on every handleKey branch,
    // so "exactly one true" is literally "exactly one branch may run".
    const open: ModalSurfaceId[] = ["askcard", "init-new-form"];
    expect(open.filter((s) => modalOwnsKeyboard(owner, s))).toEqual(["init-new-form"]);
  });

  it("the opposite arrival order flips ownership the other way", () => {
    // init-new form already up when a fresh askcard arrives: app.tsx renders the
    // askcard last (bottom-sticky anchor), so it must also take the keys.
    const owner = ownerAfter([{ initNewForm: true }, { initNewForm: true, askcard: true }]);
    expect(owner).toBe("askcard");
  });

  it("closing the owner hands the keyboard to the card still underneath", () => {
    const order = createModalOpenOrder();
    reconcileModalOpenOrder(order, collectOpenModalSurfaces({ askcard: true }));
    const both = collectOpenModalSurfaces({ askcard: true, initNewForm: true });
    reconcileModalOpenOrder(order, both);
    expect(resolveModalKeyboardOwner(order, both)).toBe("init-new-form");

    const askOnly = collectOpenModalSurfaces({ askcard: true });
    reconcileModalOpenOrder(order, askOnly);
    expect(resolveModalKeyboardOwner(order, askOnly)).toBe("askcard");
  });

  it("re-opening a surface puts it back on top (its old sequence is forgotten)", () => {
    const order = createModalOpenOrder();
    const both = collectOpenModalSurfaces({ askcard: true, initNewForm: true });
    reconcileModalOpenOrder(order, collectOpenModalSurfaces({ initNewForm: true }));
    reconcileModalOpenOrder(order, both);
    expect(resolveModalKeyboardOwner(order, both)).toBe("askcard");

    // First askcard answered, a second one arrives while the form is still up.
    reconcileModalOpenOrder(order, collectOpenModalSurfaces({ initNewForm: true }));
    reconcileModalOpenOrder(order, both);
    expect(resolveModalKeyboardOwner(order, both)).toBe("askcard");
  });

  it("a cold pass that sees several surfaces at once still picks exactly one, deterministically", () => {
    const order = createModalOpenOrder();
    const open = collectOpenModalSurfaces({ haltCard: true, initNewForm: true, askcard: true });
    reconcileModalOpenOrder(order, open);
    const owner = resolveModalKeyboardOwner(order, open);
    expect(owner).not.toBeNull();
    expect(open.filter((s) => modalOwnsKeyboard(owner, s))).toHaveLength(1);
    // Tie-break follows the render order: the card nearest the composer wins.
    const rank = (s: ModalSurfaceId) => MODAL_SURFACE_PRIORITY.indexOf(s);
    for (const s of open) {
      if (s !== owner) expect(rank(s)).toBeLessThan(rank(owner as ModalSurfaceId));
    }
  });

  it("every surface in the priority list is reachable as an owner", () => {
    for (const surface of MODAL_SURFACE_PRIORITY) {
      const order = createModalOpenOrder();
      reconcileModalOpenOrder(order, [surface]);
      expect(resolveModalKeyboardOwner(order, [surface])).toBe(surface);
    }
  });
});

// ---------------------------------------------------------------------------
// Keypress routing: the chain, in the same branch order as handleKey
// ---------------------------------------------------------------------------

const QUESTION = {
  questionId: "escalate-1",
  question: "The debate reached its progress limit with 1 criterion still unmet",
  phase: "post-debate",
  defaultIndex: 0,
  options: [
    { label: "Extend 2 more rounds", value: "escalate_extend", kind: "choice" },
    { label: "Accept as-is", value: "escalate_accept", kind: "choice" },
    { label: "Re-scope", value: "escalate_rescope", kind: "choice" },
  ],
} as unknown as CouncilQuestionData;

/**
 * Mirrors the modal section of `handleKey` in `src/ui/use-app-logic.tsx`: the
 * same branch order, each guarded by `modalOwnsKeyboard`. Returns which surface
 * consumed the key, plus the askcard's emit when the askcard was the consumer.
 */
function routeEnter(
  open: OpenFlags,
  owner: ModalSurfaceId | null,
  cardState: CouncilCardState,
): { consumedBy: ModalSurfaceId | "composer"; emit?: ReturnType<typeof reduceCardKey>["emit"] } {
  if (open.pointToExistingForm && modalOwnsKeyboard(owner, "point-to-existing-form")) {
    return { consumedBy: "point-to-existing-form" };
  }
  if (open.initNewForm && modalOwnsKeyboard(owner, "init-new-form")) {
    return { consumedBy: "init-new-form" };
  }
  if (open.haltCard && modalOwnsKeyboard(owner, "ideal-halt-card")) {
    return { consumedBy: "ideal-halt-card" };
  }
  if (open.askcard && modalOwnsKeyboard(owner, "askcard")) {
    const result = reduceCardKey(QUESTION, cardState, { kind: "enter" });
    return { consumedBy: "askcard", emit: result.emit };
  }
  if (open.preflight && modalOwnsKeyboard(owner, "askcard-preflight")) {
    return { consumedBy: "askcard-preflight" };
  }
  return { consumedBy: "composer" };
}

describe("modal collision: a keypress resolves the TOP card", () => {
  it("askcard raised on top of the init-new form answers the askcard, not the form", () => {
    const owner = ownerAfter([{ initNewForm: true }, { initNewForm: true, askcard: true }]);
    const routed = routeEnter({ initNewForm: true, askcard: true }, owner, initialCardState(QUESTION));

    expect(routed.consumedBy).toBe("askcard");
    expect(routed.emit).toEqual({
      type: "answer",
      answer: { questionId: "escalate-1", text: "escalate_extend", kind: "choice" },
    });
  });

  it("init-new form raised on top of a pending askcard takes the key itself", () => {
    // The exact measured state. The form is what the user just asked for, so it
    // owns the keyboard; the point is that ownership is now single-valued and
    // published, instead of two cards both looking answerable and neither being.
    const owner = ownerAfter([{ askcard: true }, { askcard: true, initNewForm: true }]);
    const routed = routeEnter({ askcard: true, initNewForm: true }, owner, initialCardState(QUESTION));
    expect(routed.consumedBy).toBe("init-new-form");
    expect(routed.emit).toBeUndefined();
  });

  it("dismissing the top card makes the card underneath answerable again", () => {
    const order = createModalOpenOrder();
    reconcileModalOpenOrder(order, collectOpenModalSurfaces({ askcard: true }));
    const both = collectOpenModalSurfaces({ askcard: true, initNewForm: true });
    reconcileModalOpenOrder(order, both);
    expect(resolveModalKeyboardOwner(order, both)).toBe("init-new-form");

    // Esc closes the form; the askcard becomes the owner and Enter answers it.
    const askOnly = collectOpenModalSurfaces({ askcard: true });
    reconcileModalOpenOrder(order, askOnly);
    const owner = resolveModalKeyboardOwner(order, askOnly);
    const routed = routeEnter({ askcard: true }, owner, initialCardState(QUESTION));
    expect(routed.consumedBy).toBe("askcard");
    expect(routed.emit?.type).toBe("answer");
  });

  it("no modal open: the key falls through to the composer", () => {
    expect(routeEnter({}, null, initialCardState(QUESTION)).consumedBy).toBe("composer");
  });
});
