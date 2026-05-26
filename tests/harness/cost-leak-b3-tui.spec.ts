/**
 * tests/harness/cost-leak-b3-tui.spec.ts
 *
 * Phase D B3 — TUI E2E: sub-agent `prepareStep` compactor rewrites older
 * tool_result parts into short summary stubs once cumulative message-chars
 * exceed MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS.
 *
 * Strategy: emit a top-level `task` tool-call → orchestrator runs
 * runTaskRequest which spawns a sub-agent streamText loop. The same mock
 * model instance handles BOTH calls in sequence (one shared
 * doStreamCalls). The fixture is laid out as:
 *
 *   #1 top-level: tool-call "task" → orchestrator dispatches sub-agent
 *   #2-4 sub-agent: tool-call "read_file" (3 rounds, ~30k each)
 *   #5 sub-agent: final text "subagent done"
 *   #6 top-level: final text "all done"
 *
 * With MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS=20000 (minimum allowed by
 * the settings validator) and ~30k payload per read, sub-agent compaction
 * fires on round 3+ and rewrites the earlier tool_result into a marker
 * containing "elided by sub-agent compactor".
 *
 * Trade-off: the assertion looks for the production compactor label
 * substring in dumped sub-agent calls rather than a precise cumulative-
 * char ceiling — the latter depends on system-prompt size for sub-agent
 * (which varies with mode/PIL state and is not the property under test).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { inspectByRole, loadDumpedRecordings } from "./recording.js";

const LARGE_PAYLOAD_CHARS = 30_000;

function buildToolCallRound(callId: string, toolName: string, input: Record<string, unknown>): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: callId,
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
    },
  ];
}

function buildFinalTextRound(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "final" },
    { type: "text-delta", id: "final", delta: text },
    { type: "text-end", id: "final" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 60, noCache: 60, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
    },
  ];
}

describe("B3 TUI: sub-agent compactor reduces cumulative prompt size", () => {
  let handle: CostLeakHarness | null = null;
  let payloadDir: string;

  beforeAll(async () => {
    payloadDir = mkdtempSync(join(tmpdir(), "muonroi-cl-b3-payload-"));
    for (let i = 1; i <= 3; i++) {
      const p = join(payloadDir, `big${i}.txt`);
      const marker = `payload-${i}-${"ABCDEFGH".repeat(4)}\n`;
      writeFileSync(p, marker + "x".repeat(LARGE_PAYLOAD_CHARS - marker.length), "utf8");
    }

    // 20_000 is the minimum the settings validator accepts. With ~30k tool
    // results, compaction triggers by sub-agent round 2.
    process.env.MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS = "20000";
    process.env.MUONROI_SUBAGENT_COMPACT_KEEP_LAST = "1";

    handle = await spawnCostLeakHarness({
      provider: "siliconflow",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      stream: [
        // Top-level: dispatch to sub-agent.
        buildToolCallRound("task-1", "task", {
          agent: "explore",
          description: "scan source files",
          prompt: "read the three big payload files and summarize them",
        }),
        // Sub-agent rounds — each reads a different file (distinct content
        // avoids the cross-turn dedup wrapper masking the payload before
        // compaction can see it).
        buildToolCallRound("sub-1", "read_file", { file_path: join(payloadDir, "big1.txt") }),
        buildToolCallRound("sub-2", "read_file", { file_path: join(payloadDir, "big2.txt") }),
        buildToolCallRound("sub-3", "read_file", { file_path: join(payloadDir, "big3.txt") }),
        buildFinalTextRound("subagent done"),
        // Top-level closes with a stop after the task tool returns.
        buildFinalTextRound("all done"),
      ],
    });
  }, 30_000);

  afterAll(() => {
    handle?.cleanup();
    try {
      rmSync(payloadDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("dumped sub-agent calls contain the sub-agent compactor elision marker", async () => {
    if (!handle) throw new Error("harness failed to spawn");

    // Non-chitchat prompt so the orchestrator does NOT strip the tool set
    // (chitchat path: see src/orchestrator/orchestrator.ts isChitchat).
    handle.driver.type("please dispatch a sub-agent to read every payload file and summarize");
    handle.driver.press("Enter");

    // Poll the dump file for >=3 recorded calls (event-driven, not wall-clock).
    // The dump is written after every doStream call by writeDumpAlways.
    const deadline_b3 = Date.now() + 60_000;
    let calls_b3: ReturnType<typeof loadDumpedRecordings> = [];
    while (Date.now() < deadline_b3) {
      if (existsSync(handle.dumpPath)) {
        calls_b3 = loadDumpedRecordings(handle.dumpPath);
        if (calls_b3.length >= 3) break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    await exitTuiAndWaitForDump(handle, 30_000);

    expect(existsSync(handle.dumpPath)).toBe(true);
    const calls = loadDumpedRecordings(handle.dumpPath);
    expect(calls.length).toBeGreaterThanOrEqual(3);

    // Filter to sub-agent calls (system prompt begins "You are the * sub-agent").
    const subCalls = inspectByRole({ calls: calls.map((c) => c.options) }, "sub-agent");
    if (subCalls.length === 0) {
      const roles = calls.map((c) => `[${c.index}] ${c.role}`).join(", ");
      throw new Error(`No sub-agent calls detected. Roles seen: ${roles}`);
    }
    expect(subCalls.length).toBeGreaterThanOrEqual(2);

    const elidedSubCalls = subCalls.filter((c) => {
      try {
        return JSON.stringify(c.options.prompt).includes("elided by sub-agent compactor");
      } catch {
        return false;
      }
    });
    if (elidedSubCalls.length === 0) {
      const sizes = subCalls.map((c) => c.promptChars).join(", ");
      throw new Error(`No sub-agent compaction marker across ${subCalls.length} sub-agent calls. Sizes: ${sizes}`);
    }
    expect(elidedSubCalls.length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
