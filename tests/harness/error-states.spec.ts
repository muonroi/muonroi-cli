/**
 * error-states.spec.ts
 *
 * Asserts that a mock-LLM error causes a role=toast level=error event to
 * appear via driver.last_event("toast").
 *
 * Error injection: fixture `tests/harness/fixtures/llm/error.json` contains
 *   { "match": "__trigger_error__", "error": "mock LLM error: ..." }
 * When the prompt includes that sentinel string, mock-llm.ts throws — the
 * adapter generator propagates the throw, stream-loop.ts catches it and
 * yields { kind: "error" }, app.tsx case "error" calls agentRuntime.emitEvent
 * with kind="toast" level="error".
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/error-states.spec.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

describe.skipIf(process.platform === "win32")("error states E2E", () => {
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

  it("toast error event fires when mock-LLM throws", async () => {
    // The sentinel substring "__trigger_error__" matches the error fixture entry,
    // causing mock.complete() to throw → stream-loop catches → "error" chunk →
    // app.tsx emits toast event with level="error".
    // Note: toast is an *event* (agentRuntime.emitEvent), NOT a Semantic node, so
    // we wait with { event: "toast" } rather than { selector: "role=toast" }.
    driver.type("__trigger_error__");
    driver.press("Enter");

    await driver.wait_for({ event: "toast", timeoutMs: 10_000 });
    const event = driver.last_event("toast") as { kind: "toast"; level: string; text: string } | null;
    expect(event).not.toBeNull();
    expect(event?.level).toBe("error");
  });
});
