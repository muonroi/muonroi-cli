/**
 * tests/harness/bash-output-get-tui.spec.ts
 *
 * Phase B Fix #2 E2E — verify the bash_output_get plumbing end-to-end via
 * the TUI agent harness:
 *
 *   1. Mock LLM emits a `bash` tool-call whose REAL execution produces
 *      output above the 32K MAX_TOOL_OUTPUT_CHARS cap.
 *   2. Tool registry truncates the visible result AND appends a footer
 *      `[bash_run_id: bash-1 — N chars cached; use bash_output_get ...]`.
 *      The full untruncated stdout sits in the bash-output-cache LRU.
 *   3. Mock LLM emits a second tool-call to `bash_output_get` with
 *      run_id="bash-1", mode="grep", pattern="MARKER-42" — proving that
 *      a cheap model CAN call the tool when guided to.
 *   4. Registry slices the cached stdout and returns just the matching
 *      lines. Mock LLM emits a final stop.
 *
 * Assertions over the dumped doStreamCalls:
 *   - At least 3 LLM calls (user → bash result → bash_output_get result → stop).
 *   - Call #2 input (the prompt sent after `bash` returned) contains the
 *     `bash_run_id: bash-` substring — proves the registry footer fired.
 *   - Call #3 input (sent after `bash_output_get` returned) contains the
 *     specific MARKER-42 line — proves the slice came from cache, not a
 *     re-run.
 *   - System prompt for the deepseek-fast model contains the
 *     CHEAP_MODEL_PLAYBOOK opening line — proves Bước 1 injection fires.
 *
 * The mock LLM does NOT autonomously "decide" to call bash_output_get.
 * What this spec verifies is the PLUMBING: when the model does call it,
 * everything works. A separate live-model session is needed to confirm
 * the playbook actually steers DeepSeek toward proactive use.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { loadDumpedRecordings } from "./recording.js";

let scriptPath = "";
let workDir = "";

/**
 * Build the bash command that prints ~150KB of deterministic output with a
 * MARKER-42 line at iter 42. Implemented via a temp JS file (not `node -e`)
 * to avoid cross-shell quoting issues — git-bash on Windows mangles nested
 * double/single quotes differently than POSIX bash, and one mangled call
 * crashes the tool loop before the assistant message commits, throwing off
 * the mock's round selection.
 */
function bigOutputCmd(): string {
  return `node ${scriptPath}`;
}

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

