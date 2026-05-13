import { describe, it, expect } from "vitest";
import { buildPlaceholderLabel } from "../council-placeholder-bubble.js";

describe("buildPlaceholderLabel", () => {
  it("formats role with composing indicator", () => {
    expect(buildPlaceholderLabel("Frontend Engineer")).toBe(
      "Frontend Engineer · composing…"
    );
  });

  it("trims whitespace from role", () => {
    expect(buildPlaceholderLabel("  Backend Engineer  ")).toBe(
      "Backend Engineer · composing…"
    );
  });

  it("handles empty role with fallback", () => {
    expect(buildPlaceholderLabel("")).toBe("Speaker · composing…");
  });
});
