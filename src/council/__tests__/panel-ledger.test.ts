import { beforeEach, describe, expect, it, vi } from "vitest";

// Priced through the catalog — stub the registry so the arithmetic is asserted
// against known rates instead of whatever catalog.json currently ships.
vi.mock("../../models/registry.js", () => ({
  getModelInfo: (id: string) =>
    id === "priced-model"
      ? { inputPrice: 1_000, cachedInputPrice: 100, outputPrice: 2_000 }
      : id === "no-cached-price"
        ? { inputPrice: 1_000, outputPrice: 2_000 }
        : undefined,
}));

const { createPanelLedger, priceCouncilCallUsd } = await import("../panel-ledger.js");

const usage = (input: number, output: number, cached = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cachedInputTokens: cached,
});

describe("priceCouncilCallUsd", () => {
  it("prices non-cached input, cached input and output separately", () => {
    // (1000-200)*1000 + 200*100 + 500*2000 = 800_000 + 20_000 + 1_000_000 micros
    expect(priceCouncilCallUsd("priced-model", usage(1000, 500, 200))).toBeCloseTo(1.82, 6);
  });

  it("falls back to 10% of input price for cached tokens when the catalog omits it", () => {
    // (1000-200)*1000 + 200*100 + 0 = 820_000 micros
    expect(priceCouncilCallUsd("no-cached-price", usage(1000, 0, 200))).toBeCloseTo(0.82, 6);
  });

  // A missing price must not make the whole ledger vanish or invent a rate.
  it("returns 0 for a model with no catalog entry", () => {
    expect(priceCouncilCallUsd("unknown-model", usage(1000, 500))).toBe(0);
  });

  it("never charges for more cached tokens than were input", () => {
    expect(priceCouncilCallUsd("priced-model", usage(100, 0, 500))).toBeGreaterThanOrEqual(0);
  });
});

describe("createPanelLedger", () => {
  let ledger: ReturnType<typeof createPanelLedger>;
  beforeEach(() => {
    ledger = createPanelLedger();
  });

  it("starts empty", () => {
    expect(ledger.hasEntries()).toBe(false);
    expect(ledger.snapshot()).toEqual([]);
  });

  it("counts one turn per speak, not per provider call", () => {
    // A turn that retried and then fell back = 3 billed calls, 1 turn.
    ledger.recordUsage("architect", "priced-model", usage(100, 0));
    ledger.recordUsage("architect", "priced-model", usage(100, 0));
    ledger.recordUsage("architect", "priced-model", usage(100, 0));
    ledger.recordTurn("architect", "priced-model");
    const [row] = ledger.snapshot();
    expect(row!.turns).toBe(1);
    expect(row!.usd).toBeCloseTo(0.3, 6);
  });

  it("accumulates across rounds per role", () => {
    ledger.recordTurn("architect", "priced-model");
    ledger.recordTurn("skeptic", "priced-model");
    ledger.recordTurn("architect", "priced-model");
    const rows = ledger.snapshot();
    expect(rows.map((r) => [r.role, r.turns])).toEqual([
      ["architect", 2],
      ["skeptic", 1],
    ]);
  });

  // First-seen order is what the role palette assigns slots by; a reordered
  // snapshot would paint ledger rows in different colors from the transcript.
  it("preserves first-seen role order", () => {
    ledger.recordTurn("research", "priced-model");
    ledger.recordTurn("architect", "priced-model");
    ledger.recordTurn("research", "priced-model");
    expect(ledger.snapshot().map((r) => r.role)).toEqual(["research", "architect"]);
  });

  it("reports the model that actually ran after a fallback swap", () => {
    ledger.recordTurn("architect", "priced-model");
    ledger.recordUsage("architect", "no-cached-price", usage(100, 0));
    expect(ledger.snapshot()[0]!.model).toBe("no-cached-price");
  });

  it("keeps an unpriced model in the roster at $0 rather than dropping it", () => {
    ledger.recordUsage("research", "unknown-model", usage(5000, 5000));
    ledger.recordTurn("research", "unknown-model");
    expect(ledger.snapshot()).toEqual([{ role: "research", model: "unknown-model", turns: 1, usd: 0 }]);
  });

  it("ignores a blank role instead of creating an unnamed row", () => {
    ledger.recordTurn("   ", "priced-model");
    expect(ledger.hasEntries()).toBe(false);
  });
});
