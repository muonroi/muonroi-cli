/**
 * tests/harness/worker-grounding-tui.spec.ts
 *
 * TUI E2E: a delegated worker answers "All tests pass." without running any
 * test. The host grounds the worker's final answer against the worker's OWN
 * recorded tool calls (StreamRunner → worker-grounding.ts) before the result is
 * saved, so the orchestrator receives a structured `[host-grounding]` flag and
 * the TUI shows a grounding-flag event — instead of an unqualified "complete".
 *
 * Real path: TUI → `task` tool → worker child process (--background-task-file)
 * → StreamRunner → completeDelegation → waitForDelegation → main's next request.
 * Mock provider only; the worker is scripted by system-prompt route.
 */

import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { type InspectedCall, loadDumpedRecordings } from "./recording.js";

const WORKER_ROLE_LINE = "You are the General sub-agent";
const WORKER_ANSWER = "Implemented the parser. All tests pass.";

const USAGE = {
  inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function toolCallRound(callId: string, toolName: string, input: Record<string, unknown>): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: callId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

function textRound(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

function promptJson(call: InspectedCall): string {
  return JSON.stringify(call.options.prompt);
}

function safeLoad(path: string): InspectedCall[] {
  try {
    return loadDumpedRecordings(path);
  } catch (err) {
    process.stderr.write(`[worker-grounding-tui] dump not readable yet (${path}): ${(err as Error).message}\n`);
    return [];
  }
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("worker grounding TUI: an unsupported 'all tests pass' reaches the orchestrator flagged", () => {
  let handle: CostLeakHarness | null = null;

  beforeAll(async () => {
    handle = await spawnCostLeakHarness(
      {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        stream: [
          toolCallRound("task-1", "task", {
            agent: "general",
            description: "implement the parser",
            prompt: "implement the parser and report",
            modelId: "deepseek-v4-flash",
            background: false,
            // An edit task must carry a writeScope or the host refuses the dispatch (M9).
            writeScope: ["src/"],
          }),
          textRound("Noted the worker result."),
        ],
        // The worker makes no tool call at all — in particular no test run.
        routes: [{ systemIncludes: WORKER_ROLE_LINE, stream: [textRound(WORKER_ANSWER)] }],
      },
      {
        // The orchestrator dispatches a worker: fresh project, not the checkout's .planning/.
        projectFiles: { "package.json": JSON.stringify({ name: "worker-grounding-fixture", version: "0.0.0" }) },
      },
    );
  }, 120_000);

  afterAll(() => handle?.cleanup());

  it("flags the claim in the delegated result and shows it in the TUI", async () => {
    if (!handle) throw new Error("harness failed to spawn");
    const h = handle;
    h.driver.type("please dispatch a worker to implement the parser");
    h.driver.press("Enter");

    const handoff = await waitFor(
      "the main agent to receive the worker result",
      () =>
        existsSync(h.dumpPath)
          ? safeLoad(h.dumpPath).find((c) => c.role === "top-level" && promptJson(c).includes(WORKER_ANSWER))
          : undefined,
      120_000,
    ).catch((err: unknown) => {
      process.stderr.write(`[worker-grounding-tui] TUI at timeout:\n${h.driver.render_text()}\n`);
      throw err;
    });

    const text = promptJson(handoff);
    // The worker's own words still arrive, unmodified...
    expect(text).toContain(WORKER_ANSWER);
    // ...but carrying the host's structured flag, which the orchestrator sees.
    expect(text).toContain("[host] Grounding check:");
    expect(text).toContain("[host-grounding]");
    expect(text).toContain("no test command ran in the recorded tool calls");
    expect(text).toContain("Execution: complete");

    // The TUI shows it: grounding-flag event attributed to the worker.
    await h.driver.wait_for({ event: "grounding-flag", timeoutMs: 15_000 });
    const flag = h.driver.last_event("grounding-flag") as { claims?: string[] } | undefined;
    expect(flag?.claims?.join(" ")).toContain("All tests pass");
    expect(flag?.claims?.join(" ")).toContain("worker");

    await exitTuiAndWaitForDump(h, 30_000);
  }, 180_000);
});
