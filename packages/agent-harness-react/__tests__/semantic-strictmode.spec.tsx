/**
 * semantic-strictmode.spec.tsx — StrictMode double-mount, Suspense replay,
 * and nested parent-child linkage tests.
 *
 * Task 3.2a scenarios:
 * 1. StrictMode double-mount: register → unregister → register → unregister
 *    produces a clean registry on unmount (no leaked entries).
 * 2. Suspense replay: suspend → resume → assert single registration after resume.
 * 3. Nested order: parent + child <Semantic> — snapshot() after both commit
 *    produces correct parentId linkage in the tree.
 */
import { createSemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { act, cleanup, render } from "@testing-library/react";
import React, { Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Semantic, SemanticProvider } from "../src/semantic.js";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Scenario 1 — StrictMode double-mount
// ---------------------------------------------------------------------------

describe("StrictMode double-mount", () => {
  it("leaves no leaked entries after unmount under StrictMode", async () => {
    const r = createSemanticRegistry();

    const { unmount } = render(
      <React.StrictMode>
        <SemanticProvider registry={r}>
          <Semantic id="strict-node" role="button">
            click
          </Semantic>
        </SemanticProvider>
      </React.StrictMode>,
    );

    // Let all effects settle (StrictMode runs effects twice in dev)
    await act(async () => {
      await Promise.resolve();
    });

    // After StrictMode double-mount, exactly 1 node should be registered
    expect(r.snapshot().nodes).toHaveLength(1);
    expect(r.snapshot().nodes[0].id).toBe("strict-node");

    // On unmount, cleanup runs — registry must be empty
    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(r.snapshot().nodes).toHaveLength(0);
  });

  it("handles multiple nodes under StrictMode without leaks", async () => {
    const r = createSemanticRegistry();

    const { unmount } = render(
      <React.StrictMode>
        <SemanticProvider registry={r}>
          <Semantic id="node-a" role="button">
            A
          </Semantic>
          <Semantic id="node-b" role="button">
            B
          </Semantic>
          <Semantic id="node-c" role="button">
            C
          </Semantic>
        </SemanticProvider>
      </React.StrictMode>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(r.snapshot().nodes).toHaveLength(3);

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(r.snapshot().nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Suspense replay
// ---------------------------------------------------------------------------

/**
 * Creates a lazy-loaded component that suspends once, then resolves.
 * On first render it throws a promise; on the second (after the promise
 * resolves) it renders successfully.
 */
function makeSuspendOnce() {
  let resolved = false;
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });

  function LazyChild() {
    if (!resolved) {
      throw promise;
    }
    return <span id="lazy-content">loaded</span>;
  }

  function resolve() {
    resolved = true;
    resolver?.();
  }

  return { LazyChild, resolve };
}

describe("Suspense replay", () => {
  it("produces exactly one registration after suspend + resume", async () => {
    const r = createSemanticRegistry();
    const { LazyChild, resolve } = makeSuspendOnce();

    render(
      <SemanticProvider registry={r}>
        <Suspense fallback={<span>loading...</span>}>
          <Semantic id="suspense-node" role="region">
            <LazyChild />
          </Semantic>
        </Suspense>
      </SemanticProvider>,
    );

    // While suspended, the <Semantic> effect may or may not have fired;
    // the key assertion is AFTER resume.
    await act(async () => {
      resolve();
      // Flush microtasks so the promise resolves and React re-renders
      await Promise.resolve();
      await Promise.resolve();
    });

    const snap = r.snapshot();
    // Exactly one node with id="suspense-node" — no duplicates from double-mount
    const matches = snap.nodes.filter((n) => n.id === "suspense-node");
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Nested parent + child order
// ---------------------------------------------------------------------------

describe("Nested <Semantic> parent-child linkage", () => {
  it("produces correct parent-child tree regardless of useEffect order", async () => {
    const r = createSemanticRegistry();

    render(
      <SemanticProvider registry={r}>
        <Semantic id="outer" role="region" name="Outer">
          <Semantic id="middle" role="region" name="Middle">
            <Semantic id="inner" role="button" name="Inner">
              click
            </Semantic>
          </Semantic>
        </Semantic>
      </SemanticProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const snap = r.snapshot();

    // Root level: only "outer"
    expect(snap.nodes).toHaveLength(1);
    const outer = snap.nodes[0];
    expect(outer.id).toBe("outer");

    // Middle is child of outer
    expect(outer.children).toHaveLength(1);
    const middle = outer.children![0];
    expect(middle.id).toBe("middle");

    // Inner is child of middle
    expect(middle.children).toHaveLength(1);
    const inner = middle.children![0];
    expect(inner.id).toBe("inner");
  });

  it("siblings are all children of the same parent", async () => {
    const r = createSemanticRegistry();

    render(
      <SemanticProvider registry={r}>
        <Semantic id="list" role="listbox">
          <Semantic id="item-1" role="listitem">
            One
          </Semantic>
          <Semantic id="item-2" role="listitem">
            Two
          </Semantic>
          <Semantic id="item-3" role="listitem">
            Three
          </Semantic>
        </Semantic>
      </SemanticProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const snap = r.snapshot();
    expect(snap.nodes).toHaveLength(1);
    const list = snap.nodes[0];
    expect(list.id).toBe("list");
    expect(list.children).toHaveLength(3);
    expect(list.children?.map((c) => c.id)).toEqual(["item-1", "item-2", "item-3"]);
  });
});
