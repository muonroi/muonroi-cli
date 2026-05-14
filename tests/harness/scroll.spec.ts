/**
 * scroll.spec.ts
 *
 * Goal: find a scrollable listbox, press Down many times, assert
 * props.scrollTop advances.
 *
 * Investigation result:
 * - src/agent-harness/selector.ts does reference props.scrollTop as a
 *   selectable attribute (for CSS-like prop matching), but no component in
 *   src/ui/ registers a <Semantic role="listbox" props={{ scrollTop: N }}> node.
 * - The app uses <SemanticProvider> at the root but has zero <Semantic>
 *   components wired — LiveFrame.nodes is always empty in practice.
 * - The council picker (if it existed as a modal) would need to expose a
 *   listbox with many items AND emit props.scrollTop changes on each Down press.
 * - No fixture currently generates a 200-item scrollable list because the
 *   mock-llm fixture only controls text responses, not UI node trees.
 *
 * What would be needed to enable this test:
 *   1. Wire a <Semantic id="some-listbox" role="listbox" props={{ scrollTop }}> to
 *      a real scrollable list in the TUI (e.g. model picker, MCP browser list).
 *   2. Ensure the TUI updates props.scrollTop as the list scrolls.
 *   3. Populate that list with enough items (>20) that Down presses actually scroll.
 */

import { describe, it } from "vitest";

describe("scroll E2E", () => {
  it.todo(
    "no scrollable listbox exposes props.scrollTop: the TUI has no <Semantic role='listbox' props={{ scrollTop }}> wired; LiveFrame.nodes is always empty so scroll position cannot be observed via the driver",
  );

  it.todo(
    "no fixture currently provides a 200-item scrollable list: mock-llm fixture controls only LLM text responses, not UI node population; a separate fixture mechanism would be needed",
  );
});
