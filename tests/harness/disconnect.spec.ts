/**
 * disconnect.spec.ts
 *
 * Goal: spawn TUI, kill it mid-session, assert the driver does not hang and
 * surfaces a TYPED disconnect instead of a generic timeout.
 *
 * Contract (since b014c9b9, packages/agent-harness-core/src/driver.ts —
 * unit-pinned by packages/agent-harness-core/__tests__/driver-close-waiters.spec.ts):
 * - When the out transport ends/closes, tests/harness/helpers.ts ingests a
 *   `disconnect` LiveEvent and THEN calls `driver._closeAllSubscribers()`.
 * - `_closeAllSubscribers()` marks the driver closed, rejects every PENDING
 *   `wait_for()` with `Error("Driver transport closed")` and clears its timeout
 *   timer, and terminates every `events()` iterator with `done: true`.
 * - Any `wait_for()` issued AFTER close rejects immediately with the same error.
 *
 * So after `proc.kill()` a waiter with a long timeout must reject PROMPTLY with
 * the transport-closed error — it must not sit out its full timeoutMs, and it
 * must not be reported as a timeout (a timeout is indistinguishable from "the
 * UI is just slow"; a disconnect is not).
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

/** Long enough that a timeout-based rejection would blow the test budget. */
const LONG_WAIT_MS = 60_000;
/** Upper bound for "prompt": kill -> pipe teardown -> reject. */
const PROMPT_REJECT_MS = 10_000;

describe("disconnect E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness();
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 5000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it(
    "after proc.kill(), a pending wait_for rejects promptly with the typed transport-closed error (not a timeout)",
    async () => {
      // Register the waiter BEFORE the kill so the pending-waiter rejection path
      // is exercised (not just the closed-on-entry fast path).
      const start = Date.now();
      const settled = driver.wait_for({ selector: "role=nonexistent-after-kill", timeoutMs: LONG_WAIT_MS }).then(
        () => ({ ok: true as const, err: null as unknown }),
        (err: unknown) => ({ ok: false as const, err }),
      );

      proc.kill();

      const result = await settled;
      const elapsedMs = Date.now() - start;

      expect(result.ok).toBe(false);
      expect(result.err).toBeInstanceOf(Error);
      expect((result.err as Error).message).toBe("Driver transport closed");
      // Prompt: rejected by the transport close, not by the 60s timeout timer.
      expect(elapsedMs).toBeLessThan(PROMPT_REJECT_MS);
    },
    PROMPT_REJECT_MS + 5_000,
  );

  it("a wait_for issued after the transport closed rejects immediately with the same typed error", async () => {
    const start = Date.now();
    await expect(driver.wait_for({ idle: true, timeoutMs: LONG_WAIT_MS })).rejects.toThrow(/^Driver transport closed$/);
    // Closed-on-entry path: no timer is armed at all.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("emits a typed disconnect event when the transport closes", () => {
    // helpers.ts ingests the disconnect event BEFORE closing the driver, and
    // the first test only resolved once the driver was closed — so the event
    // is already in the ring buffer; no polling needed.
    const disc = driver.last_event("disconnect");
    expect(disc).not.toBeNull();
    expect(disc?.t).toBe("event");
    if (disc && "kind" in disc) {
      expect(disc.kind).toBe("disconnect");
      // 'end' or 'close' both acceptable — order/source depends on platform
      // (POSIX fd 3/4 vs Windows named pipe) and on whether the kill closes
      // the readable cleanly or aborts.
      expect(["end", "close"]).toContain((disc as { reason: string }).reason);
    }
  });
});
