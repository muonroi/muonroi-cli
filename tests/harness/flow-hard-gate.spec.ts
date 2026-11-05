/**
 * tests/harness/flow-hard-gate.spec.ts
 *
 * Task 11 — E2E for the FLOW hard mutation gate (src/workflow/mutation-gate.ts),
 * end-to-end through the real TUI tool-execute wrapper in
 * src/orchestrator/tool-engine.ts that calls `evaluateMutationGate` before
 * every non-read-only tool call.
 *
 * Depth-forcing (the crux): the hard gate is HEAVY-only (standard/quick/null
 * fail open — see mutation-gate.ts). Seeding `.planning/STATE.md` Depth alone
 * does NOT survive: `syncWorkflowContext` rewrites Depth every turn, and
 * layer4-flow derives depth = `modelDepthTier ?? "standard"` with the regex
 * scorer removed — so with the LLM classifier off, depth is ALWAYS "standard".
 * The only deterministic path to "heavy" in the mock harness is the leader-tier
 * complexity ASSESSOR: turn it on and script its call to return a heavy verdict.
 * The assessor's call is `createCouncilLLM.generate` → `mock.complete({prompt})`,
 * which matches the fixture `responses` array (NOT the doStream `model` fixture) —
 * so we match the assessor prompt's unique header and return a heavy
 * ComplexityVerdict. The assessor then OVERRIDES standard → heavy, writes it to
 * STATE.md AND pilCtx.modelDepthTier (the I1 writeback), and the gate reads heavy.
 *
 * Where the gate bites (orchestrator contract, b014c9b9): the TUI top-level
 * agent is the ORCHESTRATOR. Its tools are filtered to coordination +
 * read_file/grep (filterExecutionTools / ORCHESTRATION_TOOLS in
 * src/orchestrator/orchestration-policy.ts) — it has no write_file, so a
 * scripted top-level write_file is answered "Model tried to call unavailable
 * tool" and never reaches the gate. Its mutation-capable action is dispatching
 * a worker via `task`, and evaluateMutationGate (src/workflow/mutation-gate.ts)
 * gates exactly that at heavy depth with TASK_GATE_DIRECTIVE ("No worker was
 * started by this call"). So the main agent emits `task` (agent=general,
 * explicit modelId, writeScope=[target], background=false so the host waits);
 * when admitted, a background worker process — scripted through a `routes`
 * entry keyed on "You are the General sub-agent", because it loads the same
 * --mock-llm dir with a fresh cursor — performs the write_file.
 *
 * Pattern: mock-model + dump (see bash-output-get-tui.spec.ts). We inspect the
 * recorded main rounds to see whether the task result fed back contains the
 * gate's BLOCKED directive, the worker dump (`<calls>.worker-<pid>.json`) to see
 * whether a worker ran at all, and the target file on disk as an independent
 * signal (blocked ⇒ never written).
 *
 * Three cases: BLOCKED (heavy + plan + revise → no worker, no write), ALLOWED
 * (heavy + execute + pass → worker writes), NOT GATED (standard → worker writes
 * even under a would-block STATE, locking the heavy-only contract). Each `cwd`
 * is a FRESH throwaway temp dir (verify-in-temp-cwd rule). The quick fast-path
 * is unit-covered by mutation-gate.test.ts.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { spawnHarness } from "./helpers.js";
import { isMainAgentCall, loadDumpedRecordings, loadWorkerDumpedRecordings } from "./recording.js";

/** Role line of the general worker (src/orchestrator/prompts.ts buildSubagentPrompt). */
const WORKER_ROLE_LINE = "You are the General sub-agent";
const TARGET_CONTENT = "hello from gate test";
/** Opening of TASK_GATE_DIRECTIVE (src/workflow/mutation-gate.ts). */
const TASK_GATE_BLOCKED = "BLOCKED: FLOW refused dispatch of a mutation-capable worker";

interface GateHarness {
  proc: ChildProcess;
  driver: Driver;
  dumpPath: string;
  workDir: string;
  cleanup(): void;
}

function buildToolCallRound(callId: string, toolName: string, input: Record<string, unknown>): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: callId, toolName, input: JSON.stringify(input) },
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

/** Seed `.planning/STATE.md` (extension-table format expected by src/workflow/workflow-engine.ts readState). */
function seedState(cwd: string, phase: string, depth: string): void {
  const dir = join(cwd, ".planning");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "STATE.md"),
    `# STATE\n\n| Field | Value |\n|---|---|\n| Phase | ${phase} |\n| Depth | ${depth} |\n`,
    "utf8",
  );
}

