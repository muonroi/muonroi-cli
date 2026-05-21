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

/** Test helper: reset to initial state. */
export function __resetActiveRunStoreForTests(): void {
  activeRunStore.clearActiveRun();
}
