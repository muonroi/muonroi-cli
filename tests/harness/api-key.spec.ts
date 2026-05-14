/**
 * api-key.spec.ts
 *
 * Verifies that the API-key modal (`id="api-key-modal"`) is visible on a
 * fresh-clone boot (no -k flag, no saved keychain entry) and that the input
 * field is queryable by the agent harness.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/api-key.spec.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

describe.skipIf(process.platform === "win32")("api-key modal E2E", () => {
  let proc: ChildProcess;
  let driver: ReturnType<typeof createDriver>;

  beforeAll(async () => {
    const entry = resolve("src/index.ts");
    const fixturesDir = resolve("tests/harness/fixtures/llm");

    // Spawn WITHOUT -k so the API-key modal actually appears.
    // --mock-llm is still passed so any accidental LLM call doesn't hit a real provider.
    // --agent-mode enables fd3/fd4 sidechannels.
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

    // Wait for the modal to appear (or for idle if already visible in first frame).
    // Use a longer timeout since fresh-boot can be slow in WSL CI.
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
  });

  it("api key modal appears on fresh clone", async () => {
    // The modal should appear immediately on boot without a saved key.
    await driver.wait_for({ selector: "id=api-key-modal", timeoutMs: 15_000 });
    const node = driver.query("id=api-key-modal");
    expect(node?.role).toBe("dialog");
  });

  it("can type into api key input", async () => {
    driver.type("xai-t");
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
    const input = driver.query("id=api-key-input");
    expect(input).not.toBeNull();
  });

  it.skip("submitting valid key dismisses modal", async () => {
    // Skipped: requires real keychain integration (saveUserSettings persists
    // to disk and the modal reads from there). Cannot be driven reliably in
    // a headless test without a real xai- key that passes validation.
  });
});
