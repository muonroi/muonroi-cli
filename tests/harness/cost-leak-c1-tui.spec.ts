/**
 * tests/harness/cost-leak-c1-tui.spec.ts
 *
 * Phase F C1 — TUI E2E: DeepSeek-shaped usage with
 * `promptCacheHitTokens` should be read into `cacheReadTokens` in the
 * orchestrator's usage_events table.
 *
 * Reading the orchestrator's usage_events sqlite table from a child
 * process is invasive (requires either a snapshot tool or direct DB
 * access). The unit-level spec
 * src/orchestrator/__tests__/usage-normalizer-c1.test.ts already covers
 * the provider-layer split — keeping this TUI spec as a `.skip` stub so
 * the cost-leak matrix in the suite output stays complete.
 */

import { describe, it } from "vitest";

describe("C1 TUI: DeepSeek cache field split (promptCacheHitTokens -> cacheReadTokens)", () => {
  // Skipped: provider-layer behaviour is already verified by the unit test
  // src/orchestrator/__tests__/usage-normalizer-c1.test.ts. Driving the
  // assertion through the TUI requires peeking at orchestrator.usage_events
  // from the parent process, which our spawn helper does not currently
  // expose. Adding a `tui.usage` snapshot tool to the MCP driver would
  // unblock a real E2E here.
  it.skip("orchestrator's usage_events reads cacheReadTokens from promptCacheHitTokens (TODO: snapshot tool)", async () => {
    // Intentionally empty — see file header.
  }, 30_000);
});
