import { describe, expect, it } from "vitest";
import { fallbackTitle } from "../orchestrator.js";

describe("fallbackTitle hygiene", () => {
  it("returns '' for a JSON-object first message so no {} title is persisted", () => {
    expect(fallbackTitle("{}")).toBe("");
    expect(fallbackTitle('  { "op": "resume" } ')).toBe("");
  });

  it("returns '' for a JSON-array or empty message", () => {
    expect(fallbackTitle("[1,2,3]")).toBe("");
    expect(fallbackTitle("   ")).toBe("");
  });

  it("keeps a normal prose message (truncated)", () => {
    expect(fallbackTitle("build a counter component")).toBe("build a counter component");
  });
});
