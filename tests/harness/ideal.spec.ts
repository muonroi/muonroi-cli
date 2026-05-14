import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

// Placeholder value used by loadKeyForProvider — must be >= 20 chars so the
// provider is considered "reachable". The mock-llm short-circuit means this
// value is never sent to a real API.
const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

describe.skipIf(process.platform === "win32")("ideal E2E", () => {
  let proc: ChildProcess;
  let driver: ReturnType<typeof createDriver>;

  beforeAll(async () => {
    const entry = resolve("src/index.ts");
    const fixturesDir = resolve("tests/harness/fixtures/llm");
    const spawnEnv = { ...process.env };
    spawnEnv.SILICONFLOW_API_KEY = MOCK_PROVIDER_KEY;
    proc = spawn(
      "bun",
      [
        "run",
        entry,
        "--agent-mode",
        "--mock-llm",
        fixturesDir,
        "-k",
        MOCK_PROVIDER_KEY,
        "-m",
        "deepseek-ai/DeepSeek-V4-Flash",
      ],
      {
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        env: spawnEnv,
      },
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

  it("typing /ideal surfaces the slash menu", async () => {
    driver.type("/ideal");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
    // Press Escape to dismiss the menu before the next test.
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
  });

  it("ideal status card renders after starting a run", async () => {
    // loop-driver.ts emits product_status_card after the discover phase
    // (before gather blocks on user input), so id=ideal-status appears without
    // needing to drive the full gather/research/sprint flow.
    //
    // Type the full command including the topic. The slash menu opens on "/"
    // but once the filter has no matching item, Enter closes the menu and lets
    // the textarea submit the full "/ideal <topic>" text (app.tsx fix: when
    // filteredSlashItems is empty, Enter falls through without preventDefault).
    // Wait for idle after type() so React commits the slashSearchQuery state
    // updates before Enter arrives (avoids stale filteredSlashItems issue).
    driver.type("/ideal build a counter --max-sprints 1");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 30_000 });
    expect(driver.query("id=ideal-status")).toBeTruthy();
  });

  it("can advance through ideal phases", async () => {
    // ProductStatusCard renders <Semantic id="ideal-phase-sprint" role="listitem">
    // and <Semantic id="ideal-phase-cost" role="listitem"> as children of id=ideal-status.
    // The card is visible once product_status_card chunk fires (discover stage).
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 10_000 });
    const phases = driver.queryAll("role=listitem");
    expect(phases.length).toBeGreaterThan(0);
  });
});
