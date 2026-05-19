// Backwards-compat shim. Internal callers may still import from "./agent-harness".
// Phase 2.3+ will convert these to direct imports from "@muonroi/agent-harness-opentui".
//
// External consumers must NOT import this shim — they must use the published
// packages directly. We emit a one-shot console.warn on import, suppressed
// inside this repo by MUONROI_INTERNAL_SHIM_OK=1 (wired into vitest configs
// and the harness spawn helper). See CHANGELOG.md "Migration" block.
if (
  typeof process !== "undefined" &&
  process.env.MUONROI_INTERNAL_SHIM_OK !== "1" &&
  !(globalThis as { __muonroiShimWarned?: boolean }).__muonroiShimWarned
) {
  (globalThis as { __muonroiShimWarned?: boolean }).__muonroiShimWarned = true;
  console.warn(
    "[muonroi] DEPRECATED: importing from 'src/agent-harness' is internal-only. " +
      "External consumers must import from '@muonroi/agent-harness-core' or " +
      "'@muonroi/agent-harness-opentui'. See CHANGELOG.md migration section.",
  );
}

export * from "@muonroi/agent-harness-core";
export * from "@muonroi/agent-harness-opentui";
// Do NOT re-export test-spawn — it has its own non-overlapping callers
// (tests/harness/helpers.ts, src/mcp/opentui-spawn.ts) that import it directly.
