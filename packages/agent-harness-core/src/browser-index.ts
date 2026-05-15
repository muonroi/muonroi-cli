/**
 * Browser-safe entry point for @muonroi/agent-harness-core.
 *
 * Excludes Node-only modules:
 *   - mock-llm.ts  (uses node:fs / node:path, back-imports providers/types.js)
 *   - spec-helpers.ts (uses node:fs for schema loading)
 *   - transports/sidechannel.ts (uses NodeJS.WritableStream, Node-side fd3/fd4)
 *   - mcp-server.ts  (uses node:child_process, node:fs, node:os, node:path)
 *
 * Task 1.3 will move mock-llm type contracts into this package so they can
 * eventually be re-exported from the browser entry without Node deps.
 */
export * from "./driver.js";
export * from "./idle.js";
export * from "./predicate.js";
export * from "./protocol.js";
export * from "./registry.js";
export * from "./selector.js";
