import { describe, expect, it } from "vitest";
import type { DesignSpec } from "../protocol.js";
import { validateSpec } from "../spec-helpers.js";

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
