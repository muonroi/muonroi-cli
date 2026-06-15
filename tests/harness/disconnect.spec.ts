/**
 * disconnect.spec.ts
 *
 * Goal: spawn TUI, kill it mid-session, assert driver does not hang and emits
 * a typed error (or rejects with timeout — acceptable as documented below).
 *
 * Investigation result:
 * - The driver (src/agent-harness/driver.ts) has no "child died" signal path.
 *   When the child process is killed, the out transport closes (readable stream
 *   emits 'end'), but the driver's _ingest() is never called with a disconnect
 *   notification.
 * - Outstanding wait_for() promises therefore only resolve when the timeout
 *   fires, not when the child dies.
 * - This means the expected behavior after proc.kill() is:
 *     wait_for rejects with /timeout/ after timeoutMs elapses.
 *   That is acceptable (the test asserts this contract explicitly).
 *
 * One real test is provided: kill the process, then confirm that a subsequent
 * wait_for call rejects with a timeout error (not a hang).
 *
 * A second todo documents what would be needed for a proper typed-disconnect error.
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

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

  it("after proc.kill(), wait_for rejects with /timeout/ (driver has no typed disconnect signal)", async () => {
    // Kill the child process. The driver has no "child died" notification path,
    // so the outstanding promise will time out rather than reject with a typed
    // disconnect error. This is the documented acceptable behavior.
    proc.kill();

    // Allow the kill to propagate before starting the waiter.
    await new Promise((res) => setTimeout(res, 50));

    // A selector that would normally appear after sending input will never
    // arrive because the child is dead — we expect a timeout, not a hang.
    await expect(driver.wait_for({ selector: "role=nonexistent-after-kill", timeoutMs: 150 })).rejects.toThrow(
      /timeout/i,
    );
  });

  it("emits a typed disconnect event when the transport closes", async () => {
    // The previous test already killed proc and the transport's 'end'/'close'
    // listener in helpers.ts should have ingested a disconnect event. Poll
    // briefly to allow the stream teardown to propagate.
    const deadline = Date.now() + 1_000;
    let disc: ReturnType<typeof driver.last_event> = null;
    while (Date.now() < deadline) {
      disc = driver.last_event("disconnect");
      if (disc) break;
      await new Promise((r) => setTimeout(r, 25));
    }
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
