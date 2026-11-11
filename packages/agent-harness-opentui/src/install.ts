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
  /**
   * Optional visual-frame capture. When provided, a VisualFrame (the actual
   * rendered cell grid — colors + attributes) is captured and sent right after
   * each SEMANTIC frame change. Piggybacking on semantic changes bounds the
   * per-frame `getSpanLines()` allocation to real UI updates instead of every
   * poll tick. Returns null on dedup / unavailable renderer.
   */
  captureVisual?: (seq: number, ts: number) => object | null;
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
/** How long after a semantic change the visual frame keeps being re-sampled. */
const VISUAL_SETTLE_MS = 1000;

export function installOpenTUIHarness(opts: InstallOpenTUIHarnessOptions): OpenTUIHarnessHandle & (() => void) {
  const fps = opts.fps ?? 60;
  const intervalMs = Math.max(1, Math.round(1000 / fps));

  let seq = 0;
  let vseq = 0;
  const fakeClock = opts.fakeClock ?? false;
  const hook = createReconcilerHook({
    registry: opts.registry,
    getSeq: () => seq++,
    // When fakeClock is on, ts is purely a function of seq — same input
    // produces the same trace across runs (used by the determinism spec).
    getTs: fakeClock ? () => seq * 16 : () => Date.now(),
  });

  // The semantic registry updates in React effects, BEFORE OpenTUI paints the
  // matching cells, so a visual captured on the semantic change usually shows
  // the previous paint. Captured only then, the visual stream froze one paint
  // behind until some later semantic change (measured: `/ideal status` text was
  // in the semantic tree while render_visual still showed the frame before it,
  // indefinitely). Keep sampling for a short settle window after each semantic
  // change; the visual hook's content-hash dedup sends only frames that differ,
  // and outside the window getSpanLines() still runs only on real UI updates.
  let visualSettleUntil = 0;

  function trySend(): void {
    const frame = hook.capture();
    const now = Date.now();
    if (frame === null && now >= visualSettleUntil) return; // dedup — no change, nothing settling
    try {
      if (frame !== null) {
        opts.transport.send(`${JSON.stringify(frame)}\n`);
        opts.onFrame?.(frame);
        visualSettleUntil = now + VISUAL_SETTLE_MS;
      }
      if (opts.captureVisual) {
        const vframe = opts.captureVisual(vseq, fakeClock ? vseq * 16 : now);
        if (vframe !== null) {
          vseq++;
          opts.transport.send(`${JSON.stringify(vframe)}\n`);
        }
      }
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
