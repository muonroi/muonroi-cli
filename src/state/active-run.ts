/**
 * src/ui/state/active-run.ts
 *
 * Singleton store tracking the currently-active /ideal run.
 * Used by StatusBar (B1) and the reporter auto-fire observer (B2).
 *
 * Lifecycle:
 *  - setActiveRunId() called when sprint-plan-committed fires
 *  - clearActiveRunId() called when the run ends (shipped / halted)
 *  - Subscribers receive the new runId (or null) on every change
 */

export interface ActiveRunState {
  runId: string | null;
  flowDir: string | null;
  productSlug: string | null;
}

type Listener = (state: ActiveRunState) => void;

function makeActiveRunStore() {
  let state: ActiveRunState = {
    runId: null,
    flowDir: null,
    productSlug: null,
  };
  const listeners = new Set<Listener>();

  return {
    getState: (): ActiveRunState => state,

    setActiveRun: (runId: string, flowDir: string, productSlug: string): void => {
      state = { runId, flowDir, productSlug };
      for (const l of listeners) l(state);
    },

    clearActiveRun: (): void => {
      state = { runId: null, flowDir: null, productSlug: null };
      for (const l of listeners) l(state);
    },

    subscribe: (fn: Listener): (() => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export const activeRunStore = makeActiveRunStore();

/**
 * Single canonical writer for "which run is the workspace focused on".
 * Writes the durable pointer (`state.md` `Active Run`) AND the in-memory cache
 * atomically, so disk and StatusBar/reporter never drift (F8 follow-up).
 *
 * The disk write is idempotent with `ensureRunScoped`'s earlier write for the
 * same runId — routing the focus moment through here just guarantees they agree.
 */
export async function setWorkspaceFocus(
  flowDir: string,
  focus: { runId: string; productSlug: string; reason?: string },
): Promise<void> {
  const { setActiveRunId } = await import("../flow/run-manager.js");
  await setActiveRunId(flowDir, focus.runId);
  activeRunStore.setActiveRun(focus.runId, flowDir, focus.productSlug);
}

/**
 * Clear the workspace focus cache when a run ends (shipped / halted).
 * Cache-only by design: the durable `Active Run` pointer is left intact as a
 * historical marker so `/ideal phases` still resolves the last run post-ship.
 */
export function clearWorkspaceFocus(): void {
  activeRunStore.clearActiveRun();
}

/** Test helper: reset to initial state. */
export function __resetActiveRunStoreForTests(): void {
  activeRunStore.clearActiveRun();
}
