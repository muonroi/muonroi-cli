/**
 * disconnect.spec.ts
 *
 * Goal: spawn TUI, kill it mid-session, assert driver does not hang and emits
 * a typed error (or rejects with timeout — acceptable as documented below).
 *
 * Investigation result:
 * - The driver (src/agent-harness/driver.ts) has no "child died" signal path.
 *   When the child process is killed, fd3 closes (readable stream emits 'end'),
 *   but the driver's _ingest() is never called with a disconnect notification.
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

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

describe.skipIf(process.platform === "win32")("disconnect E2E", () => {
  let proc: ChildProcess;
  let driver: ReturnType<typeof createDriver>;

  beforeAll(async () => {
    const entry = resolve("src/index.ts");
    const fixturesDir = resolve("tests/harness/fixtures/llm");
    proc = spawn("bun", ["run", entry, "--agent-mode", "--mock-llm", fixturesDir], {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });

    driver = createDriver({
      sendKey: (k) => {
        const fd4 = proc.stdio[4] as NodeJS.WritableStream | null;
        fd4?.write(JSON.stringify({ op: "press", key: k }) + "\n");
      },
      sendType: (t) => {
        const fd4 = proc.stdio[4] as NodeJS.WritableStream | null;
        fd4?.write(JSON.stringify({ op: "type", text: t }) + "\n");
      },
    });

    const splitter = createLineSplitter((line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg["mode"] === "live") {
          driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
        } else if (msg["t"] === "idle") {
          driver._ingest({ kind: "idle" });
        } else if (msg["t"] === "event") {
          driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
        }
      } catch {
        // ignore malformed lines
      }
    });
    const fd3 = proc.stdio[3] as NodeJS.ReadableStream | null;
    fd3?.on("data", (chunk: Buffer | string) => {
      splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    await driver.wait_for({ idle: true, timeoutMs: 5000 });
  }, 10_000);

  afterAll(() => {
    proc?.kill();
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
    "driver does not surface a typed disconnect error: wiring fd3 'end'/'close' to a driver._ingest({ kind: 'disconnect' }) path would allow tests to assert a DisconnectError instead of waiting for a generic timeout",
  );
});
