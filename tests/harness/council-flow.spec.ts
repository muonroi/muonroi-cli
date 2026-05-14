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

  it("typing /council surfaces the slash menu", async () => {
    driver.type("/council");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 10_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
  });

  // Skipped: the mock-llm sequence fixture (tests/harness/fixtures/llm/council.json)
  // now drives the main chat adapter (createAdapter → globalThis.__muonroiMockLlm).
  // However, the council orchestrator's internal LLM calls (clarifier, debate-planner,
  // debate, synthesis) go through createCouncilLLM (src/council/llm.ts) which calls
  // generateText (AI SDK) directly — it does NOT check globalThis.__muonroiMockLlm.
  // Until createCouncilLLM.generate/debate/research also short-circuit through the
  // mock (requires a globalThis hook in src/council/llm.ts), the orchestrator will
  // hit real provider calls and fail with auth errors in the test environment.
  //
  // To unblock: add to src/council/llm.ts generate() method (before the generateText call):
  //   const mock = (globalThis as {__muonroiMockLlm?: {complete:(r:{prompt:string})=>Promise<{text:string}>}}).__muonroiMockLlm;
  //   if (mock) return mock.complete({ prompt: system + "\n" + prompt }).then(r => r.text);
  // Same pattern for debate() and research(). Then flip this it.skip to it().
  it.skip("full council flow reaches Phase/Status renders (council LLM mock hook missing)", async () => {
    driver.type("/council");
    driver.press("Enter");
    await driver.wait_for({
      all: [{ selector: "id=council-phases" }],
      timeoutMs: 30_000,
    });
    expect(driver.query("id=council-phases")).toBeTruthy();
  });
});
