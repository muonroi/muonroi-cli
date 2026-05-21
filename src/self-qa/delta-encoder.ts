/**
 * delta-encoder.ts — M3 of Self-QA.
 *
 * Diffs two LiveFrames and emits only the changed UINodes. Keeps the
 * outer-agent token cost flat regardless of UI tree size — the agent
 * sees what *changed*, not the entire frame on every tick.
 *
 * Algorithm:
 *   1. Build flat id→UINode maps for both frames.
 *   2. added   = ids in `next` not in `prev`
 *   3. removed = ids in `prev` not in `next`
 *   4. changed = ids in both whose user-visible fields differ
 *   5. focusChanged / modalsChanged tracked separately.
 *
 * Children traversal is depth-first and treats nodes as identity-keyed by `id`.
 */

import type { LiveFrame, UINode } from "@muonroi/agent-harness-core/protocol";
import type { FrameDelta } from "./types.js";

type ChangeField = Partial<Pick<UINode, "name" | "value" | "state" | "focus" | "selected" | "disabled" | "hidden">>;

const TRACKED_FIELDS = ["name", "value", "state", "focus", "selected", "disabled", "hidden"] as const;

/**
 * Compute a FrameDelta from `prev` to `next`. Pass `prev === null` for the
 * first frame — the result will have all nodes as `added` and `baseSeq=null`.
 */
export function encodeDelta(prev: LiveFrame | null, next: LiveFrame): FrameDelta {
  const prevMap = prev ? indexNodes(prev.nodes) : new Map<string, UINode>();
  const nextMap = indexNodes(next.nodes);

  const added: UINode[] = [];
  const removed: string[] = [];
  const changed: FrameDelta["changed"] = [];

  for (const [id, node] of nextMap) {
    if (!prevMap.has(id)) {
      added.push(stripChildren(node));
    } else {
      const diff = diffFields(prevMap.get(id)!, node);
      if (diff) changed.push({ id, fields: diff });
    }
  }

  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) removed.push(id);
  }

  const delta: FrameDelta = {
    seq: next.seq,
    baseSeq: prev?.seq ?? null,
    added,
    removed,
    changed,
  };

  if (prev?.focus !== next.focus) {
    delta.focusChanged = { from: prev?.focus, to: next.focus };
  }

  const prevModals = prev?.modals ?? [];
  const nextModals = next.modals ?? [];
  if (!arraysEqual(prevModals, nextModals)) {
    delta.modalsChanged = { from: prevModals, to: nextModals };
  }

  return delta;
}

/**
 * Re-apply a delta on top of a previous frame to reconstruct the next.
 * Useful for tests and for any consumer that wants to materialise state
 * without storing every frame.
 */
export function applyDelta(prev: LiveFrame | null, delta: FrameDelta): LiveFrame {
  const map = prev ? indexNodes(prev.nodes) : new Map<string, UINode>();

  for (const id of delta.removed) map.delete(id);
  for (const node of delta.added) map.set(node.id, node);
  for (const c of delta.changed) {
    const existing = map.get(c.id);
    if (!existing) continue;
    map.set(c.id, { ...existing, ...c.fields });
  }

  const nodes = [...map.values()];
  return {
    mode: "live",
    version: prev?.version ?? "0.4.0",
    seq: delta.seq,
    ts: Date.now(),
    focus: delta.focusChanged ? delta.focusChanged.to : prev?.focus,
    modals: delta.modalsChanged ? delta.modalsChanged.to : prev?.modals,
    nodes,
  };
}

/**
 * Estimate the wire-size savings of a delta vs. the full next frame.
 * Returns the compression ratio as a number in [0, 1], where smaller is better.
 * Useful for budget tuning.
 */
export function compressionRatio(next: LiveFrame, delta: FrameDelta): number {
  const fullSize = JSON.stringify(next).length;
  const deltaSize = JSON.stringify(delta).length;
  if (fullSize === 0) return 1;
  return deltaSize / fullSize;
}

function indexNodes(nodes: UINode[]): Map<string, UINode> {
  const out = new Map<string, UINode>();
  walk(nodes, (n) => out.set(n.id, n));
  return out;
}

function walk(nodes: UINode[], cb: (n: UINode) => void): void {
  for (const n of nodes) {
    cb(n);
    if (n.children) walk(n.children, cb);
  }
}

function stripChildren(node: UINode): UINode {
  // Keep children for `added` because the outer agent needs context, but
  // recurse via the index so each subtree node was already emitted.
  // We return shallow copy without `children` to avoid double-emission.
  const { children: _children, ...rest } = node;
  return rest as UINode;
}

function diffFields(prev: UINode, next: UINode): ChangeField | null {
  const out: ChangeField = {};
  let dirty = false;
  for (const f of TRACKED_FIELDS) {
    if (prev[f] !== next[f]) {
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous union write
      (out as any)[f] = next[f];
      dirty = true;
    }
  }
  return dirty ? out : null;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
