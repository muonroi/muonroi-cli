import type { UINode } from "./registry";
import type { SemanticRegistry } from "./registry.service";

const PROTOCOL_VERSION = "0.1.0" as const;

export type LiveFrame = {
  mode: "live";
  version: typeof PROTOCOL_VERSION;
  seq: number;
  ts: number;
  nodes: UINode[];
};

export type FrameTransport = (frame: LiveFrame) => void;

/**
 * Starts a polling snapshot loop using setInterval (NOT requestAnimationFrame —
 * this runs in Node/TestBed environments where rAF is unavailable).
 *
 * Hash-dedup: identical consecutive snapshots are NOT emitted.
 *
 * @param registry  SemanticRegistry instance (or any object with snapshot())
 * @param transport Callback invoked with each new distinct LiveFrame
 * @param intervalMs Polling interval (default 33ms ≈ 30fps)
 * @returns Cleanup function that clears the interval
 */
export function startSnapshotLoop(
  registry: Pick<SemanticRegistry, "snapshot">,
  transport: FrameTransport,
  intervalMs = 33,
): () => void {
  let lastHash = "";
  let seq = 0;

  const id = setInterval(() => {
    const nodes = registry.snapshot();
    const hash = JSON.stringify(nodes);
    if (hash === lastHash) return; // dedup — identical state, no emit
    lastHash = hash;
    const frame: LiveFrame = {
      mode: "live",
      version: PROTOCOL_VERSION,
      seq: ++seq,
      ts: Date.now(),
      nodes,
    };
    transport(frame);
  }, intervalMs);

  return () => clearInterval(id);
}
