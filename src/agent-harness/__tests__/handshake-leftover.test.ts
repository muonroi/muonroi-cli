/**
 * The handshake must not swallow the bytes that follow it.
 *
 * `waitForHandshake` reads the first line off the out pipe and used to discard
 * the rest of that chunk: it removed its own `data` listener and nothing ever
 * re-delivered the remainder, so a frame or an idle sentinel riding along with
 * the handshake vanished with no error and no trace. That presents as an
 * intermittent "child never became ready", which is the single hardest failure
 * to attribute on this transport.
 *
 * Measured over 75 spawns of the real agent-mode child, leftover was 0 bytes
 * every time — the child writes the handshake alone ~120 ms in and the parent is
 * already listening. This test therefore uses a fixture child that MANUFACTURES
 * the coalescing (see `fixtures/coalescing-handshake-child.ts`), which is what
 * makes the loss deterministic instead of a rare race.
 *
 * Windows-only by nature: the handshake exists only on the named-pipe transport.
 * `spawnPosix` hands back fd 3/4 with no handshake at all, so there is nothing
 * for this invariant to be about there.
 */

import { resolve } from "node:path";
import { createLineSplitter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnResult } from "../test-spawn.js";
import { spawnAgentTui } from "../test-spawn.js";

const FIXTURE = resolve("src/agent-harness/__tests__/fixtures/coalescing-handshake-child.ts");

let spawned: SpawnResult | undefined;

afterEach(() => {
  try {
    spawned?.proc.kill();
    spawned?.cleanup();
  } catch (err) {
    console.error(`[handshake-leftover] teardown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  spawned = undefined;
});

describe.skipIf(process.platform !== "win32")("named-pipe handshake", () => {
  it("delivers the lines that arrived in the same chunk as the handshake", async () => {
    spawned = await spawnAgentTui([FIXTURE], { handshakeTimeoutMs: 20_000 });

    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    spawned.outRead.on("data", (chunk: Buffer | string) => {
      splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    // The fixture writes both lines before the parent starts reading, so they
    // are already in the socket by the time the listener attaches; a short poll
    // covers the resume + unshift delivery, not a race we are hoping to win.
    const deadline = Date.now() + 10_000;
    while (lines.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const joined = lines.join("\n");
    // Before the fix both of these were dropped and `lines` stayed empty.
    expect(joined, `received lines: ${JSON.stringify(lines)}`).toContain('"t":"idle"');
    expect(joined, `received lines: ${JSON.stringify(lines)}`).toContain("POST-HANDSHAKE-LINE");

    // The handshake itself must NOT be re-delivered — it was consumed.
    expect(joined).not.toContain('"handshake"');
  }, 40_000);
});
