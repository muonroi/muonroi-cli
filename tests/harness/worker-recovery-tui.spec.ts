/**
 * tests/harness/worker-recovery-tui.spec.ts
 *
 * TUI E2E: a delegated worker survives a transient provider 503 AND an answer
 * cut off by the output limit, end-to-end through the real TUI → `task` tool →
 * worker child process → StreamRunner (mock provider only).
 *
 * Both are measured failure classes from the TCIS.MCP.Docs run (sessions
 * 8a5bd89c2be0 / 4edc02516a92, 2026-11-02..04):
 *   - lively-amber-owl: "Task failed: HTTP 503: The engine is currently
 *     overloaded" after one tool call — no retry, the job died.
 *   - keen-blue-lynx: finishReason=length with 53141 chars of answer — no
 *     continuation, the job died "worker_incomplete".
 *
 * The worker runs in its own child process with a fresh copy of the fixture,
 * so the fixture routes rounds by system prompt:
 *   main TUI:  #1 tool-call `task` (foreground)   #2 final text
 *   worker:    #1 tool-call read_file
 *              #2 doStream REJECTS with APICallError 503 (request-level, like a
 *                 real HTTP error status — not an in-stream error part)
 *              #3 (same request, retried) "WORKER_PART_A " finish=length
 *              #4 (tool-free continuation turn) "WORKER_PART_B" finish=stop
 *
 * Evidence asserted from the recorded doStream calls of BOTH processes: the
 * rejected request and its byte-identical retry, the tool-free continuation
 * prompt, and the joined answer reaching the main agent as a completed result.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { type InspectedCall, loadDumpedRecordings } from "./recording.js";

const WORKER_ROLE_LINE = "You are the General sub-agent";

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

function textRound(text: string, finish: "stop" | "length"): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: finish, raw: undefined }, usage: USAGE },
  ];
}

function rejectRound(statusCode: number, message: string): unknown[] {
  return [{ type: "error", rejectRequest: true, error: { statusCode, message } }];
}

function promptJson(call: InspectedCall): string {
  return JSON.stringify(call.options.prompt);
}

function workerDumps(dumpPath: string): string[] {
  const dir = dirname(dumpPath);
  const prefix = `${dumpPath.slice(dir.length + 1)}.worker-`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => join(dir, f));
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

function safeLoad(path: string): InspectedCall[] {
  try {
    return loadDumpedRecordings(path);
  } catch (err) {
    // Mid-rewrite by the child (atomic rename, but be tolerant): retry next poll.
    process.stderr.write(`[worker-recovery-tui] dump not readable yet (${path}): ${(err as Error).message}\n`);
    return [];
  }
}

describe("worker recovery TUI: transient 503 retry + output-limit continuation", () => {
  let handle: CostLeakHarness | null = null;

  beforeAll(async () => {
    handle = await spawnCostLeakHarness({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      stream: [
        // `modelId` is required by the task schema; `background:false` makes the
        // main turn wait for the worker's saved result.
        toolCallRound("task-1", "task", {
          agent: "general",
          description: "summarize the notes file",
          prompt: "read the notes file and report what it says",
          modelId: "deepseek-v4-flash",
          background: false,
        }),
        textRound("all done", "stop"),
      ],
      routes: [
        {
          systemIncludes: WORKER_ROLE_LINE,
          stream: [
            // The worker's tool asks the owner (this TUI) for approval in safe
            // mode; the test answers "Allow once" below.
            toolCallRound("sub-1", "read_file", { file_path: "package.json" }),
            rejectRound(503, "The engine is currently overloaded, please try again later"),
            textRound("WORKER_PART_A ", "length"),
            textRound("WORKER_PART_B", "stop"),
          ],
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    // Opt-in forensics: keep both processes' recorded calls for a failed run.
    const keepDir = process.env.WORKER_RECOVERY_DEBUG_DIR;
    if (keepDir && handle && existsSync(handle.dumpPath)) {
      const { copyFileSync } = await import("node:fs");
      for (const p of [handle.dumpPath, ...workerDumps(handle.dumpPath)])
        copyFileSync(p, join(keepDir, p.slice(dirname(p).length + 1)));
    }
    handle?.cleanup();
  });

  it("retries the rejected worker request, continues the cut answer, and hands the joined answer up", async () => {
    if (!handle) throw new Error("harness failed to spawn");
    const h = handle;
    h.driver.type("please dispatch a worker to read the notes file and summarize it");
    h.driver.press("Enter");

    // Main agent's follow-up request after the task tool returned (dump is
    // rewritten after every successful doStream). Approve the worker's tool
    // request when its card appears (default option = "Allow once").
    let approvals = 0;
    const handoff = await waitFor(
      "the main agent to receive the worker result",
      () => {
        if (h.driver.query("id=payment-approval")) {
          approvals += 1;
          h.driver.press("Enter");
        }
        return existsSync(h.dumpPath)
          ? safeLoad(h.dumpPath).find((c) => c.role === "top-level" && promptJson(c).includes("WORKER_PART"))
          : undefined;
      },
      120_000,
    ).catch((err: unknown) => {
      // Name what the TUI is showing (an approval card, an error toast …) so a
      // timeout is diagnosable instead of bare.
      process.stderr.write(`[worker-recovery-tui] TUI at timeout:\n${h.driver.render_text()}\n`);
      process.stderr.write(
        `[worker-recovery-tui] last askcard: ${JSON.stringify(h.driver.last_event("askcard-open"))}\n`,
      );
      throw err;
    });
    const handoffText = promptJson(handoff);
    expect(handoffText).toContain("WORKER_PART_A WORKER_PART_B");
    expect(handoffText).toContain("Execution: complete");
    expect(handoffText).not.toContain("worker_incomplete");
    expect(handoffText).not.toContain("Task failed");
    expect(approvals).toBeGreaterThanOrEqual(1);

    const workerCalls = await waitFor(
      "the worker child's recorded calls",
      () => {
        const calls = workerDumps(h.dumpPath).flatMap((p) => safeLoad(p));
        return calls.filter((c) => c.systemText.includes(WORKER_ROLE_LINE)).length >= 4
          ? calls.filter((c) => c.systemText.includes(WORKER_ROLE_LINE))
          : undefined;
      },
      30_000,
    );

    // Step 1 (tool call) → rejected step 2 → retried step 2 with the identical
    // prompt (the read_file tool was NOT replayed) → tool-free continuation.
    expect(workerCalls).toHaveLength(4);
    const [step1, rejected, retried, continuation] = workerCalls as [
      InspectedCall,
      InspectedCall,
      InspectedCall,
      InspectedCall,
    ];
    expect(promptJson(step1)).not.toContain("workspaces");
    expect(promptJson(rejected)).toContain("workspaces");
    expect(promptJson(retried)).toBe(promptJson(rejected));
    expect(promptJson(continuation)).toContain("cut off by the output-token limit");
    expect(promptJson(continuation)).toContain("WORKER_PART_A");
    expect(continuation.options.tools ?? []).toHaveLength(0);

    await exitTuiAndWaitForDump(h, 30_000);
  }, 180_000);
});
