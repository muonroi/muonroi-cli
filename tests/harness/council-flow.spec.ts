import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

// Unskipped: /council does not pop a picker dialog (goes straight to
// runCouncilRound). After Phase 8 the council renderers (CouncilPhaseTimeline,
// CouncilStatusList, CouncilMessageBubble, etc.) are wrapped in <Semantic> so
// the harness can observe them as they appear.
describe.skipIf(process.platform === "win32")("council flow E2E", () => {
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
        if (msg.mode === "live") {
          driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
        } else if (msg.t === "idle") {
          driver._ingest({ kind: "idle" });
        } else if (msg.t === "event") {
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

  it("composer accepts /council and triggers council UI", async () => {
    driver.type("/council");
    driver.press("Enter");
    // Council UI elements appear as the round starts. Any of the wrapped
    // Semantic nodes (phases listbox, status listbox, or council-msg listitem)
    // signals the flow has reached the renderer.
    await driver.wait_for(
      {
        all: [
          {
            selector: "id=council-phases",
          },
        ],
        timeoutMs: 30_000,
      },
      // Fall back to any council-* node if the phases listbox path doesn't fire.
    );
    const phases = driver.query("id=council-phases");
    const status = driver.query("id=council-status");
    const anyMsg = driver.queryAll("role=listitem").find((n) => n.id?.startsWith("council-msg-"));
    expect(phases || status || anyMsg).toBeTruthy();
  });
});
