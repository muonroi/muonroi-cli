import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

// Skipped: requires a Semantic-wrapped Council picker dialog in the TUI.
// /council currently goes straight to runCouncilRound() with no modal picker.
// Re-enable after wiring <Semantic role="dialog" name="Council"> for the picker.
describe.skip("council flow E2E", () => {
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

  it("opens council picker on /council", async () => {
    driver.type("/council");
    driver.press("Enter");
    await driver.wait_for({ selector: 'role=dialog name~="Council"', timeoutMs: 3000 });
    expect(driver.query('role=dialog name~="Council"')).toBeTruthy();
  });

  it("selecting a participant renders the Debate Plan", async () => {
    driver.press("Down");
    driver.press("Enter");
    await driver.wait_for({ selector: 'name~="Debate Plan"', timeoutMs: 5000 });
    expect(driver.queryAll("role=log").length).toBeGreaterThan(0);
  });
});
