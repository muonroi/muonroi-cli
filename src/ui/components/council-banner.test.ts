import { describe, expect, it } from "vitest";
import { deriveBannerPhase } from "./council-banner.js";

describe("deriveBannerPhase", () => {
  it("is 'early' before any round starts and no decision", () => {
    expect(deriveBannerPhase(null, null)).toBe("early");
  });

  it("is 'debate' once a round has started", () => {
    expect(deriveBannerPhase(1, null)).toBe("debate");
    expect(deriveBannerPhase(3, null)).toBe("debate");
  });

  it("is 'synthesis' when a decision exists (decision wins over round)", () => {
    expect(deriveBannerPhase(2, "converged")).toBe("synthesis");
    expect(deriveBannerPhase(null, "ended early")).toBe("synthesis");
  });
});
