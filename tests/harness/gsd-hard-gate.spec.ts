/**
 * tests/harness/gsd-hard-gate.spec.ts
 *
 * Task 11 — E2E for the GSD hard mutation gate (src/gsd/mutation-gate.ts),
 * end-to-end through the real TUI tool-execute wrapper in
 * src/orchestrator/tool-engine.ts that calls `evaluateMutationGate` before
 * every non-read-only tool call.
 *
 * Depth-forcing (the crux): the hard gate is HEAVY-only (standard/quick/null
 * fail open — see mutation-gate.ts). Seeding `.planning/STATE.md` Depth alone
 * does NOT survive: `syncWorkflowContext` rewrites Depth every turn, and
 * layer4-gsd derives depth = `modelDepthTier ?? "standard"` with the regex
 * scorer removed — so with the LLM classifier off, depth is ALWAYS "standard".
 * The only deterministic path to "heavy" in the mock harness is the leader-tier
 * complexity ASSESSOR: turn it on and script its call to return a heavy verdict.
 * The assessor's call is `createCouncilLLM.generate` → `mock.complete({prompt})`,
 * which matches the fixture `responses` array (NOT the doStream `model` fixture) —
 * so we match the assessor prompt's unique header and return a heavy
 * ComplexityVerdict. The assessor then OVERRIDES standard → heavy, writes it to
 * STATE.md AND pilCtx.modelDepthTier (the I1 writeback), and the gate reads heavy.
 *
 * Pattern: mock-model + dump (see bash-output-get-tui.spec.ts) — the mock emits
 * a `write_file` tool-call; we inspect the recorded agent rounds to see whether
 * the tool-result fed back contains the gate's BLOCKED directive, and check the
 * target file on disk as an independent signal (blocked ⇒ never written).
 *
 * Three cases: BLOCKED (heavy + plan + revise → write never runs), ALLOWED
 * (heavy + execute + pass → write runs), NOT GATED (standard → write runs even
 * under a would-block STATE, locking the heavy-only contract). Each `cwd` is a
 * FRESH throwaway temp dir (verify-in-temp-cwd rule). The quick fast-path is
 * unit-covered by mutation-gate.test.ts.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterEach, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";
import { loadDumpedRecordings } from "./recording.js";

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

/** Seed `.planning/STATE.md` (extension-table format expected by src/gsd/workflow-engine.ts readState). */
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
 * scripted for a classifier-absorber round + a write_file round + a final
 * stop round, and a dump path wired up so the parent can inspect
 * doStreamCalls after the turn.
 */
