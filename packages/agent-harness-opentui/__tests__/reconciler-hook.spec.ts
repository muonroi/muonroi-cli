import type { LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOpenTUIHarness } from "../src/install.js";
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
    expect(frame!.version).toBe("0.4.0");
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

// ---------------------------------------------------------------------------
// installOpenTUIHarness tests
// ---------------------------------------------------------------------------

describe("installOpenTUIHarness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls transport.send exactly once with a JSON string containing mode:live on first tick", () => {
    const registry = createSemanticRegistry();
    registry.register({ id: "btn", role: "button", name: "OK" });

    const transport = { send: vi.fn() };
    installOpenTUIHarness({ registry, transport });

    // Advance one interval (default 60fps ≈ 17ms)
    vi.advanceTimersByTime(20);

    expect(transport.send).toHaveBeenCalledTimes(1);
    const arg = transport.send.mock.calls[0][0] as string;
    expect(() => JSON.parse(arg)).not.toThrow();
    const parsed = JSON.parse(arg) as LiveFrame;
    expect(parsed.mode).toBe("live");
  });

  it("uninstall() stops polling — subsequent ticks do not call send", () => {
    const registry = createSemanticRegistry();
    registry.register({ id: "x", role: "button" });

    const transport = { send: vi.fn() };
    const uninstall = installOpenTUIHarness({ registry, transport });

    // First tick emits
    vi.advanceTimersByTime(20);
    expect(transport.send).toHaveBeenCalledTimes(1);

    uninstall();

    // After uninstall, further ticks must not emit
    vi.advanceTimersByTime(200);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("uninstall() calls transport.close() if provided", () => {
    const registry = createSemanticRegistry();
    const transport = { send: vi.fn(), close: vi.fn() };
    const uninstall = installOpenTUIHarness({ registry, transport });

    uninstall();

    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("dedup: second tick with no registry change does not call send again", () => {
    const registry = createSemanticRegistry();
    registry.register({ id: "a", role: "button" });

    const transport = { send: vi.fn() };
    installOpenTUIHarness({ registry, transport });

    // Advance two intervals — second tick should be deduped
    vi.advanceTimersByTime(50);

    // Should still be 1 — second and later ticks are suppressed by dedup
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("transport.send throws → next tick still works (no swallowed state)", () => {
    const registry = createSemanticRegistry();
    registry.register({ id: "a", role: "button" });

    let callCount = 0;
    const transport = {
      send: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("simulated transport error");
        }
      }),
    };
    installOpenTUIHarness({ registry, transport });

    // First tick — throws inside send; should not crash the interval
    vi.advanceTimersByTime(20);
    expect(transport.send).toHaveBeenCalledTimes(1);

    // Update registry so dedup doesn't suppress the second tick
    registry.register({ id: "b", role: "button" });

    // Second tick — should succeed
    vi.advanceTimersByTime(20);
    expect(transport.send).toHaveBeenCalledTimes(2);
    // Third tick after no change — deduped
    vi.advanceTimersByTime(20);
    expect(transport.send).toHaveBeenCalledTimes(2);
  });
});
