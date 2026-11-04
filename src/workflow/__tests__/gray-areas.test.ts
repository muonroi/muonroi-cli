import { describe, expect, it } from "vitest";
import { detectGrayAreas } from "../gray-areas";

describe("detectGrayAreas", () => {
  it("returns no questions for empty input", () => {
    expect(detectGrayAreas("").questions).toHaveLength(0);
  });

  it("flags scope when prompt is broad", () => {
    const r = detectGrayAreas("rewrite everything for better performance");
    const dims = r.questions.map((q) => q.dimension);
    expect(dims).toContain("scope");
  });

  it("does not flag scope when prompt names a single file", () => {
    const r = detectGrayAreas("rename foo to bar in src/index.ts");
    const dims = r.questions.map((q) => q.dimension);
    expect(dims).not.toContain("scope");
  });

  it("each question's first option is the recommended default", () => {
    const r = detectGrayAreas("redo the architecture");
    for (const q of r.questions) {
      expect(q.options[0]).toBeTruthy();
      expect(q.options.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("caps the number of questions at 4", () => {
    const r = detectGrayAreas("do everything everywhere all at once");
    expect(r.questions.length).toBeLessThanOrEqual(4);
  });
});
