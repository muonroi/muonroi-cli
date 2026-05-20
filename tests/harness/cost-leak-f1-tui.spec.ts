/**
 * tests/harness/cost-leak-f1-tui.spec.ts
 *
 * Phase F F1 — TUI E2E: every streamText call within one TUI session must
 * carry the same `providerOptions.openai.promptCacheKey` (deterministic
 * sha256 prefix). That key is what OpenAI uses to route cache lookups, so
 * inconsistency across rounds defeats prompt caching entirely.
 *
 * Note: with a single-round text-only fixture this only asserts the key is
 * PRESENT and looks like a sha-prefix. Multi-round verification (same key
 * across N rounds) requires the orchestrator to actually loop — left as a
 * follow-up because driving multi-round through the composer is racy.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type CostLeakHarness,
  exitTuiAndWaitForDump,
  makeTextStream,
  spawnCostLeakHarness,
} from "./cost-leak-tui-helpers.js";
import { getProviderOption, loadDumpedRecordings } from "./recording.js";

describe("F1 TUI: providerOptions.openai.promptCacheKey is present and stable", () => {
  let handle: CostLeakHarness;

  beforeAll(async () => {
    // Route through the openai provider so OpenAIProviderCapabilities.buildProviderOptions
    // is invoked and promptCacheKey is injected. The mock model still intercepts the
    // real network call — `resolveModelRuntime` sees __muonroiMockModel installed and
    // returns it instead of the real OpenAI client.
    handle = await spawnCostLeakHarness({ stream: makeTextStream("ok") }, { modelId: "gpt-5.4-mini" });
  }, 30_000);

  afterAll(() => {
    handle?.cleanup();
  });

  it("every recorded call exposes the same providerOptions.openai.promptCacheKey", async () => {
    handle.driver.type("hello");
    handle.driver.press("Enter");

    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 15_000 });
    await handle.driver.wait_for({ idle: true, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 2000));

    await exitTuiAndWaitForDump(handle);

    const calls = loadDumpedRecordings(handle.dumpPath);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const keys = new Set<string>();
    for (const c of calls) {
      const k = getProviderOption<string>(c, "openai", "promptCacheKey");
      expect(typeof k).toBe("string");
      expect((k ?? "").length).toBeGreaterThan(8);
      keys.add(k ?? "");
    }
    expect(keys.size).toBe(1);
  }, 60_000);
});
