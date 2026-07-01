import { describe, expect, it } from "vitest";
import { normalizePeakHourPolicy } from "../settings.js";

describe("normalizePeakHourPolicy", () => {
  it("defaults to enabled switch mode 14–18 UTC+8", () => {
    expect(normalizePeakHourPolicy(undefined)).toEqual({
      enabled: true,
      mode: "switch",
      startHourUtc8: 14,
      endHourUtc8: 18,
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
