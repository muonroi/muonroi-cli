import { describe, expect, it } from "vitest";
import { normalizePeakHourPolicy } from "../settings.js";

describe("normalizePeakHourPolicy", () => {
  it("defaults to enabled switch mode (window from catalog provider_policies)", () => {
    expect(normalizePeakHourPolicy(undefined)).toEqual({
      enabled: true,
      mode: "switch",
    });
  });

  it("honours downgrade mode", () => {
    expect(normalizePeakHourPolicy({ mode: "downgrade", enabled: true })).toMatchObject({
      mode: "downgrade",
      enabled: true,
    });
  });

  it("allows disabling peak-hour routing", () => {
    expect(normalizePeakHourPolicy({ enabled: false }).enabled).toBe(false);
  });
});
