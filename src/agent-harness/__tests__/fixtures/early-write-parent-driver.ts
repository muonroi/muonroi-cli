/**
 * Runs `spawnAgentTui` against the early-write child FROM A BUN PARENT, and
 * prints a single machine-readable RESULT line.
 *
 * This indirection exists because the vitest worker is **Node**, not Bun —
 * measured: `typeof Bun === "undefined"`, `process.versions.node === "24.18.0"`
 * inside a test. Node's `net` server socket stays at `readableFlowing === null`
 * (buffering) until something consumes it, so the early-write race simply cannot
 * happen there and a test asserting it directly is green no matter what the code
 * does — measured at in-pipe gaps of 300/600/1000/1500 ms, all green pre-fix.
 *
 * Bun's server socket flips itself to `readableFlowing === true` with no
 * listener attached and discards what arrives. Every production caller of
 * `spawnAgentTui` — `src/mcp/opentui-spawn.ts` (the MCP `tui.start` path) and
 * `src/self-qa/{orchestrator,agentic-loop}.ts` — runs under `bun run`, so the
 * loss is a real shipped path that the Node-hosted suite is structurally blind
 * to. Spawning this driver puts the Bun parent back in the loop.
 */

import { resolve } from "node:path";
import { spawnAgentTui } from "../../test-spawn.js";

/**
 * Which fake child to drive. Defaults to the early-write child; the coalescing
 * child is passed explicitly so the LEFTOVER path (capture relay → paused →
 * second relay) is exercised under Bun too. `handshake-leftover.test.ts` calls
 * `spawnAgentTui` directly and therefore only ever ran that path under Node,
 * where the Bun pause/resume behaviour it documents cannot occur.
 */
const CHILD = resolve(process.argv[2] ?? "src/agent-harness/__tests__/fixtures/early-write-handshake-child.ts");

/** Short on purpose: a failure should report in seconds, not in the 90 s default. */
const HANDSHAKE_TIMEOUT_MS = 8_000;
/** How long to collect after the handshake resolves, for the post-handshake line. */
const COLLECT_MS = 1_200;

function emit(result: Record<string, unknown>): void {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
}

try {
  const spawned = await spawnAgentTui([CHILD], { handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS });

  const chunks: string[] = [];
  spawned.outRead.on("data", (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  await new Promise((r) => setTimeout(r, COLLECT_MS));
  emit({ ok: true, received: chunks.join("") });

  spawned.proc.kill();
  spawned.cleanup();
} catch (err) {
  // The pre-fix failure mode: the handshake was written into a flowing socket
  // with no listener, discarded, and the reader then waited out the full
  // timeout on a child that had already spoken.
  emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
}

process.exit(0);
