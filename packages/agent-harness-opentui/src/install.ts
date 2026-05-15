/**
 * install.ts — Single-entry-point wiring for the OpenTUI agent harness.
 *
 * `installOpenTUIHarness` wires a SemanticRegistry to a transport by polling
 * the registry via `createReconcilerHook` at a target fps.  The hook dedupes
 * via content-hash, so missed or extra ticks are cheap.
 *
 * Usage:
 *   const uninstall = installOpenTUIHarness({ registry, transport });
 *   // later:
 *   uninstall();
 */

import type { SemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { createReconcilerHook } from "./reconciler-hook.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenTUIHarnessTransport {
  /** Write one JSONL line to the transport. */
  send(line: string): void;
  /** Optional teardown called by the returned uninstall function. */
  close?(): void;
}

export interface InstallOpenTUIHarnessOptions {
  registry: SemanticRegistry;
  transport: OpenTUIHarnessTransport;
  /**
   * Target snapshot frequency in Hz.  Default 60.
   * The hook dedupes via content-hash, so missed ticks are cheap.
   */
  fps?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire `registry` → `transport` at `fps` snapshots/sec.
 *
 * Returns an uninstall function that stops the poll interval and calls
 * `transport.close()` if provided.
 */
export function installOpenTUIHarness(opts: InstallOpenTUIHarnessOptions): () => void {
  const fps = opts.fps ?? 60;
  const intervalMs = Math.max(1, Math.round(1000 / fps));

  let seq = 0;
  const hook = createReconcilerHook({
    registry: opts.registry,
    getSeq: () => seq++,
    getTs: () => Date.now(),
  });

  const id = setInterval(() => {
    const frame = hook.capture();
    if (frame === null) return; // dedup — no change
    try {
      opts.transport.send(JSON.stringify(frame) + "\n");
    } catch {
      // Drop frame on transport error — survivor of next tick will retry.
    }
  }, intervalMs);

  return () => {
    clearInterval(id);
    opts.transport.close?.();
  };
}
