import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ledger from "../../usage/ledger.js";
import * as productLedger from "../../usage/product-ledger.js";
import { recordProductSpend } from "../cost-scoper.js";

// cost-scoper used to RESERVE projected spend against the per-run `--max-cost`
// and the monthly cap, and refuse the call on either breach. `/ideal` has no
// spend cap (user decision), so it only METERS now. These tests pin both halves:
// spend is still recorded on both ledgers, and nothing ever consults a cap.

const TEST_HOME = path.join(os.tmpdir(), `muonroi-test-${Math.random().toString(36).slice(2)}`);
const CALL = {
  provider: "anthropic",
  model: "claude-3-5-sonnet-latest",
  actualInputTokens: 100,
  actualOutputTokens: 50,
};

describe("cost-scoper — metering only", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_HOME, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(TEST_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("records the call on the monthly ledger and on the per-run ledger", async () => {
    const commit = vi.spyOn(ledger, "commitUnreserved").mockResolvedValue(0.05);
    const append = vi.spyOn(productLedger, "appendProductLedger").mockResolvedValue(undefined);

    await recordProductSpend(CALL, "run-1", { callsite: "sprint.generate" }, TEST_HOME);

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        actualInputTokens: 100,
        actualOutputTokens: 50,
        homeOverride: TEST_HOME,
      }),
    );
    expect(append).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ productRunId: "run-1", callsite: "sprint.generate", reservationId: "unreserved" }),
      TEST_HOME,
    );
  });

  it("never consults a cap: no reservation and no spent-so-far lookup, however much the run has spent", async () => {
    const reserve = vi.spyOn(ledger, "reserve");
    const spentSoFar = vi.spyOn(productLedger, "getProductSpentUsd").mockResolvedValue(1_000_000);
    vi.spyOn(ledger, "commitUnreserved").mockResolvedValue(1);
    vi.spyOn(productLedger, "appendProductLedger").mockResolvedValue(undefined);

    await expect(recordProductSpend(CALL, "run-1", undefined, TEST_HOME)).resolves.toBeUndefined();
    expect(reserve).not.toHaveBeenCalled();
    expect(spentSoFar).not.toHaveBeenCalled();
  });

  it("a ledger failure is logged, never thrown — metering must not break the call it measures", async () => {
    vi.spyOn(ledger, "commitUnreserved").mockRejectedValue(new Error("disk full"));
    vi.spyOn(productLedger, "appendProductLedger").mockRejectedValue(new Error("lock timeout"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordProductSpend(CALL, "run-1", undefined, TEST_HOME)).resolves.toBeUndefined();
    const text = logged.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("disk full");
    expect(text).toContain("lock timeout");
  });

  it("commitUnreserved records real spend on the monthly ledger even far above the configured cap", async () => {
    await fs.writeFile(path.join(TEST_HOME, "config.json"), JSON.stringify({ cap: { monthly_usd: 0.000001 } }));
    const usd = await ledger.commitUnreserved({
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      actualInputTokens: 1_000_000,
      actualOutputTokens: 1_000_000,
      homeOverride: TEST_HOME,
    });
    const state = JSON.parse(await fs.readFile(path.join(TEST_HOME, "usage.json"), "utf8")) as { current_usd: number };
    expect(state.current_usd).toBeCloseTo(usd, 9);
  });
});
