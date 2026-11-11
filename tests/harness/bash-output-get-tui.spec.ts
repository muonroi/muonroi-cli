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
 * Who runs bash: since b014c9b9 the TUI top-level agent is the ORCHESTRATOR,
 * whose tool set is filtered to coordination + read_file/grep
 * (filterExecutionTools / ORCHESTRATION_TOOLS in
 * src/orchestrator/orchestration-policy.ts) — it has no `bash` and no
 * `bash_output_get`. Shell work is delegated: the orchestrator dispatches a
 * `task` (agent=general, explicit modelId, background=false so the host waits)
 * and a background worker process runs the bash → bash_output_get loop. The
 * worker loads the same `--mock-llm` dir with a fresh cursor, so its rounds are
 * scripted as a `routes` entry keyed on its role line ("You are the General
 * sub-agent") and it dumps to `<calls>.worker-<pid>.json`
 * (resolveMockDumpPath, src/agent-harness/mock-model.ts).
 *
 * Assertions over the dumped WORKER doStreamCalls:
 *   - At least 3 worker LLM calls (prompt → bash result → bash_output_get
 *     result → stop).
 *   - Worker call #2 input (the prompt sent after `bash` returned) contains the
 *     `bash_run_id: bash-` substring — proves the registry footer fired.
 *   - Worker call #3 input (sent after `bash_output_get` returned) contains the
 *     specific MARKER-42 line — proves the slice came from cache, not a
 *     re-run.
 *   - System prompt for the deepseek-fast WORKER contains CHEAP_MODEL_PLAYBOOK
 *     verbatim, front-loaded after the [ENV] line — proves Bước 1 injection
 *     fires for the model that actually runs bash.
 * Plus, on the orchestrator side: the `task` result fed back to it reports the
 * worker's execution as complete.
 *
 * The mock LLM does NOT autonomously "decide" to call bash_output_get.
 * What this spec verifies is the PLUMBING: when the model does call it,
 * everything works. A separate live-model session is needed to confirm
 * the playbook actually steers DeepSeek toward proactive use.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { CHEAP_MODEL_PLAYBOOK } from "../../src/pil/cheap-model-playbook.js";
import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { isMainAgentCall, loadDumpedRecordings, loadWorkerDumpedRecordings } from "./recording.js";

let scriptPath = "";
let workDir = "";

/** Role line of the general worker (src/orchestrator/prompts.ts buildSubagentPrompt). */
const WORKER_ROLE_LINE = "You are the General sub-agent";

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
        // Orchestrator (unrouted calls). PIL's classifier, the session title and
        // the compaction proposer are intercepted by mock-model.ts without
        // advancing a cursor, so round 1 IS the orchestrator's first turn.
        stream: [
          // Round 1: delegate the shell work. background=false makes the host
          // wait for the worker (durable host wait) so its result returns
          // in-turn; the TUI default is a background receipt.
          buildToolCallRound("task-1", "task", {
            agent: "general",
            description: "inspect big command output",
            prompt: "Execute the generator script and find the MARKER-42 line in its cached output.",
            modelId: "deepseek-v4-flash",
            background: false,
            // Unscoped shell-capable worker: an explicit choice, refused when omitted
            // (workerWriteScopeRequiredError, src/orchestrator/orchestration-policy.ts).
            sharedExecution: true,
          }),
          // Round 2: the worker finished; close the turn.
          buildFinalTextRound("done"),
        ],
        routes: [
          {
            systemIncludes: WORKER_ROLE_LINE,
            stream: [
              // Worker round 1 → bash with big output.
              buildToolCallRound("bash-1", "bash", { command: bigOutputCmd() }),
              // Worker round 2: after bash returns, pick bash_output_get with the
              // run_id the registry handed back. Hard-coded "bash-1" because
              // BashTool's runId counter starts fresh in each worker process.
              buildToolCallRound("bog-1", "bash_output_get", {
                run_id: "bash-1",
                mode: "grep",
                pattern: "MARKER-42",
              }),
              // Worker round 3: final stop.
              buildFinalTextRound("found MARKER-42"),
            ],
          },
        ],
      },
      {
        // Every worker tool goes through toolNeedsApproval in its permission mode
        // (src/orchestrator/worker-approval.ts gateWorkerTools). Safe asks for
        // everything; auto-edit auto-approves non-dangerous bash but NOT
        // bash_output_get (absent from AUTO_EDIT_ALLOWED,
        // src/utils/permission-mode.ts), so the worker would park on an owner
        // approval card this spec never answers (measured: worker stopped after
        // round 2). This spec is about the output cache, not approval, so it
        // selects yolo — the mode that auto-approves every tool.
        permission: "yolo",
        // The orchestrator dispatches a worker; keep the FLOW gate independent of
        // the developer checkout's machine-local .planning/STATE.md.
        isolatedCwd: true,
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
      bestEffortRemoveSync(workDir, "tests/harness/bash-output-get-tui.spec.ts");
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
    // Wait for the rounds to actually be RECORDED before exiting. The H3 hook
    // (src/index.ts) rewrites the dump after every doStream call, so polling it
    // directly tracks round completion. The orchestrator's SECOND round is fed
    // the task result, which exists only after the worker finished all three of
    // its rounds (background=false waits). 110s budget (440×250ms): under
    // full-suite CPU contention the real-bash worker rounds are slow.
    for (let i = 0; i < 440; i++) {
      if (existsSync(handle.dumpPath)) {
        try {
          if (loadDumpedRecordings(handle.dumpPath).filter(isMainAgentCall).length >= 2) break;
        } catch (err) {
          // Dump mid-rotation — the atomic rename means the next read is clean.
          console.debug(`[bash-output-get spec] dump not readable yet: ${(err as Error).message}`);
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    await exitTuiAndWaitForDump(handle, 20_000);

    const mainCalls = loadDumpedRecordings(handle.dumpPath).filter(isMainAgentCall);
    const workerCalls = loadWorkerDumpedRecordings(handle.dumpPath).filter((c) =>
      c.systemText.includes(WORKER_ROLE_LINE),
    );
    const diagnose = () =>
      `main rounds=${mainCalls.length}, worker rounds=${workerCalls.length}; main round2 tail: ${JSON.stringify(
        mainCalls[1]?.options?.prompt ?? {},
      ).slice(-600)}`;

    // The orchestrator dispatched the worker and was told it completed.
    expect(mainCalls.length, diagnose()).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(mainCalls[1]?.options?.prompt ?? {}), diagnose()).toContain("Execution: complete");

    // Worker calls: [prompt, after-bash, after-bog].
    const agentCalls = workerCalls;
    expect(agentCalls.length, diagnose()).toBeGreaterThanOrEqual(3);

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
    // for the fast-tier WORKER (Bước 3-2 — prepend with CRITICAL marker). The
    // orchestrator runs on the provider's top-tier model and never runs bash,
    // so the worker is where the playbook must land.
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
    // Playbook content present verbatim. b014c9b9 rewrote rule 1 (the old
    // "This applies to EVERY bash call" line is gone), so pin the exported
    // constant rather than a phrase that drifts.
    expect(agentSystems[0]).toContain(CHEAP_MODEL_PLAYBOOK);
    expect(agentSystems[0]).toContain("bash_output_get");
  }, 180_000);
});
