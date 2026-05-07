import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reserveForProduct } from "../cost-scoper.js";
import * as ledger from "../../usage/ledger.js";
import * as productLedger from "../../usage/product-ledger.js";
import { CapBreachError } from "../../usage/types.js";

const TEST_HOME = path.join(os.tmpdir(), `muonroi-test-${Math.random().toString(36).slice(2)}`);

describe("cost-scoper", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_HOME, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it("issues reservation when both caps are fine", async () => {
    vi.spyOn(productLedger, "getProductSpentUsd").mockResolvedValue(0.1);
    const reserveSpy = vi.spyOn(ledger, "reserve").mockResolvedValue({
      id: "r1",
      model: "claude-3-5-sonnet-latest",
      provider: "anthropic",
      projected_usd: 0.05,
      est_input_tokens: 100,
      est_output_tokens: 100,
      createdAtMs: Date.now()
    });

    const result = await reserveForProduct(
      { provider: "anthropic", model: "claude-3-5-sonnet-latest", estInputTokens: 100, estOutputTokens: 100 },
      "run-1",
      1.0,
      TEST_HOME
    );

    expect(result).not.toBeInstanceOf(CapBreachError);
    if (!(result instanceof CapBreachError)) {
      expect(result.productRunId).toBe("run-1");
    }
    expect(reserveSpy).toHaveBeenCalled();
  });

  it("blocks when per-product cap is hit", async () => {
    vi.spyOn(productLedger, "getProductSpentUsd").mockResolvedValue(0.95);
    const reserveSpy = vi.spyOn(ledger, "reserve");

    const result = await reserveForProduct(
      { provider: "anthropic", model: "claude-3-5-sonnet-latest", estInputTokens: 10000, estOutputTokens: 10000 },
      "run-1",
      1.0,
      TEST_HOME
    );

    expect(result instanceof CapBreachError || (result as any).name === "CapBreachError").toBe(true);
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it("blocks when monthly cap is hit", async () => {
    vi.spyOn(productLedger, "getProductSpentUsd").mockResolvedValue(0.1);
    vi.spyOn(ledger, "reserve").mockResolvedValue(new CapBreachError(14, 0, 2, 15));

    const result = await reserveForProduct(
      { provider: "anthropic", model: "claude-3-5-sonnet-latest", estInputTokens: 100, estOutputTokens: 100 },
      "run-1",
      1.0,
      TEST_HOME
    );

    expect(result instanceof CapBreachError || (result as any).name === "CapBreachError").toBe(true);
  });
});
