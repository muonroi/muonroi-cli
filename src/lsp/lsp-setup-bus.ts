// ---------------------------------------------------------------------------
// LSP setup bus — carries the "offer the first-run language-server setup"
// signal from boot-time detection (index.ts) or `/lsp setup` to the TUI's
// inline multi-select card.
// ---------------------------------------------------------------------------
// Deliberately SEPARATE from src/ee/ee-connect-bus.ts (same shape, different
// domain): sharing one bus/controller would couple EE onboarding and LSP
// onboarding lifecycles. Semantics mirror it exactly:
//   - once-per-process dedupe (the card must not spam within a session),
//   - pre-mount buffering (boot-time publish happens before React mounts),
//   - a reset hook so `/lsp setup` can re-open the card after a dismiss.
// ---------------------------------------------------------------------------

type LspSetupListener = () => void;

const listeners = new Set<LspSetupListener>();
/** Whether the offer was already announced this process (once per session). */
let announced = false;
/** A publish arrived before any subscriber mounted. */
let pending = false;

/**
 * Announce the LSP setup offer to the UI. Announced at most once per process;
 * repeat publishes are no-ops until resetLspSetupAnnouncements() runs (which
 * `/lsp setup` uses to force the card open again). Buffered when no subscriber
 * is mounted yet.
 */
export function publishLspSetup(): void {
  if (announced) return;
  announced = true;
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  for (const listener of listeners) listener();
}

/**
 * Subscribe to the LSP setup offer. A buffered pre-mount announcement is
 * delivered synchronously to the first subscriber. Returns an unsubscribe.
 */
export function subscribeLspSetup(listener: LspSetupListener): () => void {
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
 * (used by `/lsp setup` and tests between cases).
 */
export function resetLspSetupAnnouncements(): void {
  announced = false;
  pending = false;
}
