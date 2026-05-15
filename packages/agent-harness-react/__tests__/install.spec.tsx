/**
 * install.spec.tsx — Snapshot flush loop tests for installReactHarness.
 *
 * Verifies:
 * 1. Mount → 3 ticks → exactly 1 frame emitted (dedup works)
 * 2. Unmount → 1 more tick → exactly 1 additional frame (unmount change)
 * 3. Total = 2 frames for mount + unmount cycle
 * 4. No frames emitted when registry content doesn't change
 */
import { createSemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { act, cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installReactHarness } from "../src/install.js";
import { Semantic, SemanticProvider } from "../src/semantic.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helper: collect frames emitted by the transport
// ---------------------------------------------------------------------------
function makeCapture() {
  const frames: unknown[] = [];
  const transport = {
    send(line: string) {
      frames.push(JSON.parse(line));
    },
    close: vi.fn(),
  };
  return { frames, transport };
}

// ---------------------------------------------------------------------------
// Test 1: mount → 3 ticks → 1 frame
// ---------------------------------------------------------------------------

describe("installReactHarness snapshot loop", () => {
  it("emits exactly 1 frame for mount (dedup suppresses subsequent ticks)", async () => {
    vi.useFakeTimers();
    const r = createSemanticRegistry();
    const { frames, transport } = makeCapture();

    render(
      <SemanticProvider registry={r}>
        <Semantic id="btn" role="button" name="Click me">
          click
        </Semantic>
      </SemanticProvider>,
    );

    // Let useEffect register the node
    await act(async () => {
      await Promise.resolve();
    });

    const handle = installReactHarness({ registry: r, transport, fps: 30 });

    // Advance 3 ticks (setInterval fallback since no rAF in happy-dom)
    await act(async () => {
      vi.advanceTimersByTime(100); // ~3 ticks at 30fps (33ms each)
    });

    // Content unchanged after first tick — dedup should suppress ticks 2 & 3
    expect(frames).toHaveLength(1);
    expect((frames[0] as { dir: string }).dir).toBe("frame");
    expect((frames[0] as { nodes: unknown[] }).nodes[0]).toMatchObject({ id: "btn", role: "button" });

    handle.uninstall();
  });

  it("emits 1 more frame after unmount (registry becomes empty)", async () => {
    vi.useFakeTimers();
    const r = createSemanticRegistry();
    const { frames, transport } = makeCapture();

    const { unmount } = render(
      <SemanticProvider registry={r}>
        <Semantic id="btn2" role="button">
          click
        </Semantic>
      </SemanticProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const handle = installReactHarness({ registry: r, transport, fps: 30 });

    // Tick 1 — mount frame
    await act(async () => {
      vi.advanceTimersByTime(34); // 1 tick
    });
    expect(frames).toHaveLength(1);

    // Unmount — unregisters the node
    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    // Tick 2 — unmount frame (registry is now empty)
    await act(async () => {
      vi.advanceTimersByTime(34);
    });
    expect(frames).toHaveLength(2);

    // Ticks 3+ should NOT emit (empty registry, content unchanged)
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(frames).toHaveLength(2);

    handle.uninstall();
  });

  it("calls transport.close() on uninstall", async () => {
    vi.useFakeTimers();
    const r = createSemanticRegistry();
    const { transport } = makeCapture();
    const closeSpy = transport.close;

    const handle = installReactHarness({ registry: r, transport, fps: 30 });
    handle.uninstall();

    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("stops emitting after uninstall", async () => {
    vi.useFakeTimers();
    const r = createSemanticRegistry();
    const { frames, transport } = makeCapture();

    render(
      <SemanticProvider registry={r}>
        <Semantic id="btn3" role="button">
          x
        </Semantic>
      </SemanticProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const handle = installReactHarness({ registry: r, transport, fps: 30 });

    await act(async () => {
      vi.advanceTimersByTime(34);
    });

    const countAfterFirstTick = frames.length; // 1

    handle.uninstall();

    // Even after uninstall, ticking timer should not emit more frames
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(frames.length).toBe(countAfterFirstTick);
  });
});
