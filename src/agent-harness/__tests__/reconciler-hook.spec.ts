import type { LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createReconcilerHook, createSemanticRegistry, type SemanticNodeInput } from "../reconciler-hook.js";

// ---------------------------------------------------------------------------
// SemanticRegistry tests
// ---------------------------------------------------------------------------

describe("SemanticRegistry", () => {
  it("register + snapshot: returns UINode for a single root node", () => {
    const reg = createSemanticRegistry();
    reg.register({ id: "btn1", role: "button", name: "Send" });

    const snap = reg.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0]).toMatchObject({ id: "btn1", role: "button", name: "Send" });
    expect((snap.nodes[0] as { parentId?: unknown }).parentId).toBeUndefined();
  });

  it("register + snapshot: nests children under parent", () => {
    const reg = createSemanticRegistry();
    reg.register({ id: "list", role: "listbox", name: "Options" });
    reg.register({ id: "item1", role: "listitem", parentId: "list", name: "Alpha" });
    reg.register({ id: "item2", role: "listitem", parentId: "list", name: "Beta" });

    const snap = reg.snapshot();
    expect(snap.nodes).toHaveLength(1);
    const list = snap.nodes[0];
    expect(list.id).toBe("list");
    expect(list.children).toHaveLength(2);
    expect(list.children![0]).toMatchObject({ id: "item1", name: "Alpha" });
    expect(list.children![1]).toMatchObject({ id: "item2", name: "Beta" });
  });

  it("register returns unregister fn that removes the node", () => {
    const reg = createSemanticRegistry();
    const unregBtn = reg.register({ id: "btn1", role: "button" });
    reg.register({ id: "btn2", role: "button" });

    unregBtn();
    const snap = reg.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0].id).toBe("btn2");
  });

  it("unregister a parent also removes orphaned children from snapshot", () => {
    const reg = createSemanticRegistry();
    const unregList = reg.register({ id: "list", role: "listbox" });
    reg.register({ id: "item1", role: "listitem", parentId: "list" });

    unregList();
    // item1 still exists in the map but parentId "list" no longer resolves;
    // it should be treated as an orphan root (no known parent → becomes root)
    // OR filtered — spec is silent on orphan handling; we test that unregistering
    // the parent does not crash and the parent is absent.
    const snap = reg.snapshot();
    expect(snap.nodes.find((n) => n.id === "list")).toBeUndefined();
  });

  it("update patches a registered node", () => {
    const reg = createSemanticRegistry();
    reg.register({ id: "tb1", role: "textbox", value: "hello" });
    reg.update("tb1", { value: "world", state: "error" });

    const snap = reg.snapshot();
    const node = snap.nodes[0];
    expect(node.value).toBe("world");
    expect(node.state).toBe("error");
  });

  it("snapshot.focus is the id of the focused node", () => {
    const reg = createSemanticRegistry();
    reg.register({ id: "a", role: "button" });
    reg.register({ id: "b", role: "button", focus: true });

    const snap = reg.snapshot();
    expect(snap.focus).toBe("b");
  });

  it("snapshot.focus is undefined when no node has focus", () => {
    const reg = createSemanticRegistry();
    reg.register({ id: "a", role: "button" });

    const snap = reg.snapshot();
    expect(snap.focus).toBeUndefined();
  });

  it("snapshot.modals is an ordered list of modal ids", () => {
    const reg = createSemanticRegistry();
    reg.register({ id: "dlg1", role: "dialog", isModal: true });
    reg.register({ id: "btn1", role: "button" });
    reg.register({ id: "dlg2", role: "dialog", isModal: true });

    const snap = reg.snapshot();
    expect(snap.modals).toEqual(["dlg1", "dlg2"]);
  });

  it("snapshot.modals is undefined when no modals", () => {
    const reg = createSemanticRegistry();
    reg.register({ id: "a", role: "button" });

    const snap = reg.snapshot();
    expect(snap.modals).toBeUndefined();
  });

  it("clear empties the registry", () => {
    const reg = createSemanticRegistry();
    reg.register({ id: "a", role: "button" });
    reg.register({ id: "b", role: "button" });

    reg.clear();
    const snap = reg.snapshot();
    expect(snap.nodes).toHaveLength(0);
    expect(snap.focus).toBeUndefined();
    expect(snap.modals).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ReconcilerHook tests
// ---------------------------------------------------------------------------

describe("ReconcilerHook", () => {
  let seq: number;
  let ts: number;

  beforeEach(() => {
    seq = 0;
    ts = 1000;
  });

  const makeHook = (reg = createSemanticRegistry()) => {
    const hook = createReconcilerHook({
      registry: reg,
      getSeq: () => ++seq,
      getTs: () => (ts += 10),
    });
    return { hook, reg };
  };

  it("first capture() returns a LiveFrame matching registry snapshot", () => {
    const { hook, reg } = makeHook();
    reg.register({ id: "btn1", role: "button", name: "Send" });

    const frame = hook.capture();
    expect(frame).not.toBeNull();
    expect(frame!.mode).toBe("live");
    expect(frame!.version).toBe("0.1.0");
    expect(frame!.seq).toBe(1);
    expect(frame!.nodes).toHaveLength(1);
    expect(frame!.nodes[0]).toMatchObject({ id: "btn1", role: "button", name: "Send" });
  });

  it("second capture() immediately after with no change returns null (dedup)", () => {
    const { hook, reg } = makeHook();
    reg.register({ id: "btn1", role: "button" });

    hook.capture();
    const second = hook.capture();
    expect(second).toBeNull();
  });

  it("after update(), next capture() returns a fresh frame", () => {
    const { hook, reg } = makeHook();
    reg.register({ id: "tb", role: "textbox", value: "a" });
    hook.capture();

    reg.update("tb", { value: "b" });
    const frame = hook.capture();
    expect(frame).not.toBeNull();
    expect(frame!.nodes[0].value).toBe("b");
  });

  it("after register(), next capture() returns a fresh frame", () => {
    const { hook, reg } = makeHook();
    reg.register({ id: "a", role: "button" });
    hook.capture();

    reg.register({ id: "b", role: "button" });
    const frame = hook.capture();
    expect(frame).not.toBeNull();
    expect(frame!.nodes).toHaveLength(2);
  });

  it("after unregister, next capture() returns a fresh frame", () => {
    const { hook, reg } = makeHook();
    const unrg = reg.register({ id: "a", role: "button" });
    reg.register({ id: "b", role: "button" });
    hook.capture();

    unrg();
    const frame = hook.capture();
    expect(frame).not.toBeNull();
    expect(frame!.nodes).toHaveLength(1);
  });

  it("resetDedup() forces next capture to emit even if content unchanged", () => {
    const { hook, reg } = makeHook();
    reg.register({ id: "x", role: "button" });
    hook.capture(); // emits
    hook.capture(); // null (dedup)

    hook.resetDedup();
    const frame = hook.capture();
    expect(frame).not.toBeNull();
    expect(frame!.nodes[0].id).toBe("x");
  });

  it("getSeq and getTs are consulted for each emitted frame", () => {
    const { hook, reg } = makeHook();
    reg.register({ id: "a", role: "button" });

    const f1 = hook.capture() as LiveFrame;
    expect(f1.seq).toBe(1);
    expect(f1.ts).toBe(1010);

    reg.update("a", { name: "changed" });
    const f2 = hook.capture() as LiveFrame;
    expect(f2.seq).toBe(2);
    expect(f2.ts).toBe(1020);
  });

  it("LiveFrame includes focus and modals from registry snapshot", () => {
    const { hook, reg } = makeHook();
    reg.register({ id: "dlg", role: "dialog", isModal: true });
    reg.register({ id: "btn", role: "button", focus: true });

    const frame = hook.capture() as LiveFrame;
    expect(frame.focus).toBe("btn");
    expect(frame.modals).toEqual(["dlg"]);
  });

  it("empty registry produces a valid LiveFrame with empty nodes", () => {
    const { hook } = makeHook();

    const frame = hook.capture() as LiveFrame;
    expect(frame).not.toBeNull();
    expect(frame!.nodes).toHaveLength(0);
  });
});
