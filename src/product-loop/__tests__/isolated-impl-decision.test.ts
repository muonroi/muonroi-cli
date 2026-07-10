import { afterEach, describe, expect, it } from "vitest";
import { getSprintIsolatedImplEnabled, shouldUseIsolatedImpl } from "../sprint-runner.js";

// The implement stage runs in an isolated bounded sub-agent context
// (ctx.runIsolatedTask) instead of the shared top-level turn — the fix for the
// live ctx-overflow wedge (the flat turn inherited ~5.9M debate tokens and
// wedged after a mid-turn compaction). These guard the enable/gate logic.
describe("getSprintIsolatedImplEnabled", () => {
  const prev = process.env.MUONROI_SPRINT_ISOLATED_IMPL;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_SPRINT_ISOLATED_IMPL;
    else process.env.MUONROI_SPRINT_ISOLATED_IMPL = prev;
  });

  it("defaults ON when the env var is unset", () => {
    delete process.env.MUONROI_SPRINT_ISOLATED_IMPL;
    expect(getSprintIsolatedImplEnabled()).toBe(true);
  });

  it("is disabled ONLY by the exact string '0'", () => {
    process.env.MUONROI_SPRINT_ISOLATED_IMPL = "0";
    expect(getSprintIsolatedImplEnabled()).toBe(false);
    for (const v of ["1", "", "false", "off"]) {
      process.env.MUONROI_SPRINT_ISOLATED_IMPL = v;
      expect(getSprintIsolatedImplEnabled()).toBe(true); // only "0" opts out
    }
  });
});

describe("shouldUseIsolatedImpl", () => {
  it("uses isolated ONLY when enabled AND the driver provides the bridge", () => {
    expect(shouldUseIsolatedImpl(true, true)).toBe(true);
  });

  it("falls back to processMessageFn when the bridge is absent (legacy/test drivers)", () => {
    expect(shouldUseIsolatedImpl(false, true)).toBe(false);
  });

  it("falls back when the flag is off even if the bridge exists", () => {
    expect(shouldUseIsolatedImpl(true, false)).toBe(false);
  });

  it("is false when both are false", () => {
    expect(shouldUseIsolatedImpl(false, false)).toBe(false);
  });
});
