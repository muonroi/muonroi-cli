// ---------------------------------------------------------------------------
// EE connect bus — carries the "offer to connect the Experience Engine brain"
// signal from boot-time detection (index.ts) or `/ee setup` to the TUI's
// inline connect card.
// ---------------------------------------------------------------------------
// Deliberately SEPARATE from src/mcp/needs-key-bus.ts (same shape, different
// domain): sharing one bus/controller would couple MCP key-repair and EE
// onboarding lifecycles. Semantics mirror it exactly:
//   - once-per-process dedupe (the card must not spam within a session),
//   - pre-mount buffering (boot-time publish happens before React mounts),
//   - a reset hook so `/ee setup` can re-open the card after a dismiss.
// ---------------------------------------------------------------------------

type EeConnectListener = () => void;

const listeners = new Set<EeConnectListener>();
/** Whether the offer was already announced this process (once per session). */
let announced = false;
/** A publish arrived before any subscriber mounted. */
let pending = false;

/**
 * Announce the EE connect offer to the UI. Announced at most once per process;
 * repeat publishes are no-ops until resetEeConnectAnnouncements() runs (which
 * `/ee setup` uses to force the card open again). Buffered when no subscriber
 * is mounted yet.
 */
export function publishEeConnect(): void {
  if (announced) return;
  announced = true;
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  for (const listener of listeners) listener();
}

/**
 * Subscribe to the EE connect offer. A buffered pre-mount announcement is
 * delivered synchronously to the first subscriber. Returns an unsubscribe.
 */
export function subscribeEeConnect(listener: EeConnectListener): () => void {
  listeners.add(listener);
  if (pending) {
    pending = false;
    listener();
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget that the offer was announced so a later publish re-surfaces the card
 * (used by `/ee setup` and tests between cases).
 */
export function resetEeConnectAnnouncements(): void {
  announced = false;
  pending = false;
}
