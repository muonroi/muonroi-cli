import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../models/registry.js";
import {
  type DowngradeEvent,
  downgradeChain,
  emitDowngrade,
  getDowngradeChain,
  subscribeDowngrade,
} from "./downgrade.js";

beforeAll(async () => {
  await loadCatalog();
});

describe("getDowngradeChain()", () => {
  it("ends with HALT", () => {
    const chain = getDowngradeChain();
    expect(chain[chain.length - 1]).toBe("HALT");
  });

  it("has at least one model before HALT", () => {
    const chain = getDowngradeChain();
    expect(chain.length).toBeGreaterThanOrEqual(2);
  });

  it("contains no duplicates (except HALT)", () => {
    const chain = getDowngradeChain();
    const models = chain.filter((m) => m !== "HALT");
    expect(new Set(models).size).toBe(models.length);
  });
});

describe("downgradeChain()", () => {
  it("from first model yields second model", () => {
    const chain = getDowngradeChain();
    if (chain.length < 3) return; // need at least 2 models + HALT
    const step = downgradeChain(chain[0], 80);
    expect(step.next).toBe(chain[1]);
    expect(step.isHalt).toBe(false);
    expect(step.eventLabel).toContain("switching");
  });

  it("from last model before HALT yields HALT", () => {
    const chain = getDowngradeChain();
    const lastModel = chain[chain.length - 2];
    const step = downgradeChain(lastModel, 100);
    expect(step.next).toBe("HALT");
    expect(step.isHalt).toBe(true);
    expect(step.eventLabel).toContain("halting");
  });

  it("unknown model treated as top of chain", () => {
    const chain = getDowngradeChain();
    const step = downgradeChain("some-unknown-model", 90);
    expect(step.next).toBe(chain[1] ?? "HALT");
    expect(step.isHalt).toBe(step.next === "HALT");
  });
});

describe("subscribeDowngrade()", () => {
  it("fires listener on emitDowngrade and stops after unsub", () => {
    const chain = getDowngradeChain();
    const events: DowngradeEvent[] = [];
    const unsub = subscribeDowngrade((e) => events.push(e));

    emitDowngrade({
      fromModel: chain[0],
      toModel: chain[1] ?? "HALT",
      pct: 82,
      atMs: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0].fromModel).toBe(chain[0]);

    unsub();

    emitDowngrade({
      fromModel: chain[0],
      toModel: chain[1] ?? "HALT",
      pct: 95,
      atMs: Date.now(),
    });
    expect(events).toHaveLength(1);
  });
});
