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
    handle = await spawnCostLeakHarness({
      stream: makeTextStream("ok"),
    });
  }, 30_000);

  afterAll(() => {
    handle?.cleanup();
  });

  // Skipped: the orchestrator only sets promptCacheKey when running against
  // an OpenAI-family provider. Our mock model is routed via the
  // "deepseek-ai/DeepSeek-V4-Flash" model id (siliconflow provider), so the
  // openai.promptCacheKey branch in src/orchestrator/orchestrator.ts is not
  // exercised. Switching the spawn model to a gpt-* id triggers the
  // provider-resolution / API-key path before the mock can intercept.
  // Follow-up: thread provider-id override through --mock-llm fixture so the
  // mock claims to be the openai provider while still being routed through
  // resolveModelRuntime.
  it.skip("every recorded call exposes the same providerOptions.openai.promptCacheKey", async () => {
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

  it("dump round-trip works (control)", async () => {
    handle.driver.type("hello");
    handle.driver.press("Enter");

    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 15_000 });
    await handle.driver.wait_for({ idle: true, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 2000));

    await exitTuiAndWaitForDump(handle);

    const calls = loadDumpedRecordings(handle.dumpPath);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
