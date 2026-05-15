import type { Registry } from "./registry";
import { sendFrame } from "./ws-client";

const PROTOCOL_VERSION = "0.1.0" as const;
let lastHash = "";
let seq = 0;

function stableHash(v: unknown): string {
  return JSON.stringify(v); // good enough for spike
}

export function startSnapshotLoop(registry: Registry) {
  let rafId: number;
  function tick() {
    const nodes = registry.snapshot();
    const hash = stableHash(nodes);
    if (hash !== lastHash) {
      lastHash = hash;
      sendFrame({ mode: "live", version: PROTOCOL_VERSION, seq: ++seq, ts: Date.now(), nodes });
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(rafId);
}
