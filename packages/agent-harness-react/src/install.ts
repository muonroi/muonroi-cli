/**
 * install.ts — Snapshot flush loop for the React agent harness.
 *
 * `installReactHarness({ registry, transport, fps })` schedules
 * `registry.snapshot()` → LiveFrame on a requestAnimationFrame debounce.
 * Deduplication is done via stable JSON hash.
 *
 * In environments without requestAnimationFrame (Node/SSR, test env),
 * falls back to setInterval(1000 / fps).
 *
 * Returns a cleanup function that cancels the loop.
 */

// Re-export LiveFrame from protocol via registry (it re-exports it)
// We import from protocol directly to be explicit.
import { PROTOCOL_VERSION, type LiveFrame } from "@muonroi/agent-harness-core/protocol";
import type { SemanticNodeInput, SemanticRegistry } from "@muonroi/agent-harness-core/registry";

// ---------------------------------------------------------------------------
// Transport interface (minimal — mirrors OpenTUI harness)
// ---------------------------------------------------------------------------

export interface ReactHarnessTransport {
  /** Write one JSONL line (a serialized WsEnvelope frame) to the transport. */
  send(line: string): void;
  /** Optional teardown. Called by the returned cleanup function. */
  close?(): void;
}

// ---------------------------------------------------------------------------
// Options + handle
// ---------------------------------------------------------------------------

export interface ReactHarnessOptions {
  registry: SemanticRegistry;
  transport: ReactHarnessTransport;
  /**
   * Target snapshot frequency in Hz. Default 30.
   * The loop dedupes via content-hash, so extra ticks are cheap.
   */
  fps?: number;
}

export interface ReactHarnessHandle {
  /** Cancel the loop and call transport.close() if provided. */
  uninstall(): void;
}

// ---------------------------------------------------------------------------
// Stable hash (sorts object keys recursively — deterministic for dedup)
// ---------------------------------------------------------------------------

function stableHash(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map(stableHash).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableHash(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire registry → transport at `fps` snapshots/sec.
 * Uses requestAnimationFrame when available (browser), else setInterval (Node/SSR).
 */
export function installReactHarness(opts: ReactHarnessOptions): ReactHarnessHandle {
  const fps = opts.fps ?? 30;
  const intervalMs = Math.max(1, Math.round(1000 / fps));
  let seq = 0;
  let lastHash: string | undefined;
  let cancelled = false;

  function tick(): void {
    if (cancelled) return;

    if (__MUONROI_HARNESS__) {
      const snap = opts.registry.snapshot();
      const hash = stableHash({ focus: snap.focus ?? null, modals: snap.modals ?? null, nodes: snap.nodes });

      if (lastHash !== hash) {
        lastHash = hash;
        const frame: LiveFrame = {
          mode: "live",
          version: PROTOCOL_VERSION,
          seq: seq++,
          ts: Date.now(),
          nodes: snap.nodes,
        };
        if (snap.focus !== undefined) frame.focus = snap.focus;
        if (snap.modals !== undefined) frame.modals = snap.modals;

        // Wrap as WsEnvelope with dir: "frame"
        const envelope = { dir: "frame" as const, ...frame };
        try {
          opts.transport.send(JSON.stringify(envelope));
        } catch {
          // Drop frame on transport error — survivor of next tick will retry.
        }
      }
    }

    schedule();
  }

  // Schedule next tick using rAF (browser) or setInterval (Node/SSR)
  const hasRAF = typeof requestAnimationFrame === "function";
  let timerId: ReturnType<typeof setInterval> | number | undefined;

  function schedule(): void {
    if (cancelled) return;
    if (hasRAF) {
      timerId = requestAnimationFrame(tick);
    }
    // setInterval is set up once in non-rAF mode (handled below)
  }

  if (hasRAF) {
    schedule();
  } else {
    timerId = setInterval(tick, intervalMs);
  }

  function uninstall(): void {
    cancelled = true;
    if (hasRAF) {
      if (timerId !== undefined) cancelAnimationFrame(timerId as number);
    } else {
      clearInterval(timerId as ReturnType<typeof setInterval>);
    }
    opts.transport.close?.();
  }

  return { uninstall };
}

// Re-export LiveFrame for convenience
export type { LiveFrame };
