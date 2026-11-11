/**
 * tests/harness/cost-leak-b3-tui.spec.ts
 *
 * Phase D B3 — TUI E2E: sub-agent `prepareStep` compactor rewrites older
 * tool_result parts into short summary stubs once cumulative message-chars
 * exceed MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS.
 *
 * Strategy: the TUI top-level agent is the ORCHESTRATOR (default execution
 * role since b014c9b9). Its `task` dispatch always goes through runDelegation
 * (Agent.runTask, src/orchestrator/orchestrator.ts), which launches the worker
 * as a DETACHED background process (src/orchestrator/delegations.ts) that runs
 * runTaskRequest → StreamRunner — the sub-agent loop that owns the compactor.
 * That process loads the same `--mock-llm` dir with its own fresh cursor and
 * dumps to `<calls>.worker-<pid>.json`, so the fixture is split by role:
 *
 *   orchestrator `stream`:
 *     #1 tool-call "task" (agent=general, explicit modelId, background=false
 *        so the host waits and returns the result in-turn)
 *     #2 final text "all done"
 *   worker route ("You are the General sub-agent"):
 *     #1-3 tool-call "read_file" (3 rounds, ~30k each)
 *     #4 final text "subagent done"
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

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { isMainAgentCall, loadDumpedRecordings, loadWorkerDumpedRecordings } from "./recording.js";

/** Role line of the general worker (src/orchestrator/prompts.ts buildSubagentPrompt). */
const WORKER_ROLE_LINE = "You are the General sub-agent";

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
      // Distinct bulk fill per file ('b','c','d') so each read is byte-distinct.
      const fill = String.fromCharCode("a".charCodeAt(0) + i);
      writeFileSync(p, marker + fill.repeat(LARGE_PAYLOAD_CHARS - marker.length), "utf8");
    }

    // 20_000 is the minimum the settings validator accepts. With ~30k tool
    // results, compaction triggers by sub-agent round 2.
    process.env.MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS = "20000";
    process.env.MUONROI_SUBAGENT_COMPACT_KEEP_LAST = "1";
    // Disable the sub-agent cap's content-hash dedup: the harness re-processes
    // each tool result through the cap, so the second pass would dedup a read
    // against its own first pass ("[dup of call #N]") and collapse the 30k
    // payload to a pointer stub BEFORE cumulative history grows past the B3
    // threshold — masking the very compaction this spec verifies. Production
    // keeps dedup ON (default); only this accumulation test opts out.
    process.env.MUONROI_SUBAGENT_CAP_DEDUP = "0";

    handle = await spawnCostLeakHarness(
      {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        stream: [
          // Orchestrator: dispatch the reads to a worker. Use "general", NOT
          // "explore": the task tool routes explore to the read-only `delegate`
          // research executor (src/tools/registry.ts). The orchestrator must
          // name a catalog modelId (validateWorkerSelection), and
          // background=false makes the host wait so the result returns in-turn.
          buildToolCallRound("task-1", "task", {
            agent: "general",
            description: "scan source files",
            prompt: "read the three big payload files and summarize them",
            modelId: "deepseek-v4-flash",
            background: false,
            // Unscoped shell-capable worker: an explicit choice, refused when omitted
            // (workerWriteScopeRequiredError, src/orchestrator/orchestration-policy.ts).
            sharedExecution: true,
          }),
          // Orchestrator closes with a stop after the task tool returns.
          buildFinalTextRound("all done"),
        ],
        routes: [
          {
            systemIncludes: WORKER_ROLE_LINE,
            stream: [
              // Worker rounds — each reads a different file (distinct content
              // avoids the cross-turn dedup wrapper masking the payload before
              // compaction can see it).
              buildToolCallRound("sub-1", "read_file", { file_path: join(payloadDir, "big1.txt") }),
              buildToolCallRound("sub-2", "read_file", { file_path: join(payloadDir, "big2.txt") }),
              buildToolCallRound("sub-3", "read_file", { file_path: join(payloadDir, "big3.txt") }),
              buildFinalTextRound("subagent done"),
            ],
          },
        ],
      },
      // Safe mode routes every worker tool through owner approval
      // (src/orchestrator/worker-approval.ts gateWorkerTools); auto-edit
      // auto-approves read_file so the worker's reads run unattended.
      {
        permission: "auto-edit",
        // The orchestrator dispatches a worker; keep the FLOW gate independent of
        // the developer checkout's machine-local .planning/STATE.md.
        isolatedCwd: true,
      },
    );
  }, 120_000);

  afterAll(() => {
    handle?.cleanup();
    bestEffortRemoveSync(payloadDir, "tests/harness/cost-leak-b3-tui.spec.ts");
  });

  it("dumped sub-agent calls contain the sub-agent compactor elision marker", async () => {
    if (!handle) throw new Error("harness failed to spawn");

    // Non-chitchat prompt so the orchestrator does NOT strip the tool set
    // (chitchat path: see src/orchestrator/orchestrator.ts isChitchat).
    handle.driver.type("please dispatch a sub-agent to read every payload file and summarize");
    handle.driver.press("Enter");

    // Poll the orchestrator's dump (event-driven, not wall-clock; rewritten after
    // every doStream). Its SECOND round is fed the task result, which exists
    // only once the worker process has finished all of its rounds.
    const deadline_b3 = Date.now() + 60_000;
    while (Date.now() < deadline_b3) {
      if (existsSync(handle.dumpPath)) {
        try {
          if (loadDumpedRecordings(handle.dumpPath).filter(isMainAgentCall).length >= 2) break;
        } catch (err) {
          // Dump mid-rotation — the atomic rename means the next read is clean.
          console.debug(`[b3 spec] dump not readable yet: ${(err as Error).message}`);
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    await exitTuiAndWaitForDump(handle, 30_000);

    expect(existsSync(handle.dumpPath)).toBe(true);
    const mainCalls = loadDumpedRecordings(handle.dumpPath).filter(isMainAgentCall);
    const workerCalls = loadWorkerDumpedRecordings(handle.dumpPath);
    const roles = () =>
      `main rounds=${mainCalls.length}; worker calls: ${workerCalls.map((c) => `[${c.index}] ${c.role}`).join(", ")}`;
    // The orchestrator dispatched the worker and was told it completed.
    expect(mainCalls.length, roles()).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(mainCalls[1]?.options.prompt ?? {}), roles()).toContain("Execution: complete");

    // Sub-agent calls, classified by the role line (inferRole in recording.ts).
    const subCalls = workerCalls.filter((c) => c.role === "sub-agent" && c.systemText.includes(WORKER_ROLE_LINE));
    if (subCalls.length === 0) {
      throw new Error(`No sub-agent calls detected. ${roles()}`);
    }
    expect(subCalls.length).toBeGreaterThanOrEqual(2);

    // Dumped prompts are parsed JSON, so re-serialising them cannot throw.
    const elidedSubCalls = subCalls.filter((c) =>
      JSON.stringify(c.options.prompt).includes("elided by sub-agent compactor"),
    );
    if (elidedSubCalls.length === 0) {
      const sizes = subCalls.map((c) => c.promptChars).join(", ");
      throw new Error(`No sub-agent compaction marker across ${subCalls.length} sub-agent calls. Sizes: ${sizes}`);
    }
    expect(elidedSubCalls.length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
