import { describe, expect, it } from "vitest";
import { detectBlock, getLoopBreadcrumb, setLoopBreadcrumb } from "../event-loop-monitor.js";
import { summarizeHotStack } from "../loop-profiler.js";

describe("detectBlock", () => {
  it("reports nothing when the tick is on time", () => {
    expect(detectBlock(1000, 1005, 2000)).toBeNull();
  });

  it("reports nothing when lateness is under the threshold", () => {
    expect(detectBlock(1000, 2999, 2000)).toBeNull();
  });

  it("reports the block duration once lateness reaches the threshold", () => {
    expect(detectBlock(1000, 3000, 2000)).toBe(2000);
    expect(detectBlock(1000, 3600, 2000)).toBe(2600);
  });

  it("measures the real freeze: a 304.5s block like session 90c3ff533826", () => {
    expect(detectBlock(1000, 305_500, 2000)).toBe(304_500);
  });

  it("is disabled by a non-positive threshold", () => {
    expect(detectBlock(1000, 999_999, 0)).toBeNull();
    expect(detectBlock(1000, 999_999, -1)).toBeNull();
  });

  it("never reports a negative block when a tick runs early", () => {
    expect(detectBlock(2000, 1000, 500)).toBeNull();
  });
});

describe("loop breadcrumb", () => {
  it("round-trips, and last writer wins", () => {
    setLoopBreadcrumb("tool:bash");
    expect(getLoopBreadcrumb()).toBe("tool:bash");
    setLoopBreadcrumb("after-tool:bash");
    expect(getLoopBreadcrumb()).toBe("after-tool:bash");
    setLoopBreadcrumb(null);
    expect(getLoopBreadcrumb()).toBeNull();
  });
});

describe("summarizeHotStack", () => {
  /**
   * Mirrors the real shape measured on a synthetic 3s block: samples land on a
   * native leaf (`now`) while the actual culprit is its CALLER. A summary that
   * only reported the leaf would name `now` and tell nobody anything.
   */
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
      { id: 2, callFrame: { functionName: "outerCaller", url: "file:///a/probe.ts", lineNumber: 4 }, children: [3] },
      {
        id: 3,
        callFrame: { functionName: "theGuiltyFunction", url: "file:///a/probe.ts", lineNumber: 11 },
        children: [4],
      },
      { id: 4, callFrame: { functionName: "now", url: "" } },
    ],
    samples: [4, 4, 4, 4, 3, 2],
  };

  it("walks up from the hottest leaf so callers are named, not just the leaf", () => {
    expect(summarizeHotStack(profile)).toEqual([
      "now (native)",
      "theGuiltyFunction (probe.ts:12)",
      "outerCaller (probe.ts:5)",
    ]);
  });

  it("drops V8's synthetic frames — naming (root) helps nobody", () => {
    expect(summarizeHotStack(profile).some((f) => f.includes("(root)"))).toBe(false);
  });

  it("honours maxFrames", () => {
    expect(summarizeHotStack(profile, 1)).toEqual(["now (native)"]);
  });

  it("returns empty for an unusable profile rather than throwing", () => {
    expect(summarizeHotStack({ nodes: [], samples: [] })).toEqual([]);
    expect(summarizeHotStack({ nodes: profile.nodes, samples: [] })).toEqual([]);
    expect(summarizeHotStack({} as never)).toEqual([]);
  });

  it("does not loop forever on a cyclic parent chain", () => {
    const cyclic = {
      nodes: [
        { id: 1, callFrame: { functionName: "a", url: "file:///x.ts", lineNumber: 0 }, children: [2] },
        { id: 2, callFrame: { functionName: "b", url: "file:///x.ts", lineNumber: 1 }, children: [1] },
      ],
      samples: [2],
    };
    expect(summarizeHotStack(cyclic).length).toBeLessThanOrEqual(2);
  });
});
