import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

describe.skipIf(process.platform === "win32")("ideal E2E", () => {
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

  it("typing /ideal surfaces the slash menu", async () => {
    driver.type("/ideal");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
  });

  it.skip("ideal status card renders after starting a run", async () => {
    // Blocked: the product-loop orchestrator calls createCouncilLLM (src/council/llm.ts)
    // which calls generateText (AI SDK) directly — NOT through the createAdapter mock hook.
    // The sequence fixture (tests/harness/fixtures/llm/ideal.json) covers the main chat
    // adapter path only. To unblock: add globalThis.__muonroiMockLlm short-circuit to
    // createCouncilLLM.generate/debate/research in src/council/llm.ts, then flip to it().
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 10_000 });
    expect(driver.query("id=ideal-status")?.role).toBe("region");
  });

  it.skip("can advance through ideal phases", async () => {
    // Same blocker as above — needs createCouncilLLM mock hook (see comment above).
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 10_000 });
    const phases = driver.queryAll("role=listitem");
    expect(phases.length).toBeGreaterThan(0);
  });
});
