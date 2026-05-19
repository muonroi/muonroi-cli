import { describe, expect, it } from "vitest";
import { emitDesignSpec } from "../design-output.js";

describe("design-output", () => {
  it("emits a valid DesignSpec for a single scene", () => {
    const spec = emitDesignSpec({
      scenes: [
        {
          id: "composer",
          name: "Composer",
          layout: {
            id: "root",
            role: "dialog",
            children: [{ id: "input", role: "textbox" }],
          },
          states: [{ name: "loading", patches: [{ id: "input", state: "loading" }] }],
        },
      ],
    });
    expect(spec.mode).toBe("design");
    expect(spec.version).toBe("0.4.0");
    expect(spec.scenes[0].id).toBe("composer");
  });

  it("rejects orphan patches (id not in layout)", () => {
    expect(() =>
      emitDesignSpec({
        scenes: [
          {
            id: "a",
            name: "A",
            layout: { id: "root", role: "dialog" },
            states: [{ name: "x", patches: [{ id: "missing", state: "loading" }] }],
          },
        ],
      }),
    ).toThrow(/patch references unknown id/);
  });
});
