import { describe, expect, it } from "vitest";
import { slugify } from "../slugify.js";

describe("slugify", () => {
  it("lowercases all alphabetic chars", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("replaces non-alphanumeric with single dash", () => {
    expect(slugify("foo!@#$bar")).toBe("foo-bar");
  });

  it("collapses consecutive dashes", () => {
    expect(slugify("a    b    c")).toBe("a-b-c");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("strips Unicode combining marks (NFKD)", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  it("handles empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("Discord-name round-trip: lowercase + only [a-z0-9-]", () => {
    const out = slugify("Hello, World! 2026");
    expect(out).toBe("hello-world-2026");
    expect(/^[a-z0-9-]*$/.test(out)).toBe(true);
  });

  it("does not slice — caller decides length", () => {
    const out = slugify("a".repeat(200));
    expect(out.length).toBe(200);
  });

  it("Vietnamese with diacritics produces alphanumeric only", () => {
    const out = slugify("Sản phẩm mới");
    expect(/^[a-z0-9-]*$/.test(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});
