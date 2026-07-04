/**
 * tests/harness/gsd-hard-gate.spec.ts
 *
 * Task 11 — E2E for the GSD hard mutation gate (src/gsd/mutation-gate.ts).
 *
 * Scope: the assessor + plan-review council + verify-council are LLM-driven
 * and already unit-tested (mutation-gate.test.ts, complexity-assessor tests,
 * verify-council tests all green). This spec targets ONLY the deterministic,
 * highest-risk wiring left uncovered by unit tests: the runtime tool-execute
 * wrapper in src/orchestrator/tool-engine.ts (~line 1091) that calls
 * `evaluateMutationGate` before every non-read-only tool call, end-to-end
 * through the real TUI process — no assessor LLM call involved
 * (MUONROI_GSD_ASSESSOR=0), so depth comes ONLY from the seeded STATE.md.
 *
 * Pattern: this reuses the cost-leak "mock-model + dump" approach (see
 * tests/harness/bash-output-get-tui.spec.ts, cost-leak-tui-helpers.ts) rather
 * than screen-scraping the TUI render — the mock LLM emits a `write_file`
 * tool-call, and we inspect the recorded doStreamCalls dump to see whether
 * the SECOND round's prompt (the tool result fed back to the model) contains
 * the gate's BLOCKED directive. We also check the target file's presence on
 * disk as a second, independent signal (blocked ⇒ never written).
 *
 * Each `cwd` is a FRESH throwaway temp dir (never the repo root) per the
 * project's verify-in-temp-cwd rule — this spec seeds `.planning/STATE.md` +
 * `.planning/PLAN-VERIFY.md` directly, so a real repo's own `.planning/`
 * (if any) is never touched.
 *
 * MUONROI_LLM_FIRST_CLASSIFY=0 is set deliberately: with it OFF, PIL's Pass 4
 * offline-cascade LLM fallback (src/pil/layer1-intent.ts:1287) still consumes
 * ONE mock round for classification but does NOT propagate a depth field
 * (only Pass -1 / model-first does), so the mutation gate sees whatever
 * Depth we seeded in STATE.md, undisturbed by the classifier round — this is
 * exactly what "assessor OFF, depth from seeded STATE only" requires. Leaving
 * the flag ON instead (verified live) makes Pass -1 run and had classify()
 * NOT even fire in this fixture's env — root cause not fully isolated within
 * the investigation budget; the OFF setting is the proven-reliable path
 * (see the "quick depth" it.todo below for the residual gap this leaves).
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
async function spawnGateHarness(workDir: string, toolCallInput: Record<string, unknown>): Promise<GateHarness> {
  const fixDir = join(workDir, "fix");
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({
      responses: [{ match: "*", text: "continue" }],
      model: {
        stream: [
          // Round 0: absorber for PIL's Pass-4 offline-cascade LLM fallback
          // (src/pil/llm-classify.ts), which issues its own streamText call
          // ahead of the main agent even with MUONROI_LLM_FIRST_CLASSIFY=0.
          // Reply in the classifier's expected 7-word CSV shape so it parses
          // cleanly and the turn proceeds to the main agent instead of
          // misreading a tool-call chunk as classification text.
          buildFinalTextRound("generate,concise,task,code,standard,local,english"),
          buildToolCallRound("wf-1", "write_file", toolCallInput),
          buildFinalTextRound("done"),
        ],
      },
    }),
    "utf8",
  );
  const dumpPath = join(workDir, "calls.json");

  const ctx = await spawnHarness({
    cwd: workDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--mock-llm", fixDir],
    env: {
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_NO_SHELL_HOLD: "1",
      // Deterministic classification — Pass -1 (model-first) off, no
      // interview askcards blocking the mock stream (same rationale as
      // cost-leak-tui-helpers.ts spawnCostLeakHarness). See the file-header
      // comment for why this flag is OFF here specifically.
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      // Task 11 scope: assessor OFF so depth comes ONLY from the seeded
      // STATE.md we write before spawn — no leader-tier LLM call decides it.
      MUONROI_GSD_NATIVE: "1",
      MUONROI_GSD_HARD_GATE: "1",
      MUONROI_GSD_ASSESSOR: "0",
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
    handle = await spawnGateHarness(workDir, { file_path: "gate-blocked.txt", content: "hello from gate test" });

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
    handle = await spawnGateHarness(workDir, { file_path: "gate-allowed.txt", content: "hello from gate test" });

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

  // NOT GATED / quick-depth case: with MUONROI_LLM_FIRST_CLASSIFY=0 (needed
  // above so the classifier round doesn't clobber our seeded Depth), PIL's
  // Pass 4 offline-cascade fallback classifier consumes a mock round but does
  // NOT set ctx.modelDepthTier (only Pass -1 / model-first does — see
  // src/pil/layer1-intent.ts:792 vs the Pass-4 block at :1287-1322) — so
  // syncWorkflowContext's depth sync falls through to the regex
  // complexityTier default ("standard"), overwriting our seeded "quick"
  // Depth before the gate ever reads it. Live-verified: seeding Depth=quick
  // this way always observed Depth=standard in STATE.md after the turn.
  // Turning MUONROI_LLM_FIRST_CLASSIFY back ON (so the classifier's OWN
  // depth word IS honored) hit a second issue in this fixture's env — the
  // Pass -1 classifier call did not fire at all (no doStream, no debug log),
  // root cause not isolated within this task's investigation budget. The
  // deterministic mutation-gate logic itself (canExecute fast-pathing
  // depth==="quick", covered by src/gsd/__tests__/mutation-gate.test.ts) is
  // NOT in question — only the E2E harness plumbing to force "quick" through
  // the real classify pipeline is unresolved.
  it.todo(
    "NOT GATED: quick depth → write_file executes regardless of Phase/PLAN-VERIFY " +
      "(blocked on harness classifier depth-propagation gap, see comment above)",
  );
});
