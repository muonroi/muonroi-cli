// Backwards-compat shim. Internal callers may still import from "./agent-harness".
// Phase 2 will convert these to direct imports from "@muonroi/agent-harness-opentui".
export * from "@muonroi/agent-harness-core";
export * from "./reconciler-hook.js";
// Re-export the OpenTUI-only files that stay here (Phase 2 will move these too).
export * from "./semantic.js";
// Do NOT re-export agent-mode, input-bridge, test-spawn —
// they have their own non-overlapping callers and adding them creates name collisions.
