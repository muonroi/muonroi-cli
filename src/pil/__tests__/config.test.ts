import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUnifiedPilEnabled } from "../config.js";

describe("isUnifiedPilEnabled", () => {
  const orig = process.env.MUONROI_PIL_UNIFIED;
  beforeEach(() => {
    delete process.env.MUONROI_PIL_UNIFIED;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.MUONROI_PIL_UNIFIED;
    else process.env.MUONROI_PIL_UNIFIED = orig;
  });

  it("returns false by default (rollout phase)", () => {
    expect(isUnifiedPilEnabled()).toBe(false);
  });

  it("returns true when MUONROI_PIL_UNIFIED=1", () => {
    process.env.MUONROI_PIL_UNIFIED = "1";
    expect(isUnifiedPilEnabled()).toBe(true);
  });

  it("returns false when MUONROI_PIL_UNIFIED=0", () => {
    process.env.MUONROI_PIL_UNIFIED = "0";
    expect(isUnifiedPilEnabled()).toBe(false);
  });

  it("returns false for any other value", () => {
    process.env.MUONROI_PIL_UNIFIED = "yes";
    expect(isUnifiedPilEnabled()).toBe(false);
  });
});
