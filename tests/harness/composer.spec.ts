import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

describe.skipIf(process.platform === "win32")("composer E2E", () => {
  let proc: ChildProcess;
  let driver: ReturnType<typeof createDriver>;

  beforeAll(async () => {
    const entry = resolve("src/index.ts");
    const fixturesDir = resolve("tests/harness/fixtures/llm");
    // -k FAKE + explicit -m bypass the first-run API-key modal on fresh clones
    // (e.g., CI runners without a keychain). Mock-LLM intercepts before the key
    // is ever validated against a real provider.
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

  it("composer is focused on startup", () => {
    expect(driver.query("focus")?.role).toBe("textbox");
  });

  it("composer Semantic exposes a textbox role", async () => {
    // The composer's live value is NOT mirrored into Semantic.value by design
    // (would require per-keystroke state sync). The harness can drive typing
    // via fd4 and the TUI updates the textarea natively, but observation here
    // is limited to role/focus presence.
    driver.type("hello world");
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    expect(driver.query("role=textbox")?.role).toBe("textbox");
  });

  it("Enter sends and shows response in log", async () => {
    driver.press("Enter");
    await driver.wait_for({ selector: "role=log", timeoutMs: 15_000 });
    const log = driver.query("role=log");
    expect(log?.role).toBe("log");
  });
});
