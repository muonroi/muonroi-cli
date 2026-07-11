import { describe, expect, it } from "vitest";
import { openingBriefHeader } from "../council-round-group.js";

describe("openingBriefHeader (F2 — frame the directive as a pre-round brief)", () => {
  it("plain brief header when the round did not meet everything", () => {
    expect(openingBriefHeader(false)).toBe("Opening brief:");
  });

  it("marks the brief as resolved on a converged round so it does not read as still-unmet", () => {
    // The persisted directive body still says "Unmet (n/m)"; this header makes it
    // unambiguous that those were the round's TARGETS, resolved by its outcome.
    expect(openingBriefHeader(true)).toBe("Opening brief — resolved below:");
  });
});
