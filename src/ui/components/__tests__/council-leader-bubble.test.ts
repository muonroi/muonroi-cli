import { describe, expect, it } from "vitest";
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

  it("labels a pre-round directive with an arrow marker", () => {
    expect(buildLeaderHeader(2, "directive")).toBe("▶ Leader · round 2 directive");
  });

  it("labels a post-round verdict", () => {
    expect(buildLeaderHeader(2, "verdict")).toBe("Leader · round 2 verdict");
  });

  it("keeps the arrow marker even without a round for a directive", () => {
    expect(buildLeaderHeader(undefined, "directive")).toBe("▶ Leader");
  });
});
