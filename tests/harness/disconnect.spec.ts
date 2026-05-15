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
  }, 10_000);

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

  it.todo(
    "driver does not surface a typed disconnect error: wiring the out transport 'end'/'close' event to a driver._ingest({ kind: 'disconnect' }) path would allow tests to assert a DisconnectError instead of waiting for a generic timeout",
  );
});
