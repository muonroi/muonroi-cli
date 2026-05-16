/**
 * tests/harness/cost-leak-b4-tui.spec.ts
 *
 * Phase F B4 — TUI E2E: top-level `prepareStep` compactor — same shape as
 * B3 but for the top-level orchestrator loop. Force lower threshold via
 * MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS=10000.
 *
 * Skipped for the same reason as B3: driving multi-round tool-call
 * compaction through the composer requires fixture tool definitions that
 * round-trip through the orchestrator's tool registry. Unit-level coverage
 * exists in tests/harness/cost-leak-b4.spec.ts.
 */

import { describe, it } from "vitest";

describe("B4 TUI: top-level compactor reduces cumulative prompt size", () => {
  // Skipped: same blocker as B3 — top-level compaction only kicks in when
  // the orchestrator emits multiple rounds with large tool outputs, and our
  // mock fixture cannot synthesize tool-call rounds without matching tool
  // definitions in the production registry.
  it.skip("cumulativePromptChars stays below uncompacted baseline (TODO: tool-call fixtures)", async () => {
    // Intentionally empty — kept as a marker so the cost-leak coverage
    // matrix stays visible in the suite output.
  }, 60_000);
});
