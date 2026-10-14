import { describe, expect, it } from "vitest";
import { isBackgroundWakeEnabled } from "../background-wake.js";

describe("isBackgroundWakeEnabled", () => {
  it("is on unless explicitly turned off", () => {
    expect(isBackgroundWakeEnabled({})).toBe(true);
    expect(isBackgroundWakeEnabled({ MUONROI_BACKGROUND_WAKE: "1" })).toBe(true);
    for (const off of ["0", "false", "OFF", " no "]) {
      expect(isBackgroundWakeEnabled({ MUONROI_BACKGROUND_WAKE: off })).toBe(false);
    }
  });
});
