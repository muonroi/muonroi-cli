import type { LiveFrame } from "@muonroi/agent-harness-core/protocol";
import {
  createSemanticRegistry,
  type SemanticNodeInput,
  type SemanticRegistry,
} from "@muonroi/agent-harness-core/registry";

export type { LiveFrame };
// Re-export for backwards-compat: consumers that previously imported from here still work.
export { createSemanticRegistry, type SemanticNodeInput, type SemanticRegistry };

// ---------------------------------------------------------------------------
// Stable JSON stringify (sorts keys recursively)
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

// ---------------------------------------------------------------------------
// ReconcilerHook
// ---------------------------------------------------------------------------

export type ReconcilerHook = {
  /** Build a LiveFrame from the registry. Returns null if content unchanged (dedup). */
  capture(): LiveFrame | null;
  /** Reset dedup state so the next capture always emits. */
  resetDedup(): void;
};

export function createReconcilerHook(opts: {
  registry: SemanticRegistry;
  getSeq: () => number;
  getTs: () => number;
}): ReconcilerHook {
  const { registry, getSeq, getTs } = opts;
  let lastHash: string | undefined;

  function capture(): LiveFrame | null {
    const snap = registry.snapshot();

    // Build the hash payload in a stable way
    const hashPayload = stableStringify({
      focus: snap.focus ?? null,
      modals: snap.modals ?? null,
      nodes: snap.nodes,
    });

    if (lastHash !== undefined && lastHash === hashPayload) {
      return null; // dedup — no change
    }
    lastHash = hashPayload;

    const frame: LiveFrame = {
      mode: "live",
      version: "0.2.0",
      seq: getSeq(),
      ts: getTs(),
      nodes: snap.nodes,
    };
    if (snap.focus !== undefined) frame.focus = snap.focus;
    if (snap.modals !== undefined) frame.modals = snap.modals;

    return frame;
  }

  function resetDedup(): void {
    lastHash = undefined;
  }

  return { capture, resetDedup };
}
