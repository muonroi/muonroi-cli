import type { LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createReconcilerHook, createSemanticRegistry } from "../src/reconciler-hook.js";

// Pure SemanticRegistry tests have been moved to:
//   packages/agent-harness-core/__tests__/registry.spec.ts

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
