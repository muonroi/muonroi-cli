import { createSemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// SemanticRegistry — pure unit tests (no OpenTUI dependency)
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

  it("unregister a parent: parent is absent from snapshot", () => {
    const reg = createSemanticRegistry();
    const unregList = reg.register({ id: "list", role: "listbox" });
    reg.register({ id: "item1", role: "listitem", parentId: "list" });

    unregList();
    // item1 still exists in the map but parentId "list" no longer resolves;
    // it is treated as an orphan root. Parent must be absent.
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

  it("update on unknown id is a no-op (does not throw)", () => {
    const reg = createSemanticRegistry();
    expect(() => reg.update("nonexistent", { value: "x" })).not.toThrow();
    expect(reg.snapshot().nodes).toHaveLength(0);
  });

  it("orphaned child (parent absent from registration) is promoted to root", () => {
    const reg = createSemanticRegistry();
    // Register child with a parentId that was never registered
    reg.register({ id: "orphan", role: "listitem", parentId: "ghost-parent" });

    const snap = reg.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0].id).toBe("orphan");
  });
});
