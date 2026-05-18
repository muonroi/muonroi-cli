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
  /**
   * Called after each frame is successfully sent to the transport.
   * Use to mark idle-detector activity, log, or perform side-effects that
   * need to fire in sync with outbound frames.
   *
   * Example:
   *   installOpenTUIHarness({ ..., onFrame: () => idle.markActivity() })
   */
  onFrame?: (frame: object) => void;
  /**
   * When true, frame timestamps become a deterministic function of seq
   * (ts = seq * 16) instead of `Date.now()`. Used by the determinism harness
   * spec to assert byte-identical LiveFrame traces across runs. Set this from
   * the `--agent-fake-clock` CLI flag.
   */
  fakeClock?: boolean;
}

export interface OpenTUIHarnessHandle {
  /**
   * Force an immediate capture and send if content changed.
   * Useful when the caller drives capture from an external trigger
   * (e.g. OpenTUI `addPostProcessFn`) in addition to the poll interval.
   */
  captureNow(): void;
  /** Stop the poll interval and call `transport.close()` if provided. */
  uninstall(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire `registry` → `transport` at `fps` snapshots/sec.
 *
 * Returns an {@link OpenTUIHarnessHandle} with:
 * - `captureNow()` — force an immediate capture (renderer post-process use)
 * - `uninstall()` — stop the poll interval and close the transport
 *
 * For backwards-compatibility the return value is also callable as a plain
 * function (invoking it calls `uninstall()`).
 */
export function installOpenTUIHarness(opts: InstallOpenTUIHarnessOptions): OpenTUIHarnessHandle & (() => void) {
  const fps = opts.fps ?? 60;
  const intervalMs = Math.max(1, Math.round(1000 / fps));

  let seq = 0;
  const fakeClock = opts.fakeClock ?? false;
  const hook = createReconcilerHook({
    registry: opts.registry,
    getSeq: () => seq++,
    // When fakeClock is on, ts is purely a function of seq — same input
    // produces the same trace across runs (used by the determinism spec).
    getTs: fakeClock ? () => seq * 16 : () => Date.now(),
  });

  function trySend(): void {
    const frame = hook.capture();
    if (frame === null) return; // dedup — no change
    try {
      opts.transport.send(JSON.stringify(frame) + "\n");
      opts.onFrame?.(frame);
    } catch {
      // Drop frame on transport error — survivor of next tick will retry.
    }
  }

  const id = setInterval(trySend, intervalMs);

  function uninstall(): void {
    clearInterval(id);
    opts.transport.close?.();
  }

  // Make the handle also callable as a plain () => void for backwards-compat.
  const handle = uninstall as OpenTUIHarnessHandle & (() => void);
  handle.captureNow = trySend;
  handle.uninstall = uninstall;

  return handle;
}
