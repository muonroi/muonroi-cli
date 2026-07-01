import { afterEach, describe, expect, it } from "vitest";
import { isGsdNativeEnabled } from "../flags.js";

describe("isGsdNativeEnabled", () => {
  const prev = process.env.MUONROI_GSD_NATIVE;

  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_GSD_NATIVE;
    else process.env.MUONROI_GSD_NATIVE = prev;
  });

  it("defaults to enabled when env unset", () => {
    delete process.env.MUONROI_GSD_NATIVE;
    expect(isGsdNativeEnabled()).toBe(true);
  });

  it("stays enabled when MUONROI_GSD_NATIVE=1", () => {
    process.env.MUONROI_GSD_NATIVE = "1";
    expect(isGsdNativeEnabled()).toBe(true);
  });

  it("opts out when MUONROI_GSD_NATIVE=0", () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    expect(isGsdNativeEnabled()).toBe(false);
  });
});
