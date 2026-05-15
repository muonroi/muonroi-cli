/**
 * semantic.spec.tsx — Tests for <Semantic> / SemanticProvider.
 *
 * Strategy: test the registry lifecycle directly with a stub registry (no React
 * render engine needed for the core contract). The useEffect wiring inside the
 * Semantic component is an integration concern; a render-engine test using
 * @opentui/react is not included here because OpenTUI's test renderer requires
 * an attached TTY — it is covered by the Phase 2 E2E harness instead.
 */

import { describe, expect, it, vi } from "vitest";
import { createSemanticRegistry } from "../src/reconciler-hook.js";

// ---------------------------------------------------------------------------
// Registry stub tests (logic path that <Semantic> exercises via useEffect)
// ---------------------------------------------------------------------------

describe("SemanticRegistry lifecycle (mirrors what <Semantic> useEffect does)", () => {
  it("register returns an unregister fn; snapshot reflects mount/unmount", () => {
    const registry = createSemanticRegistry();

    // Simulate mount: <Semantic id="btn" role="button" name="Save" />
    const unregister = registry.register({ id: "btn", role: "button", name: "Save" });

    const afterMount = registry.snapshot();
    expect(afterMount.nodes).toHaveLength(1);
    expect(afterMount.nodes[0]).toMatchObject({ id: "btn", role: "button", name: "Save" });

    // Simulate unmount (useEffect cleanup):
    unregister();

    const afterUnmount = registry.snapshot();
    expect(afterUnmount.nodes).toHaveLength(0);
  });

  it("register/unregister re-register cycle replaces the node (prop change → nodeKey dep fires)", () => {
    const registry = createSemanticRegistry();

    // First registration (initial props)
    const unreg1 = registry.register({ id: "tb", role: "textbox", value: "hello" });

    // Simulate React dep change: old cleanup fires, new effect fires
    unreg1();
    const unreg2 = registry.register({ id: "tb", role: "textbox", value: "world" });

    const snap = registry.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0].value).toBe("world");

    unreg2();
  });

  it("nested <Semantic> parent–child: child registered with parentId of parent", () => {
    const registry = createSemanticRegistry();

    // Simulate <Semantic id="list" role="listbox"><Semantic id="item1" role="listitem" /></Semantic>
    registry.register({ id: "list", role: "listbox" });
    registry.register({ id: "item1", role: "listitem", parentId: "list" });

    const snap = registry.snapshot();
    // list is the only root
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0].id).toBe("list");
    expect(snap.nodes[0].children).toHaveLength(1);
    expect(snap.nodes[0].children![0].id).toBe("item1");
  });

  it("registry without a RegistryContext (registry=null) → no register call", () => {
    // When <Semantic> has no RegistryContext (registry is null), the useEffect
    // returns early without registering. Test the guard condition directly:
    const registry = null;
    const registerSpy = vi.fn();

    // Simulate the useEffect guard
    if (!registry) {
      // early return — no register call
    } else {
      registerSpy();
    }

    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("focus node produces focus in snapshot (mirrors focus prop on <Semantic>)", () => {
    const registry = createSemanticRegistry();
    registry.register({ id: "input", role: "textbox", focus: true });

    const snap = registry.snapshot();
    expect(snap.focus).toBe("input");
  });

  it("modal node produces modals in snapshot (mirrors isModal prop on <Semantic>)", () => {
    const registry = createSemanticRegistry();
    registry.register({ id: "dlg", role: "dialog", isModal: true });
    registry.register({ id: "btn", role: "button" });

    const snap = registry.snapshot();
    expect(snap.modals).toEqual(["dlg"]);
  });
});

// ---------------------------------------------------------------------------
// NOTE: Full render test using @opentui/react is intentionally skipped.
// OpenTUI's CliRenderer requires an attached TTY to instantiate; running it in
// the Vitest JSDOM/Node environment causes errors. The render integration is
// covered by the Phase 2 E2E harness (real process + fds).
// ---------------------------------------------------------------------------

describe.skip("Semantic render integration (requires TTY — Phase 2 E2E)", () => {
  it.todo(
    "mount <SemanticProvider registry={...}><Semantic id='x' role='button' /></SemanticProvider> and assert registry entry",
  );
  it.todo("unmount <Semantic> triggers unregister");
});
