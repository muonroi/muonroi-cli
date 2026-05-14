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

// Placeholder value used by loadKeyForProvider — must be >= 20 chars so the
// provider is considered "reachable" and resolveParticipants returns >= 2 roles.
// The mock-llm short-circuit means this value is never sent to a real API.
const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

describe.skipIf(process.platform === "win32")("council flow E2E", () => {
  let proc: ChildProcess;
  let driver: ReturnType<typeof createDriver>;

  beforeAll(async () => {
    const entry = resolve("src/index.ts");
    const fixturesDir = resolve("tests/harness/fixtures/llm");
    const spawnEnv = { ...process.env };
    // loadKeyForProvider reads SILICONFLOW_API_KEY (>= 20 chars) to decide if
    // the provider is reachable. Without it, resolveParticipants returns [] and
    // runCouncil exits early before emitting any council_phase chunks.
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

  it("typing /council surfaces the slash menu", async () => {
    driver.type("/council");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 10_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
    // Press Escape to dismiss the menu and clear the input before the next test.
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
  });

  // Wave 2.5 wired globalThis.__muonroiMockLlm into createCouncilLLM.generate/debate/research
  // (src/council/llm.ts). council.json sequence fixture covers clarifier → spec synthesis →
  // debate-planner fallback. The council_phase chunk for "Clarification" is emitted immediately
  // before runPreflight blocks, so id=council-phases appears without needing to answer questions.
  //
  // NOTE: /council with no topic returns the help string (not __COUNCIL__). The topic must be
  // included in the command so app.tsx dispatches runCouncilV2.
  it("full council flow reaches Phase/Status renders", async () => {
    // Type the full command including the topic. The slash menu opens on "/" and
    // the filter narrows as we type — once the query is "council analyze..." no
    // item matches. app.tsx now falls through on Enter when filteredSlashItems
    // is empty: it closes the menu without key.preventDefault() so the textarea
    // submit handler fires with the full "/council <topic>" text.
    //
    // Wait for idle after type() so React commits the slashSearchQuery state
    // updates before Enter arrives — otherwise filteredSlashItems is still the
    // full list (stale state) and the Enter handler selects the first item.
    driver.type("/council analyze trade-offs for the project");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    // council_phase for "Clarification" fires before runPreflight blocks.
    await driver.wait_for({
      selector: "id=council-phases",
      timeoutMs: 30_000,
    });
    expect(driver.query("id=council-phases")).toBeTruthy();
  });
});
