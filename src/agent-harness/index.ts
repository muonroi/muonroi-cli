// Backwards-compat shim. Internal callers may still import from "./agent-harness".
// Phase 2.3+ will convert these to direct imports from "@muonroi/agent-harness-opentui".
export * from "@muonroi/agent-harness-core";
export * from "@muonroi/agent-harness-opentui";
// Do NOT re-export test-spawn — it has its own non-overlapping callers
// (tests/harness/helpers.ts, src/mcp/opentui-spawn.ts) that import it directly.
