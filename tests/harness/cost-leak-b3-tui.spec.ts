/**
 * tests/harness/cost-leak-b3-tui.spec.ts
 *
 * Phase F B3 — TUI E2E: sub-agent `prepareStep` compactor rewrites older
 * tool_result parts into short summary stubs once cumulative message-chars
 * exceed MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS.
 *
 * Driving compaction reliably through the composer (without a real tool
 * loop) is hard — the sub-agent path is only entered when the
 * orchestrator dispatches a `task` tool call, which our text-only mock
 * does not produce. Skipped with a TODO. The unit-level spec
 * tests/harness/cost-leak-b3.spec.ts exercises the same invariant by
 * calling streamText directly with a multi-round fixture.
 */

import { describe, it } from "vitest";

describe("B3 TUI: sub-agent compactor reduces cumulative prompt size", () => {
  // Skipped: requires the orchestrator to actually dispatch a sub-agent
  // (task tool call) which our text-only mock fixture does not trigger.
  // Multi-round tool-call fixtures need the AI SDK tool definitions to
  // round-trip through the orchestrator, and the matcher currently does
  // not align fixture tool ids with the production tool registry.
  // Unit-level coverage exists in tests/harness/cost-leak-b3.spec.ts.
  it.skip("cumulativePromptChars stays below uncompacted baseline (TODO: real sub-agent path)", async () => {
    // Intentionally empty — kept as a marker so cost-leak coverage matrix
    // stays visible in the suite output.
  }, 60_000);
});
