/**
 * Unit tests for the role-fixed semantic primitives.
 *
 * Strategy: the primitives are pure function components (no hooks fire until a
 * real render). We invoke them directly and drill ONE level down —
 * `Primitive(props)` returns a `<Block>` element; `element.type(element.props)`
 * runs `Block` and returns the `<Semantic>` element whose props we assert. This
 * verifies the fixed role + the boolean→flag mirroring without a render engine.
 */

import { describe, expect, it } from "vitest";
import { Button, Dialog, ListItem, Menu, Region, TextBox } from "../semantic-primitives.js";

/** Invoke a primitive, then run its inner <Block> to get the <Semantic> props. */
// biome-ignore lint/suspicious/noExplicitAny: reaching into React element internals for a pure-function assertion
function semanticPropsOf(element: any): Record<string, unknown> {
  // element.type is the internal Block; element.props are the Block props.
  const semanticElement = element.type(element.props);
  return semanticElement.props as Record<string, unknown>;
}

describe("semantic primitives", () => {
  it("fixes the role per primitive (typo-proof)", () => {
    expect(semanticPropsOf(Dialog({ id: "d" })).role).toBe("dialog");
    expect(semanticPropsOf(TextBox({ id: "t" })).role).toBe("textbox");
    expect(semanticPropsOf(Button({ id: "b" })).role).toBe("button");
    expect(semanticPropsOf(ListItem({ id: "l" })).role).toBe("listitem");
    expect(semanticPropsOf(Menu({ id: "m" })).role).toBe("menu");
    expect(semanticPropsOf(Region({ id: "r" })).role).toBe("region");
  });

  it("maps focused=true → focus:true and focused=false/undefined → undefined", () => {
    expect(semanticPropsOf(TextBox({ id: "t", focused: true })).focus).toBe(true);
    expect(semanticPropsOf(TextBox({ id: "t", focused: false })).focus).toBeUndefined();
    expect(semanticPropsOf(TextBox({ id: "t" })).focus).toBeUndefined();
  });

  it("maps selected/disabled/hidden booleans to true|undefined flags", () => {
    const on = semanticPropsOf(ListItem({ id: "l", selected: true, disabled: true, hidden: true }));
    expect(on.selected).toBe(true);
    expect(on.disabled).toBe(true);
    expect(on.hidden).toBe(true);

    const off = semanticPropsOf(ListItem({ id: "l", selected: false }));
    expect(off.selected).toBeUndefined();
    expect(off.disabled).toBeUndefined();
  });

  it("Dialog defaults isModal→true; Menu defaults isModal→true; opt-out works", () => {
    expect(semanticPropsOf(Dialog({ id: "d" })).isModal).toBe(true);
    expect(semanticPropsOf(Menu({ id: "m" })).isModal).toBe(true);
    expect(semanticPropsOf(Dialog({ id: "d", isModal: false })).isModal).toBeUndefined();
  });

  it("Region is not modal by default", () => {
    expect(semanticPropsOf(Region({ id: "r" })).isModal).toBeUndefined();
  });

  it("passes through id / name / value / state / props verbatim", () => {
    const p = semanticPropsOf(
      TextBox({ id: "composer", name: "Prompt", value: "hi", state: "editing", props: { rows: 3 } }),
    );
    expect(p.id).toBe("composer");
    expect(p.name).toBe("Prompt");
    expect(p.value).toBe("hi");
    expect(p.state).toBe("editing");
    expect(p.props).toEqual({ rows: 3 });
  });
});
