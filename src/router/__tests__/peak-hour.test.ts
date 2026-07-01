import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import type { PeakHourPolicy } from "../../utils/settings.js";
import { adjustPeakHourModel, getRoutedModelByTier, hourUtc8, isPeakHourUtc8 } from "../peak-hour.js";

const PEAK_POLICY: PeakHourPolicy = { enabled: true, mode: "downgrade", startHourUtc8: 14, endHourUtc8: 18 };
const OFF_PEAK_NOON_UTC8 = new Date("2026-07-01T04:00:00.000Z"); // 12:00 UTC+8
const PEAK_1500_UTC8 = new Date("2026-07-01T07:00:00.000Z"); // 15:00 UTC+8

beforeAll(async () => {
  await loadCatalog();
});

describe("isPeakHourUtc8", () => {
  it("returns true inside 14:00–18:00 UTC+8 window", () => {
    expect(isPeakHourUtc8(PEAK_1500_UTC8, PEAK_POLICY)).toBe(true);
    expect(hourUtc8(PEAK_1500_UTC8)).toBe(15);
  });

  it("returns false outside the window", () => {
    expect(isPeakHourUtc8(OFF_PEAK_NOON_UTC8, PEAK_POLICY)).toBe(false);
  });

  it("returns false when policy disabled", () => {
    expect(isPeakHourUtc8(PEAK_1500_UTC8, { ...PEAK_POLICY, enabled: false })).toBe(false);
  });
});

describe("adjustPeakHourModel", () => {
  it("downgrades zai glm-5.2 to glm-4.7 during peak (downgrade mode)", () => {
    const adj = adjustPeakHourModel("glm-5.2", { now: PEAK_1500_UTC8, policy: PEAK_POLICY });
    expect(adj.adjusted).toBe(true);
    expect(adj.modelId).toBe("glm-4.7");
    expect(adj.provider).toBe("zai");
  });

  it("downgrades zai glm-5-turbo to glm-4.7 during peak", () => {
    const adj = adjustPeakHourModel("glm-5-turbo", { now: PEAK_1500_UTC8, policy: PEAK_POLICY });
    expect(adj.modelId).toBe("glm-4.7");
  });

  it("downgrades deepseek-v4-pro to deepseek-v4-flash during peak", () => {
    const adj = adjustPeakHourModel("deepseek-v4-pro", { now: PEAK_1500_UTC8, policy: PEAK_POLICY });
    expect(adj.adjusted).toBe(true);
    expect(adj.modelId).toBe("deepseek-v4-flash");
    expect(adj.provider).toBe("deepseek");
  });

  it("leaves glm-4.7 unchanged during peak", () => {
    const adj = adjustPeakHourModel("glm-4.7", { now: PEAK_1500_UTC8, policy: PEAK_POLICY });
    expect(adj.adjusted).toBe(false);
    expect(adj.modelId).toBe("glm-4.7");
  });

  it("no-op outside peak window", () => {
    const adj = adjustPeakHourModel("glm-5.2", { now: OFF_PEAK_NOON_UTC8, policy: PEAK_POLICY });
    expect(adj.adjusted).toBe(false);
    expect(adj.modelId).toBe("glm-5.2");
  });
});

describe("getRoutedModelByTier", () => {
  it("returns glm-4.7 for zai premium tier during peak", () => {
    const m = getRoutedModelByTier("premium", "zai", { now: PEAK_1500_UTC8, policy: PEAK_POLICY });
    expect(m?.id).toBe("glm-4.7");
  });

  it("returns glm-5.2 for zai premium tier off-peak", () => {
    const m = getRoutedModelByTier("premium", "zai", { now: OFF_PEAK_NOON_UTC8, policy: PEAK_POLICY });
    expect(m?.id).toBe("glm-5.2");
  });

  it("returns deepseek-v4-flash for deepseek premium tier during peak", () => {
    const m = getRoutedModelByTier("premium", "deepseek", { now: PEAK_1500_UTC8, policy: PEAK_POLICY });
    expect(m?.id).toBe("deepseek-v4-flash");
  });
});
