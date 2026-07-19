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

// F1 routes through `gpt-5.4-mini`, which is not in the catalog (catalog.json
// ships only deepseek/qwen/glm ids today). The CLI rejects the unknown model
// id at startup and never reaches the agent-mode handshake, so `beforeAll`'s
// `wait_for({selector: "role=textbox"})` times out and fails the suite —
// even though the only `it()` is marked `.skip`. `.skip` on the describe
// suppresses the beforeAll spawn entirely, which is what CLAUDE.md's
// known-caveat #4 already documents as the desired state until an openai
// model lands in catalog.json. (Evidence: CI runs 26431673369 / 26431994835
// — the F1 failure was always the spawn timeout, never an assertion.)
//
// NOT a measurement gap: the invariant this suite would assert (every round
// carries the SAME openai.promptCacheKey, session-scoped, order-independent)
// is ALREADY covered and passing at the provider-recording layer by
// `tests/harness/cost-leak-f1.spec.ts` (3 tests) + `computePromptCacheKey`
// stability in `src/providers/prompt-cache-key.spec.ts`. This TUI variant is
// redundant end-to-end coverage; un-skipping it needs an openai model in the
// catalog OR a provider-id override threaded through `--mock-llm` (deep harness
// plumbing) for marginal gain over the already-falsifiable provider-layer test.
describe.skip("F1 TUI: providerOptions.openai.promptCacheKey is present and stable", () => {
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