function seedPlanVerify(cwd: string, verdict: string): void {
  const dir = join(cwd, ".planning");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PLAN-VERIFY.md"), `verdict: ${verdict}\n`, "utf8");
}

/**
 * Spawn the TUI in a fresh temp cwd (never repo root) with a mock model
 * scripted for a main `task` dispatch round + a final stop round, a worker
 * route (write_file + stop), and a dump path wired up so the parent can inspect
 * doStreamCalls after the turn.
 */
async function spawnGateHarness(
  workDir: string,
  targetFile: string,
  opts: { forceDepth?: "heavy" } = {},
): Promise<GateHarness> {
  const fixDir = join(workDir, "fix");
  mkdirSync(fixDir, { recursive: true });
  // When forcing heavy, drive it through the REAL pipeline: turn the leader-tier
  // complexity assessor ON and script its doGenerate call (createCouncilLLM.generate
  // -> generateText -> mock doGenerate) to return a heavy ComplexityVerdict. The
  // assessor then OVERRIDES the fast-classifier depth (always "standard" here, since
  // layer4-flow.ts derives depth = modelDepthTier ?? "standard" and the LLM classifier
  // is off) up to heavy, writes it to STATE.md AND pilCtx.modelDepthTier, and the
  // mutation gate (heavy-only) reads heavy from STATE.md. Seeding STATE Depth alone is
  // NOT enough — syncWorkflowContext rewrites Depth every turn from the classifier.
  // The assessor's leader call is createCouncilLLM.generate, which short-circuits
  // to `mock.complete({ prompt })` when --mock-llm is installed (src/council/llm.ts),
  // so it matches the `responses` fixture on the PROMPT — NOT the doStream/doGenerate
  // `model` fixture. `buildAssessorPrompt` opens with "You are the complexity
  // assessor …", and mock-llm's matcher is `prompt.includes(match)` with
  // non-wildcard entries tried first, so this entry wins over the `*` fallback.
  // `extractComplexityVerdict` accepts a bare {...}, so raw JSON is enough.
  const responses =
    opts.forceDepth === "heavy"
      ? [
          {
            match: "You are the complexity assessor",
            text: JSON.stringify({ depth: "heavy", autoCouncil: false, rationale: "e2e: forced heavy" }),
          },
          { match: "*", text: "continue" },
        ]
      : [{ match: "*", text: "continue" }];
  const fixture: Record<string, unknown> = {
    responses,
    model: {
      stream: [
        // NOTE: PIL's model-first classifier streamText call is intercepted by
        // mock-model.ts (CLASSIFY_SIGNATURE) and returns a canned line WITHOUT
        // advancing the fixture cursor, as are the title and compaction-proposer
        // calls — so the main agent's first doStream is this round directly.
        buildToolCallRound("task-1", "task", {
          agent: "general",
          description: "write the gate target file",
          prompt: `Create ${targetFile} in the workspace root containing exactly: ${TARGET_CONTENT}`,
          modelId: "deepseek-v4-flash",
          writeScope: [targetFile],
          background: false,
        }),
        buildFinalTextRound("done"),
      ],
      routes: [
        {
          // The worker process (only reached when the gate admits dispatch).
          systemIncludes: WORKER_ROLE_LINE,
          stream: [
            buildToolCallRound("wf-1", "write_file", { file_path: targetFile, content: TARGET_CONTENT }),
            buildFinalTextRound("written"),
          ],
        },
      ],
    },
  };
  writeFileSync(join(fixDir, "fixture.json"), JSON.stringify(fixture), "utf8");
  const dumpPath = join(workDir, "calls.json");

  const ctx = await spawnHarness({
    cwd: workDir,
    // auto-edit: the worker's write_file auto-approves (AUTO_EDIT_ALLOWED). In
    // safe mode every worker tool waits on owner approval
    // (src/orchestrator/worker-approval.ts), which is not what this spec tests.
    extraArgs: [
      "-k",
      "FAKE_KEY_FOR_TESTS",
      "-m",
      "deepseek-v4-flash",
      "--mock-llm",
      fixDir,
      "--permission",
      "auto-edit",
    ],
    env: {
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_NO_SHELL_HOLD: "1",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_FLOW_NATIVE: "1",
      MUONROI_FLOW_HARD_GATE: "1",
      // Assessor ON only when we need to force heavy (it's the only deterministic
      // path to a non-"standard" depth in the mock harness); OFF otherwise so a
      // standard-depth turn stays standard and proves the gate does NOT over-block.
      MUONROI_FLOW_ASSESSOR: opts.forceDepth === "heavy" ? "1" : "0",
    },
  });

  ctx.proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[child] ${chunk.toString("utf8")}`);
  });

  await ctx.driver.wait_for({ idle: true, timeoutMs: 15_000 });
  await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });

  return {
    proc: ctx.proc,
    driver: ctx.driver,
    dumpPath,
    workDir,
    cleanup: () => {
      try {
        ctx.proc.kill();
      } catch {
        // ignore — best-effort teardown
      }
      ctx.cleanup?.();
    },
  };
}

async function exitAndWaitForDump(handle: GateHarness, timeoutMs = 20_000): Promise<void> {
  handle.driver.type("/exit");
  handle.driver.press("Enter");
  await new Promise<void>((resolve) => {
    if (handle.proc.exitCode !== null) {
      resolve();
      return;
    }
    handle.proc.once("exit", () => resolve());
    setTimeout(() => {
      try {
        handle.proc.kill();
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
  });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && !existsSync(handle.dumpPath)) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

function systemTextOf(c: { options?: { prompt?: unknown } } | null | undefined): string {
  const p = c?.options?.prompt;
  if (!Array.isArray(p) || p.length === 0) return "";
  const sys = p[0] as { content?: unknown };
  return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
}

/**
 * The gate reads Depth from `.planning/STATE.md` (and the assessor writes
 * `.planning/ASSESSMENT.md`). When a gate assertion fails, the depth that was
 * ACTUALLY in effect is the first thing to look at — the assessor degrades to
 * priorDepth silently, and its console.error is swallowed by the TUI.
 */
function describePlanningState(cwd: string): string {
  const read = (name: string): string => {
    const f = join(cwd, ".planning", name);
    if (!existsSync(f)) return `  ${name}: (absent)`;
    return `  ${name}: ${readFileSync(f, "utf8").replace(/\s+/g, " ").slice(0, 200)}`;
  };
  return [read("STATE.md"), read("ASSESSMENT.md"), read("PLAN-VERIFY.md")].join("\n");
}

/**
 * `expected 1 to be >= 2` says nothing about WHY. Every call the mock served is
 * recorded, so name them: which ones were main rounds and what the others
 * actually were. Without this the only way to tell "the loop stopped early" from
 * "the main-call marker stopped matching" is to re-run with MUONROI_DEBUG_MOCK_MODEL=1.
 */
function describeCalls(calls: ReturnType<typeof loadDumpedRecordings>): string {
  if (calls.length === 0) return "(no calls recorded at all)";
  return calls
    .map((c, i) => {
      const sys = systemTextOf(c).replace(/\s+/g, " ").slice(0, 70);
      return `  [${i}] ${isMainAgentCall(c) ? "MAIN" : "other"} :: ${sys || "(no system message)"}`;
    })
    .join("\n");
}

interface GateTurn {
  allCalls: ReturnType<typeof loadDumpedRecordings>;
  mainCalls: ReturnType<typeof loadDumpedRecordings>;
  workerCalls: ReturnType<typeof loadDumpedRecordings>;
  /** Serialized prompt of main round 2 — the round fed the `task` result. */
  afterToolCall: string;
  /** Serialized tool-result part for the scripted `task-1` call (empty if absent). */
  taskResult: string;
}

/** The tool-result the host fed back for the scripted `task` call. */
function taskResultOf(call: ReturnType<typeof loadDumpedRecordings>[number] | undefined): string {
  for (const msg of call?.options.prompt ?? []) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "tool-result" && part.toolCallId === "task-1") return JSON.stringify(part.output);
    }
  }
  return "";
}

/** Submit the prompt, wait for main round 2 (fed the task result), exit, load dumps. */
async function runGateTurn(handle: GateHarness): Promise<GateTurn> {
  handle.driver.type("please edit and write the file to add a new feature");
  handle.driver.press("Enter");
  await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });

  // Poll the dump for at least 2 recorded main rounds (the task call + the
  // follow-up round fed its result). background=false makes the host wait for
  // an admitted worker, so round 2 exists only after the worker finished.
  for (let i = 0; i < 240; i++) {
    if (existsSync(handle.dumpPath)) {
      try {
        if (loadDumpedRecordings(handle.dumpPath).filter(isMainAgentCall).length >= 2) break;
      } catch (err) {
        // Dump mid-rotation — the atomic rename means the next read is clean.
        console.debug(`[flow-hard-gate spec] dump not readable yet: ${(err as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  await exitAndWaitForDump(handle, 20_000);

  const allCalls = loadDumpedRecordings(handle.dumpPath);
  const mainCalls = allCalls.filter(isMainAgentCall);
  const workerCalls = loadWorkerDumpedRecordings(handle.dumpPath).filter((c) =>
    c.systemText.includes(WORKER_ROLE_LINE),
  );
  expect(
    mainCalls.length,
    `recorded calls:
${describeCalls(allCalls)}`,
  ).toBeGreaterThanOrEqual(2);
  return {
    allCalls,
    mainCalls,
    workerCalls,
    afterToolCall: JSON.stringify(mainCalls[1]?.options?.prompt ?? {}),
    taskResult: taskResultOf(mainCalls[1]),
  };
}

/** Assert the admitted path: worker dispatched, ran write_file, file on disk. */
function expectWorkerWrote(turn: GateTurn, targetFile: string): void {
  const diag = `worker rounds: ${turn.workerCalls.length}
  task result: ${turn.taskResult.slice(0, 700)}
  round2 tail: ${turn.afterToolCall.slice(-700)}`;
  expect(turn.taskResult, diag).not.toBe("");
  expect(turn.taskResult, diag).not.toContain("BLOCKED");
  // The host waited for the worker and reported it complete.
  expect(turn.taskResult, diag).toContain("Execution: complete");
  // The worker really ran: its second round was fed the write_file result.
  expect(turn.workerCalls.length, diag).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(turn.workerCalls[1]?.options.prompt ?? {}), diag).toContain('"toolName":"write_file"');
  // Independent signal: the write landed.
  expect(existsSync(targetFile)).toBe(true);
  expect(readFileSync(targetFile, "utf8")).toBe(TARGET_CONTENT);
}

describe("FLOW hard mutation gate — E2E via real TUI tool-execute wrapper", { retry: 0 }, () => {
  let handle: GateHarness | null = null;
  let workDir: string | undefined;

  afterEach(async () => {
    handle?.cleanup();
    handle = null;
    if (workDir) {
      bestEffortRemoveSync(workDir, "tests/harness/flow-hard-gate.spec.ts");
      workDir = undefined;
    }
  });

  it("BLOCKED: heavy depth + Phase=plan + PLAN-VERIFY revise → no worker dispatched, nothing written", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-gate-blocked-"));
    seedState(workDir, "plan", "heavy");
    seedPlanVerify(workDir, "revise");

    const targetFile = join(workDir, "gate-blocked.txt");
    handle = await spawnGateHarness(workDir, "gate-blocked.txt", { forceDepth: "heavy" });

    const turn = await runGateTurn(handle);
    expect(
      turn.taskResult,
      `planning state:
${describePlanningState(workDir!)}
  target written: ${existsSync(targetFile)}
  worker rounds: ${turn.workerCalls.length}
  round2 tail: ${turn.afterToolCall.slice(-700)}`,
    ).toContain(TASK_GATE_BLOCKED);
    // The directive tells the model the dispatch did not happen and where to look.
    expect(turn.taskResult).toContain("No worker was started by this call");
    expect(turn.taskResult).toContain("flow_status");

    // Independent signals: no worker process ever called the model, and the
    // write never happened.
    expect(turn.workerCalls.length).toBe(0);
    expect(existsSync(targetFile)).toBe(false);
  }, 120_000);

  it("ALLOWED: heavy depth + Phase=execute + PLAN-VERIFY pass → worker dispatched and writes", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-gate-allowed-"));
    seedState(workDir, "execute", "heavy");
    seedPlanVerify(workDir, "pass");

    const targetFile = join(workDir, "gate-allowed.txt");
    handle = await spawnGateHarness(workDir, "gate-allowed.txt", { forceDepth: "heavy" });

    const turn = await runGateTurn(handle);
    expectWorkerWrote(turn, targetFile);
  }, 120_000);

  // NOT GATED: standard depth is advisory-only (the hard gate is HEAVY-only).
  // With the assessor OFF, depth stays "standard" (layer4-flow derives
  // depth = modelDepthTier ?? "standard" and the LLM classifier is off), so even
  // with Phase=plan + PLAN-VERIFY=revise seeded — a state that WOULD block at
  // heavy — the gate must fail open and let the worker dispatch through. This
  // locks the heavy-only contract chosen after the plan-review: hard-blocking
  // every default-tier bash/edit until a plan-review pass over-reaches ("hard
  // thì mọi tier không tốt"). The quick fast-path is unit-covered by
  // mutation-gate.test.ts.
  it("NOT GATED: standard depth → worker dispatched and writes even under a would-block STATE", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-gate-standard-"));
    seedState(workDir, "plan", "standard");
    seedPlanVerify(workDir, "revise");

    const targetFile = join(workDir, "gate-standard.txt");
    handle = await spawnGateHarness(workDir, "gate-standard.txt");

    const turn = await runGateTurn(handle);
    expectWorkerWrote(turn, targetFile);
  }, 120_000);
});
