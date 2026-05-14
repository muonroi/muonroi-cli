/**
 * mcp-modal.spec.ts
 *
 * Verifies that the MCP browser modal (`id="mcp-modal"`) is reachable via
 * the `/mcp` slash command and is observable by the harness.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/mcp-modal.spec.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

describe.skipIf(process.platform === "win32")("MCP modal E2E", () => {
  let proc: ChildProcess;
  let driver: ReturnType<typeof createDriver>;

  beforeAll(async () => {
    const entry = resolve("src/index.ts");
    const fixturesDir = resolve("tests/harness/fixtures/llm");

    proc = spawn(
      "bun",
      [
        "run",
        entry,
        "--agent-mode",
        "--mock-llm",
        fixturesDir,
        "-k",
        "FAKE_KEY_FOR_TESTS",
        "-m",
        "deepseek-ai/DeepSeek-V4-Flash",
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
    );

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

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
  });

  it("MCP modal opens via /mcp slash command", async () => {
    // Type "/" first and wait for the slash menu to open.  The slash menu
    // filters items as characters arrive; if we send "/mcp\n" as a single
    // burst the Enter fires before React re-renders with the filtered list,
    // so the default-selected item (index 0 = "exit") wins instead of "mcp".
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    driver.type("m");
    driver.type("c");
    driver.type("p");
    // Wait for the filter to settle so filteredSlashItems[0] === "mcp".
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
    driver.press("Enter");
    await driver.wait_for({ selector: "id=mcp-modal", timeoutMs: 10_000 });
    const node = driver.query("id=mcp-modal");
    expect(node?.role).toBe("dialog");
  });
});
