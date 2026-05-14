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
  });

  it.skip("ideal status card renders after starting a run", async () => {
    // Blocked: id="ideal-status" is rendered by ProductStatusCard
    // (src/ui/cards/product-status-card.tsx:66) which only mounts when productStatus
    // state is non-null. productStatus is set in app.tsx only when a chunk of type
    // "product_status_card" arrives. However, no code in src/product-loop/* emits that
    // chunk type — it is defined in src/types/index.ts:369 and consumed in app.tsx:3020
    // but never yielded by the sprint runner, loop driver, or phase runner.
    //
    // To unblock:
    //   1. Add a "product_status_card" yield in src/product-loop/sprint-runner.ts after
    //      each sprint completes, emitting criteriaMet/criteriaPartial/criteriaUnmet counts.
    //   2. Also add a trigger in src/product-loop/loop-driver.ts (gather stage) for a
    //      pre-sprint status card so the card appears before the first sprint runs.
    //   3. Then add a driver.type("/ideal build a counter --max-sprints 1") step here,
    //      handle the gather questions via driver answers, and wait for id=ideal-status.
    //   Estimated effort: ~2-3h (emit chunk + fixture entries for gather questions + spec).
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 10_000 });
    expect(driver.query("id=ideal-status")?.role).toBe("region");
  });

  it.skip("can advance through ideal phases", async () => {
    // Blocked: same as above — id="ideal-status" never appears (product_status_card
    // chunk is dead code; src/product-loop/* never emits it). Additionally, the test
    // relies on "role=listitem" nodes which do appear when council_info_card chunks are
    // emitted (app.tsx wraps each card as role="listitem"), but without first triggering
    // /ideal and handling the gather question card, the product loop never starts.
    //
    // To unblock: fix the product_status_card emit path (see test above), then:
    //   driver.type('/ideal build a counter --max-sprints 1');
    //   driver.press('Enter');
    //   // handle gather question card if it appears (press 'y' for preflight)
    //   await driver.wait_for({ selector: 'role=listitem', timeoutMs: 15_000 });
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 10_000 });
    const phases = driver.queryAll("role=listitem");
    expect(phases.length).toBeGreaterThan(0);
  });
});
