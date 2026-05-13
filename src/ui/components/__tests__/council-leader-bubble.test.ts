import { describe, it, expect } from "vitest";
import { buildLeaderHeader } from "../council-leader-bubble.js";

describe("buildLeaderHeader", () => {
  it("includes round number when present", () => {
    expect(buildLeaderHeader(2)).toBe("Leader · round 2 eval");
  });

  it("omits round suffix when round is undefined", () => {
    expect(buildLeaderHeader(undefined)).toBe("Leader");
  });

  it("handles round 0", () => {
    expect(buildLeaderHeader(0)).toBe("Leader · round 0 eval");
  });
});
