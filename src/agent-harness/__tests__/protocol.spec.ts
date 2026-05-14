import { describe, expect, it } from "vitest";
import type { DesignSpec, LiveFrame, UINode } from "../protocol";

describe("protocol types", () => {
  it("compiles a minimal LiveFrame", () => {
    const frame: LiveFrame = {
      mode: "live",
      version: "0.1.0",
      seq: 0,
      ts: 0,
      nodes: [],
    };
    expect(frame.mode).toBe("live");
  });

  it("compiles a UINode with all flags", () => {
    const node: UINode = {
      id: "a",
      role: "button",
      name: "OK",
      focus: true,
      selected: true,
      disabled: true,
      hidden: true,
      state: "loading",
      props: { pct: 50 },
      children: [],
    };
    expect(node.id).toBe("a");
  });

  it("compiles a DesignSpec with state patches", () => {
    const spec: DesignSpec = {
      mode: "design",
      version: "0.1.0",
      scenes: [
        {
          id: "s1",
          name: "Composer",
          layout: { id: "root", role: "dialog" },
          states: [{ name: "loading", patches: [{ id: "root", state: "loading" }] }],
        },
      ],
    };
    expect(spec.scenes.length).toBe(1);
  });
});