async function spawnGateHarness(
  workDir: string,
  toolCallInput: Record<string, unknown>,
  opts: { forceDepth?: "heavy" } = {},
): Promise<GateHarness> {
  const fixDir = join(workDir, "fix");
  mkdirSync(fixDir, { recursive: true });
  // When forcing heavy, drive it through the REAL pipeline: turn the leader-tier
  // complexity assessor ON and script its doGenerate call (createCouncilLLM.generate
  // -> generateText -> mock doGenerate) to return a heavy ComplexityVerdict. The
  // assessor then OVERRIDES the fast-classifier depth (always "standard" here, since
  // layer4-gsd.ts derives depth = modelDepthTier ?? "standard" and the LLM classifier
  // is off) up to heavy, writes it to STATE.md AND pilCtx.modelDepthTier, and the
  // mutation gate (heavy-only) reads heavy from STATE.md. Seeding STATE Depth alone is
  // NOT enough — syncWorkflowContext rewrites Depth every turn from the classifier.
  // The assessor's leader call is createCouncilLLM.generate → mock.complete({prompt}),
  // which matches against `responses` (NOT the doStream/doGenerate `model` fixture).
  // Match the assessor prompt's unique header and return a heavy ComplexityVerdict so
  // the assessor deterministically UPGRADES standard → heavy through the real pipeline.
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
        // NOTE: PIL's model-first classifier streamText call is now intercepted
        // by mock-model.ts (CLASSIFY_SIGNATURE) and returns a canned line WITHOUT
        // advancing the fixture cursor, so it no longer consumes a fixture round.
        // The old round-0 "absorber" was therefore orphaned and got mis-fed to the
        // main agent (a text-stop round → agent halted before the tool-call). The
        // main agent's first doStream must be the tool-call round directly.
        buildToolCallRound("wf-1", "write_file", toolCallInput),
        buildFinalTextRound("done"),
      ],
    },
  };
  writeFileSync(join(fixDir, "fixture.json"), JSON.stringify(fixture), "utf8");
  const dumpPath = join(workDir, "calls.json");

  const ctx = await spawnHarness({
    cwd: workDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--mock-llm", fixDir],
    env: {
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_NO_SHELL_HOLD: "1",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_GSD_NATIVE: "1",
      MUONROI_GSD_HARD_GATE: "1",
      // Assessor ON only when we need to force heavy (it's the only deterministic
      // path to a non-"standard" depth in the mock harness); OFF otherwise so a
      // standard-depth turn stays standard and proves the gate does NOT over-block.
      MUONROI_GSD_ASSESSOR: opts.forceDepth === "heavy" ? "1" : "0",
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

function isAgentCall(c: { options?: { prompt?: unknown } } | null | undefined): boolean {
  const p = c?.options?.prompt;
  if (!Array.isArray(p) || p.length === 0) return false;
  const sys = p[0] as { content?: unknown };
  const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
  return sysText.includes("muonroi-cli in Agent mode");
}

describe("GSD hard mutation gate — E2E via real TUI tool-execute wrapper", { retry: 0 }, () => {
  let handle: GateHarness | null = null;
  let workDir: string | undefined;

  afterEach(async () => {
    handle?.cleanup();
    handle = null;
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore — best-effort cleanup
      }
      workDir = undefined;
    }
  });

  it("BLOCKED: heavy depth + Phase=plan + PLAN-VERIFY revise → write_file never executes", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-gate-blocked-"));
    seedState(workDir, "plan", "heavy");
    seedPlanVerify(workDir, "revise");

    const targetFile = join(workDir, "gate-blocked.txt");
    handle = await spawnGateHarness(
      workDir,
      { file_path: "gate-blocked.txt", content: "hello from gate test" },
      { forceDepth: "heavy" },
    );

    handle.driver.type("please edit and write the file to add a new feature");
    handle.driver.press("Enter");
    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });

    // Poll the dump for at least 2 recorded main-agent rounds (tool-call +
    // the follow-up round fed the tool result).
    for (let i = 0; i < 200; i++) {
      if (existsSync(handle.dumpPath)) {
        try {
          if (loadDumpedRecordings(handle.dumpPath).filter(isAgentCall).length >= 2) break;
        } catch {
          // dump mid-rotation — atomic rename means the next read is clean
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    await exitAndWaitForDump(handle, 20_000);

    const agentCalls = loadDumpedRecordings(handle.dumpPath).filter(isAgentCall);
    expect(agentCalls.length).toBeGreaterThanOrEqual(2);

    const afterToolCall = JSON.stringify(agentCalls[1]?.options?.prompt ?? {});
    expect(afterToolCall).toContain("BLOCKED");
    expect(afterToolCall).toContain("gsd_plan_review");

    // Second, independent signal: the gate must have prevented the write.
    expect(existsSync(targetFile)).toBe(false);
  }, 120_000);

  it("ALLOWED: heavy depth + Phase=execute + PLAN-VERIFY pass → write_file executes", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-gate-allowed-"));
    seedState(workDir, "execute", "heavy");
    seedPlanVerify(workDir, "pass");

    const targetFile = join(workDir, "gate-allowed.txt");
    handle = await spawnGateHarness(
      workDir,
      { file_path: "gate-allowed.txt", content: "hello from gate test" },
      { forceDepth: "heavy" },
    );

    handle.driver.type("please edit and write the file to add a new feature");
    handle.driver.press("Enter");
    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });

    for (let i = 0; i < 200; i++) {
      if (existsSync(handle.dumpPath)) {
        try {
          if (loadDumpedRecordings(handle.dumpPath).filter(isAgentCall).length >= 2) break;
        } catch {
          // dump mid-rotation
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    await exitAndWaitForDump(handle, 20_000);

    const agentCalls = loadDumpedRecordings(handle.dumpPath).filter(isAgentCall);
    expect(agentCalls.length).toBeGreaterThanOrEqual(2);

    const afterToolCall = JSON.stringify(agentCalls[1]?.options?.prompt ?? {});
    expect(afterToolCall).not.toContain("BLOCKED: this task was assessed as non-trivial");

    expect(existsSync(targetFile)).toBe(true);
  }, 120_000);

  // NOT GATED: standard depth is advisory-only (the hard gate is HEAVY-only).
  // With the assessor OFF, depth stays "standard" (layer4-gsd derives
  // depth = modelDepthTier ?? "standard" and the LLM classifier is off), so even
  // with Phase=plan + PLAN-VERIFY=revise seeded — a state that WOULD block at
  // heavy — the gate must fail open and let write_file through. This locks the
  // heavy-only contract chosen after the plan-review: hard-blocking every
  // default-tier bash/edit until a plan-review pass over-reaches ("hard thì mọi
  // tier không tốt"). The quick fast-path is unit-covered by mutation-gate.test.ts.
  it("NOT GATED: standard depth → write_file executes even under a would-block STATE", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-gate-standard-"));
    seedState(workDir, "plan", "standard");
    seedPlanVerify(workDir, "revise");

    const targetFile = join(workDir, "gate-standard.txt");
    handle = await spawnGateHarness(workDir, {
      file_path: "gate-standard.txt",
      content: "hello from gate test",
    });

    handle.driver.type("please edit and write the file to add a new feature");
    handle.driver.press("Enter");
    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });

    for (let i = 0; i < 200; i++) {
      if (existsSync(handle.dumpPath)) {
        try {
          if (loadDumpedRecordings(handle.dumpPath).filter(isAgentCall).length >= 2) break;
        } catch {
          // dump mid-rotation
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    await exitAndWaitForDump(handle, 20_000);

    const agentCalls = loadDumpedRecordings(handle.dumpPath).filter(isAgentCall);
    expect(agentCalls.length).toBeGreaterThanOrEqual(2);

    const afterToolCall = JSON.stringify(agentCalls[1]?.options?.prompt ?? {});
    expect(afterToolCall).not.toContain("BLOCKED: this task was assessed as non-trivial");

    // The gate must NOT block standard depth — the write executes.
    expect(existsSync(targetFile)).toBe(true);
  }, 120_000);
});
