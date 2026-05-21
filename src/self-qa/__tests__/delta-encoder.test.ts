import type { LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";
import { applyDelta, compressionRatio, encodeDelta } from "../delta-encoder.js";

const baseFrame = (nodes: LiveFrame["nodes"], extra: Partial<LiveFrame> = {}): LiveFrame => ({
  mode: "live",
  version: "0.4.0",
  seq: 1,
  ts: Date.now(),
  nodes,
  ...extra,
});

describe("delta-encoder", () => {
  it("marks every node as added on first frame", () => {
    const next = baseFrame([
      { id: "a", role: "region" },
      { id: "b", role: "button" },
    ]);
    const d = encodeDelta(null, next);
    expect(d.baseSeq).toBeNull();
    expect(d.added.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it("detects added + removed + changed in one pass", () => {
    const prev = baseFrame([
      { id: "a", role: "region", name: "old" },
      { id: "b", role: "button" },
    ]);
    const next = baseFrame(
      [
        { id: "a", role: "region", name: "new" },
        { id: "c", role: "textbox" },
      ],
      { seq: 2 },
    );
    const d = encodeDelta(prev, next);
    expect(d.added.map((n) => n.id)).toEqual(["c"]);
    expect(d.removed).toEqual(["b"]);
    expect(d.changed).toEqual([{ id: "a", fields: { name: "new" } }]);
    expect(d.baseSeq).toBe(1);
  });

  it("emits focusChanged and modalsChanged when those change", () => {
    const prev = baseFrame([{ id: "a", role: "region" }], { focus: "a", modals: [] });
    const next = baseFrame([{ id: "a", role: "region" }], {
      focus: "b",
      modals: ["m1"],
      seq: 2,
    });
    const d = encodeDelta(prev, next);
    expect(d.focusChanged).toEqual({ from: "a", to: "b" });
    expect(d.modalsChanged).toEqual({ from: [], to: ["m1"] });
  });

  it("recurses into children for indexing", () => {
    const prev = baseFrame([
      {
        id: "root",
        role: "region",
        children: [{ id: "leaf", role: "button", name: "x" }],
      },
    ]);
    const next = baseFrame(
      [
        {
          id: "root",
          role: "region",
          children: [{ id: "leaf", role: "button", name: "y" }],
        },
      ],
      { seq: 2 },
    );
    const d = encodeDelta(prev, next);
    expect(d.changed).toEqual([{ id: "leaf", fields: { name: "y" } }]);
  });

  it("applyDelta reconstructs node set (id-level)", () => {
    const prev = baseFrame([
      { id: "a", role: "region", name: "old" },
      { id: "b", role: "button" },
    ]);
    const next = baseFrame(
      [
        { id: "a", role: "region", name: "new" },
        { id: "c", role: "textbox" },
      ],
      { seq: 2, focus: "c" },
    );
    const d = encodeDelta(prev, next);
    const reconstructed = applyDelta(prev, d);
    const ids = reconstructed.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["a", "c"]);
    expect(reconstructed.nodes.find((n) => n.id === "a")?.name).toBe("new");
    expect(reconstructed.focus).toBe("c");
  });

  it("compressionRatio drops below 0.3 for tiny changes in large trees", () => {
    const bigChildren = Array.from({ length: 100 }, (_, i) => ({
      id: `n${i}`,
      role: "listitem" as const,
      name: `item ${i}`,
    }));
    const prev = baseFrame([{ id: "list", role: "listbox", children: bigChildren }]);
    const nextChildren = bigChildren.map((n, i) => (i === 50 ? { ...n, name: "changed" } : n));
    const next = baseFrame([{ id: "list", role: "listbox", children: nextChildren }], { seq: 2 });
    const d = encodeDelta(prev, next);
    expect(d.changed).toHaveLength(1);
    expect(compressionRatio(next, d)).toBeLessThan(0.3);
  });
});
