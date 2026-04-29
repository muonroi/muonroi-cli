/**
 * AbortContext — single-owner AbortController wrapper for the orchestrator.
 *
 * Rules:
 * - One AbortContext per user message turn (created fresh by the orchestrator).
 * - The signal is threaded into streamText, tool runner, and EE intercept calls.
 * - abort() is idempotent — safe to call from multiple signal paths (SIGINT,
 *   EE timeout, etc.). First call wins; subsequent calls are no-ops.
 *
 * Mitigates: Pitfall 2 (orchestrator-level abort safely terminates all I/O).
 * References: TUI-04, 00-CONTEXT.md decision — orchestrator owns controller.
 */

export interface AbortContext {
  /** The underlying AbortSignal — thread this into every async I/O call. */
  signal: AbortSignal;

  /**
   * Abort the context with an optional reason string.
   * Safe to call multiple times — only the first call has effect.
   */
  abort(reason?: string): void;

  /** Returns true once abort() has been called. */
  isAborted(): boolean;

  /** Returns the reason string passed to the first abort() call, or undefined. */
  reason(): string | undefined;
}

/**
 * Creates a fresh AbortContext.  Call once per user message turn.
 */
export function createAbortContext(): AbortContext {
  const controller = new AbortController();
  let _reason: string | undefined;

  return {
    signal: controller.signal,

    abort(reason?: string) {
      if (controller.signal.aborted) return; // idempotent
      _reason = reason;
      controller.abort(reason);
    },

    isAborted: () => controller.signal.aborted,

    reason: () => _reason,
  };
}