describe("Fix #2 TUI: bash_output_get serves cached stdout instead of re-running", () => {
  let handle: CostLeakHarness | null = null;

  beforeAll(async () => {
    // Other harness specs (b3/b4) lower the compaction thresholds via env to
    // exercise their compactors. Those env vars leak across specs (vitest
    // process is shared with fileParallelism:false). For THIS spec we need
    // the compactor OFF so the bash_run_id footer survives into the next
    // LLM prompt — set both thresholds well above our payload size.
    process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS = "1000000";
    process.env.MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS = "500000";
    process.env.MUONROI_CROSS_TURN_DEDUP = "0";
    workDir = mkdtempSync(join(tmpdir(), "muonroi-bog-"));
    scriptPath = join(workDir, "gen.js");
    // Use forward slashes in JS path even on Windows — Node accepts both.
    scriptPath = scriptPath.replace(/\\/g, "/");
    writeFileSync(
      scriptPath,
      // ~150 KB output: 3000 lines × ~50 chars, with iter=42 carrying MARKER-42.
      "for(let i=0;i<3000;i++)console.log('iter='+i+' filler='+'x'.repeat(40)+(i===42?' MARKER-42-hit':''));\n",
      "utf8",
    );

    handle = await spawnCostLeakHarness({
      provider: "siliconflow",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      stream: [
        // Round 0: ABSORBER for PIL Layer 1's classifier call (PIL fires
        // before the main agent and consumes one doStream from the queue).
        // Returning a JSON classification matches what the unified PIL
        // brain expects; PIL parses it, sets task_type, and routing
        // continues normally to the main agent. A plain-text response
        // (e.g. "debug") confuses the chitchat detector and short-circuits
        // the whole turn — verified empirically while wiring this spec.
        buildFinalTextRound('{"task_type":"debug","confidence":0.9}'),
        // Round 1: main-agent first turn → bash with big output.
        buildToolCallRound("bash-1", "bash", { command: bigOutputCmd() }),
        // Round 2: after bash returns, model picks bash_output_get with the
        // run_id the registry handed back. The mock fixture hard-codes
        // "bash-1" because BashTool's runId counter resets per process.
        buildToolCallRound("bog-1", "bash_output_get", {
          run_id: "bash-1",
          mode: "grep",
          pattern: "MARKER-42",
        }),
        // Round 3: final stop.
        buildFinalTextRound("done"),
      ],
    });
  }, 30_000);

  afterAll(() => {
    handle?.cleanup();
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("bash_run_id footer fires + bash_output_get returns cached slice", async () => {
    if (!handle) throw new Error("harness failed to spawn");

    // Non-chitchat phrasing so the orchestrator does NOT strip the tool set
    // (chitchat path: see src/orchestrator/orchestrator.ts isChitchat).
    // Verb-heavy + file-system / shell terms tip the heuristic away from
    // chit-chat.
    handle.driver.type(
      "please execute the bash command to enumerate iterations and inspect output for the marker line via the cache tool",
    );
    handle.driver.press("Enter");

    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });
    // 3 streamText rounds + 2 real tool executions (node -e 3000-iter loop is
    // a few hundred ms; bash_output_get is instant cache lookup). Generous
    // sleep so the dump is written before /exit.
    await new Promise((r) => setTimeout(r, 25_000));

    await exitTuiAndWaitForDump(handle, 20_000);

    const calls = loadDumpedRecordings(handle.dumpPath);

    // PIL Layer 1 runs its own classifier call before the main agent, so we
    // expect 4 dumped calls: [pil-classifier, agent#1 user-only, agent#2
    // after-bash, agent#3 after-bog]. Filter to main-agent calls (system
    // prompt starts with "You are muonroi-cli in Agent mode") to make the
    // spec robust to upstream PIL changes.
    const agentCalls = calls.filter((c) => {
      const p = c?.options?.prompt;
      if (!Array.isArray(p) || p.length === 0) return false;
      const sys = p[0];
      const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
      return sysText.includes("muonroi-cli in Agent mode");
    });
    expect(agentCalls.length).toBeGreaterThanOrEqual(3);

    // Agent call #2 (after bash returned) must carry the bash_run_id footer
    // — proves registry truncation footer fires when output > 32K cap.
    const after_bash = JSON.stringify(agentCalls[1]?.options?.prompt ?? {});
    expect(after_bash).toContain("bash_run_id: bash-");
    expect(after_bash).toContain("use bash_output_get");

    // Agent call #3 (after bash_output_get returned the grep slice) must
    // include MARKER-42 line — proves cache slice came back through to LLM.
    const after_bog = JSON.stringify(agentCalls[2]?.options?.prompt ?? {});
    expect(after_bog).toContain("MARKER-42-hit");
    // bash_output_get prepends a meta line `[bash-1 mode=grep ...]` so we
    // verify the slice came from cache (not a re-run of the bash command).
    expect(after_bog).toMatch(/\[bash-1 mode=grep/);

    // Verify the cheap-model playbook landed in the system prompt for fast
    // tier — Bước 1 (ad6ce6d) E2E confirmation. PIL's classifier has a
    // different system, so check agentCalls only.
    const agentSystems = agentCalls
      .map((c) => {
        const p = c?.options?.prompt;
        const sys = Array.isArray(p) && p[0] ? p[0] : null;
        return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
      })
      .join("\n");
    expect(agentSystems).toContain("BUDGET MODEL TOOL-USE PLAYBOOK");
  }, 90_000);
});
