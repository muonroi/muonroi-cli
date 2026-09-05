/**
 * src/ui/modal-focus.ts
 *
 * Modal keyboard-ownership resolution.
 *
 * ## The failure this exists to remove
 *
 * Measured 2026-09-05 on a live `/ideal` run driven over the MCP harness: a
 * council escalation askcard was open when the `no_recipe` sprint halt path
 * raised the init-new form on top of it. The resulting state was **alive,
 * correct and permanently unreachable**:
 *
 *   - `tui.query "focus"` returned `null` — no node in the whole tree claimed
 *     focus, so a driver could not tell which card owned input;
 *   - `tui.press "Enter"` returned `ok` and changed nothing;
 *   - `tui.focus "id=askcard-option-…"` returned `ok` and moved nothing.
 *
 * Both halves are explained by the code, not inferred:
 *
 *   1. `blockPrompt` (use-app-logic.tsx) turns true whenever `activeHaltCard`,
 *      `initNewForm` or `pointToExistingForm` is set, and `composerFocused`
 *      (prompt-box.tsx) is `!blockPrompt && …`. So the composer drops its
 *      `focus` flag — and **no modal card ever set one**. Nothing in the tree
 *      was focused, by construction.
 *   2. The `handleKey` chain routes to the FIRST open surface in a hardcoded
 *      source order (point-to-existing → init-new → halt card → askcard),
 *      while `app.tsx` renders the askcard LAST so bottom-sticky scroll anchors
 *      to it. Render order and key order disagreed, so the card the driver was
 *      looking at was not the card receiving keys.
 *
 * ## The rule
 *
 * **The most recently opened modal owns the keyboard (LIFO).** That is the only
 * rule that is right in both directions observed in the code:
 *
 *   - halt card → "Init new project": the user just asked for the form, so it
 *     must take keys even though a council askcard is still pending;
 *   - init-new form open when a new askcard arrives: the askcard is what
 *     `app.tsx` renders at the bottom and scrolls into view, so it must take
 *     keys.
 *
 * A fixed static priority gets exactly one of those two right.
 *
 * This module is pure and React-free on purpose: the same functions decide
 * (a) which `handleKey` branch is allowed to run and (b) which card renders
 * `focused`, so the published `focus` flag can never disagree with where the
 * keys actually go.
 */

/** A modal card surface that takes over the keyboard while it is open. */
export type ModalSurfaceId =
  | "ideal-halt-card"
  | "init-new-form"
  | "point-to-existing-form"
  | "askcard"
  | "askcard-preflight";

/**
 * Tie-break order, mirroring the render order in `app.tsx`: later entries sit
 * closer to the composer (the bottom-sticky anchor) and therefore read as
 * "on top" to a user. Only consulted when two or more surfaces are first
 * observed open in the SAME reconcile pass — normal opens are ordered by the
 * monotonic sequence instead.
 */
export const MODAL_SURFACE_PRIORITY: readonly ModalSurfaceId[] = [
  "ideal-halt-card",
  "init-new-form",
  "point-to-existing-form",
  "askcard",
  "askcard-preflight",
];

/** Which modal surfaces are open right now. */
export interface OpenModalFlags {
  haltCard?: boolean;
  initNewForm?: boolean;
  pointToExistingForm?: boolean;
  askcard?: boolean;
  preflight?: boolean;
}

/** Mutable open-order record. Owned by a ref in `use-app-logic`. */
export interface ModalOpenOrder {
  /** surface → the sequence number it was first observed open at. */
  seq: Map<ModalSurfaceId, number>;
  /** Next sequence number to hand out. Monotonic for the process lifetime. */
  next: number;
}

export function createModalOpenOrder(): ModalOpenOrder {
  return { seq: new Map(), next: 1 };
}

/** Translate the app's boolean state into the open-surface list. */
export function collectOpenModalSurfaces(flags: OpenModalFlags): ModalSurfaceId[] {
  const open: ModalSurfaceId[] = [];
  if (flags.haltCard) open.push("ideal-halt-card");
  if (flags.initNewForm) open.push("init-new-form");
  if (flags.pointToExistingForm) open.push("point-to-existing-form");
  if (flags.askcard) open.push("askcard");
  if (flags.preflight) open.push("askcard-preflight");
  return open;
}

/**
 * Record newly-opened surfaces and forget closed ones. Idempotent: calling it
 * twice with the same open set changes nothing, which is what makes it safe to
 * run from both the render path and (synchronously) from the key handler.
 *
 * Newly-seen surfaces are numbered in {@link MODAL_SURFACE_PRIORITY} order so a
 * pass that observes several at once is still deterministic.
 */
export function reconcileModalOpenOrder(order: ModalOpenOrder, open: readonly ModalSurfaceId[]): void {
  const openSet = new Set(open);
  for (const id of order.seq.keys()) {
    if (!openSet.has(id)) order.seq.delete(id);
  }
  for (const id of MODAL_SURFACE_PRIORITY) {
    if (openSet.has(id) && !order.seq.has(id)) {
      order.seq.set(id, order.next);
      order.next += 1;
    }
  }
}

/**
 * The single surface that owns the keyboard: the one opened most recently.
 * `null` when no modal is open (the composer keeps the keys).
 */
export function resolveModalKeyboardOwner(
  order: ModalOpenOrder,
  open: readonly ModalSurfaceId[],
): ModalSurfaceId | null {
  let owner: ModalSurfaceId | null = null;
  let best = -1;
  for (const id of open) {
    const s = order.seq.get(id);
    if (s === undefined) continue;
    if (s > best) {
      best = s;
      owner = id;
    }
  }
  return owner;
}

/**
 * Guard used by every modal branch of `handleKey`. Exactly one open surface can
 * answer `true`, which is what turns the branch chain from "first in source
 * order wins" into "the top modal wins".
 */
export function modalOwnsKeyboard(owner: ModalSurfaceId | null, surface: ModalSurfaceId): boolean {
  return owner === surface;
}
