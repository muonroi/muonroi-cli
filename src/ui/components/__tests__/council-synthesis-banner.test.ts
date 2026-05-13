import { describe, expect, it } from "vitest";
import { buildSynthesisTitle } from "../council-synthesis-banner.js";

describe("buildSynthesisTitle", () => {
  it("returns 'Final Synthesis' when round is undefined", () => {
    expect(buildSynthesisTitle(undefined)).toBe("Final Synthesis");
  });

  it("returns 'Round N Synthesis' when round is provided", () => {
    expect(buildSynthesisTitle(3)).toBe("Round 3 Synthesis");
  });
});
