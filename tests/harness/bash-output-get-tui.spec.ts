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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { loadDumpedRecordings } from "./recording.js";

let scriptPath = "";
let workDir = "";

/**
 * True when a recorded doStream call is a MAIN-agent call (system prompt starts
 * with "You are muonroi-cli in Agent mode"), as opposed to PIL Layer 1's
 * classifier call. Shared by the completion poll and the final assertion.
 */
function isAgentCall(c: { options?: { prompt?: unknown } } | null | undefined): boolean {
  const p = c?.options?.prompt;
  if (!Array.isArray(p) || p.length === 0) return false;
  const sys = p[0] as { content?: unknown };
  const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
  return sysText.includes("muonroi-cli in Agent mode");
}

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

// retry:0 — this spec drives a SEQUENCE fixture (the mock advances a monotonic
// round index in the child, spawned once in beforeAll). A vitest retry re-runs
// the it() against the same child with the index already advanced, so a retry
// cannot reproduce the 3-round sequence — it would only confuse the result.
// Determinism instead comes from forcing EE unreachable in beforeAll (see the
// MUONROI_EE_BASE_URL env below), which pins the classifier's round consumption.
describe("Fix #2 TUI: bash_output_get serves cached stdout instead of re-running", { retry: 0 }, () => {
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
      // ~60 KB output: 1200 lines × ~50 chars — above the 32K truncation cap
      // (so the bash_run_id footer still fires) but ~2.5× lighter than 3000
      // lines. bash-output-get has TWO independent flake factors under CPU
      // contention: (1) classifier round-alignment — fixed by the EE-down env
      // above; (2) the real bash exec + 3 agentic rounds being slow. A lighter
      // payload makes each round faster so all 3 complete within the poll window.
      "for(let i=0;i<1200;i++)console.log('iter='+i+' filler='+'x'.repeat(40)+(i===42?' MARKER-42-hit':''));\n",
      "utf8",
    );

    handle = await spawnCostLeakHarness(
      {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
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
      },
      {
        // Force EE classification unreachable so PIL Layer-1 deterministically
        // falls back to the LLM (mock) classifier, which consumes the round-0
        // JSON absorber. Without this, the classifier's EE /api/classify call
        // non-deterministically succeeds (no mock doStream) → the MAIN agent eats
        // the absorber (finishReason=stop) → the turn ends after 1 round →
        // "expected 1 to be >= 3". Proven: 6/6 green with EE unreachable vs ~33%
        // flake without. ECONNREFUSED to 127.0.0.1:1 is instant (no boot delay).
        env: { MUONROI_EE_BASE_URL: "http://127.0.0.1:1" },
      },
    );
    // 120s (was 30s→90s): the harness spawn + handshake intermittently exceeded
    // the budget under CI load, surfacing as a beforeAll "Hook timed out" flake
    // unrelated to the assertions below. 120s matches the suite-wide standard
    // and sits above the 90s named-pipe handshake budget.
  }, 120_000);

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
    // Wait for the 3 main-agent rounds to actually be RECORDED before exiting.
    // The H3 hook (src/index.ts) rewrites the dump after every doStream call, so
    // polling it directly tracks round completion — the exact thing the
    // assertion below needs. This replaces a fixed 25s sleep that flaked under
    // full-suite load (the spawned child is CPU-starved, so the 3rd round had
    // not been recorded yet when the dump was taken). 110s budget (440×250ms):
    // under full-suite CPU contention the 3 real-bash rounds are slow (observed
    // only 2/3 rounds recorded at 72s with the old 70s window) — 110s plus the
    // lighter payload above give them room. (EE-down env removes the separate
    // 1-round abort; this window covers factor #2, the round slowness.)
    for (let i = 0; i < 440; i++) {
      if (existsSync(handle.dumpPath)) {
        try {
          if (loadDumpedRecordings(handle.dumpPath).filter(isAgentCall).length >= 3) break;
        } catch {
          // dump mid-rotation — atomic rename means the next read is clean
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    await exitTuiAndWaitForDump(handle, 20_000);

    const calls = loadDumpedRecordings(handle.dumpPath);

    // PIL Layer 1 runs its own classifier call before the main agent, so we
    // expect 4 dumped calls: [pil-classifier, agent#1 user-only, agent#2
    // after-bash, agent#3 after-bog]. Filter to main-agent calls to make the
    // spec robust to upstream PIL changes.
    const agentCalls = calls.filter(isAgentCall);
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

    // Verify the cheap-model playbook landed at the TOP of the system prompt
    // for fast tier (Bước 3-2 — prepend with CRITICAL marker). PIL's
    // classifier has a different system, so check agentCalls only.
    const agentSystems = agentCalls.map((c) => {
      const p = c?.options?.prompt;
      const sys = Array.isArray(p) && p[0] ? p[0] : null;
      return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
    });
    // Primacy assertion. A2 (PR #14) front-loads a one-line [ENV] shell
    // directive for fast-tier models AHEAD of the playbook, so the system
    // prompt now OPENS with "[ENV] …" immediately followed by the CRITICAL
    // playbook marker. Both are front-loaded; assert both, in order.
    expect(agentSystems[0]?.startsWith("[ENV]")).toBe(true);
    expect(agentSystems[0]).toContain("[CRITICAL TOOL-USE RULES");
    expect(agentSystems[0]?.indexOf("[ENV]")).toBeLessThan(
      agentSystems[0]?.indexOf("[CRITICAL TOOL-USE RULES") ?? Number.MAX_SAFE_INTEGER,
    );
    // Playbook content still present.
    const joined = agentSystems.join("\n");
    expect(joined).toContain("bash_output_get");
    expect(joined).toMatch(/EVERY bash call/);
  }, 180_000);
});
