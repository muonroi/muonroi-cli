import { describe, expect, it } from "vitest";
import type { DesignSpec } from "../protocol.js";
import { diffSpecs, querySpec, validateSpec } from "../spec-helpers.js";

describe("validateSpec", () => {
  it("accepts a valid spec", () => {
    const spec: DesignSpec = {
      mode: "design",
      version: "0.1.0",
      scenes: [{ id: "s", name: "S", layout: { id: "root", role: "dialog" } }],
    };
    expect(validateSpec(spec).ok).toBe(true);
  });

  it("rejects wrong mode", () => {
    const spec = {
      mode: "live",
      version: "0.1.0",
      scenes: [{ id: "s", name: "S", layout: { id: "root", role: "dialog" } }],
    };
    expect(validateSpec(spec).ok).toBe(false);
  });
});

describe("querySpec", () => {
  const spec: DesignSpec = {
    mode: "design",
    version: "0.1.0",
    scenes: [
      {
        id: "s",
        name: "S",
        layout: { id: "root", role: "dialog", children: [{ id: "btn", role: "button", name: "OK" }] },
        states: [{ name: "loading", patches: [{ id: "btn", disabled: true }] }],
      },
    ],
  };

  it("returns base layout when no state", () => {
    const t = querySpec(spec, { scene: "s" });
    expect(t.children![0].disabled).toBeUndefined();
  });

  it("applies state patches", () => {
    const t = querySpec(spec, { scene: "s", state: "loading" });
    expect(t.children![0].disabled).toBe(true);
  });

  it("throws on unknown scene", () => {
    expect(() => querySpec(spec, { scene: "missing" })).toThrow();
  });
});

describe("diffSpecs", () => {
  const a: DesignSpec = {
    mode: "design",
    version: "0.1.0",
    scenes: [{ id: "s", name: "S", layout: { id: "root", role: "dialog" } }],
  };
  const b: DesignSpec = {
    mode: "design",
    version: "0.1.0",
    scenes: [
      {
        id: "s",
        name: "S2",
        layout: { id: "root", role: "dialog", children: [{ id: "n", role: "button" }] },
      },
    ],
  };

  it("reports renamed scene name", () => {
    const d = diffSpecs(a, b);
    expect(d.scenes.modified.find((m) => m.id === "s")).toBeTruthy();
  });
});
