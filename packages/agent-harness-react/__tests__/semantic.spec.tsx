/**
 * semantic.spec.tsx — Basic render + registry assertion tests for
 * <SemanticProvider> and <Semantic>.
 */
import { createSemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Semantic, SemanticProvider } from "../src/semantic.js";

afterEach(() => {
  cleanup();
});

describe("<Semantic> + <SemanticProvider>", () => {
  it("registers a node with the registry on mount", async () => {
    const r = createSemanticRegistry();

    render(
      <SemanticProvider registry={r}>
        <Semantic id="x" role="button">
          hello
        </Semantic>
      </SemanticProvider>,
    );

    // useEffect runs asynchronously after paint; wait a tick
    await Promise.resolve();

    const snap = r.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0].id).toBe("x");
    expect(snap.nodes[0].role).toBe("button");
  });

  it("unregisters on unmount", async () => {
    const r = createSemanticRegistry();
    const { unmount } = render(
      <SemanticProvider registry={r}>
        <Semantic id="y" role="dialog">
          content
        </Semantic>
      </SemanticProvider>,
    );

    await Promise.resolve();
    expect(r.snapshot().nodes).toHaveLength(1);

    unmount();
    await Promise.resolve();
    expect(r.snapshot().nodes).toHaveLength(0);
  });

  it("propagates parentId to nested <Semantic>", async () => {
    const r = createSemanticRegistry();

    render(
      <SemanticProvider registry={r}>
        <Semantic id="parent" role="region">
          <Semantic id="child" role="button">
            click
          </Semantic>
        </Semantic>
      </SemanticProvider>,
    );

    await Promise.resolve();

    const snap = r.snapshot();
    // Parent node at root, child nested inside
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0].id).toBe("parent");
    expect(snap.nodes[0].children).toHaveLength(1);
    expect(snap.nodes[0].children?.[0].id).toBe("child");
  });

  it("forwards optional props (name, value, state)", async () => {
    const r = createSemanticRegistry();

    render(
      <SemanticProvider registry={r}>
        <Semantic id="z" role="textbox" name="Search" value="foo" state="active">
          <input />
        </Semantic>
      </SemanticProvider>,
    );

    await Promise.resolve();

    const snap = r.snapshot();
    expect(snap.nodes[0].name).toBe("Search");
    expect(snap.nodes[0].value).toBe("foo");
    expect(snap.nodes[0].state).toBe("active");
  });

  it("renders children without adding DOM nodes", () => {
    const r = createSemanticRegistry();
    const { container } = render(
      <SemanticProvider registry={r}>
        <Semantic id="wrap" role="region">
          <span id="inner">text</span>
        </Semantic>
      </SemanticProvider>,
    );

    // Only the span should be in the DOM — no wrapper divs from <Semantic>
    expect(container.querySelector("#inner")).toBeTruthy();
    // Container direct child should be the span (or a text node), not an extra wrapper
    const elements = Array.from(container.children);
    expect(elements).toHaveLength(1);
    expect(elements[0].tagName.toLowerCase()).toBe("span");
  });
});
