import { describe, expect, it } from "vitest";
import {
  DOWNGRADE_CHAIN,
  type DowngradeEvent,
  downgradeChain,
  emitDowngrade,
  subscribeDowngrade,
} from "./downgrade.js";

describe("DOWNGRADE_CHAIN", () => {
  it("is exactly Opus -> Sonnet -> Haiku -> HALT", () => {
    expect(DOWNGRADE_CHAIN).toEqual([
      "claude-3-opus-latest",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
      "HALT",
    ]);
  });
});

describe("downgradeChain()", () => {
  it("from Opus yields Sonnet with transition label", () => {
    const step = downgradeChain("claude-3-opus-latest", 80);
    expect(step.next).toBe("claude-3-5-sonnet-latest");
    expect(step.isHalt).toBe(false);
    expect(step.eventLabel).toContain("switching");
    expect(step.eventLabel).toContain("Opus");
    expect(step.eventLabel).toContain("Sonnet");
    expect(step.eventLabel).toContain("80%");
  });

  it("from Sonnet yields Haiku with transition label", () => {
    const step = downgradeChain("claude-3-5-sonnet-latest", 95);
    expect(step.next).toBe("claude-3-5-haiku-latest");
    expect(step.isHalt).toBe(false);
    expect(step.eventLabel).toContain("Sonnet");
    expect(step.eventLabel).toContain("Haiku");
  });

  it("from Haiku yields HALT with isHalt=true", () => {
    const step = downgradeChain("claude-3-5-haiku-latest", 100);
    expect(step.next).toBe("HALT");
    expect(step.isHalt).toBe(true);
    expect(step.eventLabel).toContain("halting");
  });

  it("unknown model treated as top of chain (Opus position)", () => {
    const step = downgradeChain("some-unknown-model", 90);
    expect(step.next).toBe("claude-3-5-sonnet-latest");
    expect(step.isHalt).toBe(false);
  });
});

describe("subscribeDowngrade()", () => {
  it("fires listener with fromModel, toModel, pct on emitDowngrade", () => {
    const events: DowngradeEvent[] = [];
    const unsub = subscribeDowngrade((e) => events.push(e));

    emitDowngrade({
      fromModel: "claude-3-opus-latest",
      toModel: "claude-3-5-sonnet-latest",
      pct: 82,
      atMs: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0].fromModel).toBe("claude-3-opus-latest");
    expect(events[0].toModel).toBe("claude-3-5-sonnet-latest");
    expect(events[0].pct).toBe(82);

    unsub();

    // After unsub, no more events
    emitDowngrade({
      fromModel: "claude-3-5-sonnet-latest",
      toModel: "claude-3-5-haiku-latest",
      pct: 95,
      atMs: Date.now(),
    });
    expect(events).toHaveLength(1);
  });
});
