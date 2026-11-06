/**
 * tests/harness/push-test-gate.spec.ts
 *
 * E2E for the host-enforced push gate (src/tools/git-safety.ts checkPushGate,
 * wired in src/tools/registry.ts bash execute). It replaced the prompt rule
 * "never push on red — run the check, await its result, then push"
 * (AGENT_OPERATING_CONTRACT #8), so the proof must be behavioral: the real TUI
 * dispatches a real worker whose bash `git push` is refused until the
 * project's verify-recipe test gate has passed.
 *
 * Path: the TUI top-level agent is the orchestrator (no bash), so the main
 * agent dispatches `task` (agent=general, sharedExecution, background=false); the
 * worker — a separate process scripted by a `routes` entry keyed on its role
 * line — runs the bash calls. Every cwd is a FRESH temp git repo with a LOCAL
 * bare remote next to it; nothing is ever pushed anywhere real.
 *
 * Two cases:
 *   BLOCKED — worker runs `git push` with no test run → the tool result fed to
 *             its next round carries the refusal naming `npm run test`, and the
 *             bare remote has no branch.
 *   ALLOWED — worker runs `npm run test` (passes) then `git push` → the bare
 *             remote's branch equals the repo HEAD.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { spawnHarness } from "./helpers.js";
import { isMainAgentCall, loadDumpedRecordings, loadWorkerDumpedRecordings } from "./recording.js";

/** Role line of the general worker (src/orchestrator/prompts.ts buildSubagentPrompt). */
const WORKER_ROLE_LINE = "You are the General sub-agent";
const PUSH = "git push origin HEAD:refs/heads/main";
/** Opening of pushBlockedMessage behind the registry's BLOCKED prefix. */
const PUSH_REFUSAL = "BLOCKED (git-safety): refusing to run `git push`";

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function toolRound(callId: string, toolName: string, input: Record<string, unknown>): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: callId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(50, 20) },
  ];
}

function textRound(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "final" },
    { type: "text-delta", id: "final", delta: text },
    { type: "text-end", id: "final" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(60, 4) },
  ];
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

interface Fixture {
  root: string;
  repo: string;
  remote: string;
  fixDir: string;
  dumpPath: string;
}

/** Temp layout: <root>/repo (git, package.json test gate), <root>/remote.git (bare), <root>/fix, <root>/calls.json. */
function makeFixture(workerCalls: unknown[][]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "muonroi-push-gate-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const fixDir = join(root, "fix");
  mkdirSync(repo);
  mkdirSync(fixDir);
  git(root, "init", "-q", "--bare", remote);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "spec@example.com");
  git(repo, "config", "user.name", "spec");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "push-gate-spec", private: true, scripts: { test: "node test.js" } }, null, 2),
  );
  writeFileSync(join(repo, "test.js"), "console.log('1 passed'); process.exit(0);\n");
  git(repo, "add", "package.json", "test.js");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", remote);

  const fixture = {
    responses: [{ match: "*", text: "continue" }],
    model: {
      stream: [
        toolRound("task-1", "task", {
          agent: "general",
          description: "push the branch",
          prompt: "Push the current branch to origin as main using bash.",
          modelId: "deepseek-v4-flash",
          background: false,
          // The worker runs bash (git push); an unscoped shell-capable worker must
          // declare shared execution or the host refuses the dispatch (M9).
          sharedExecution: true,
        }),
        textRound("done"),
      ],
      routes: [{ systemIncludes: WORKER_ROLE_LINE, stream: [...workerCalls, textRound("finished")] }],
    },
  };
  writeFileSync(join(fixDir, "fixture.json"), JSON.stringify(fixture), "utf8");
  return { root, repo, remote, fixDir, dumpPath: join(root, "calls.json") };
}

interface Harness {
  driver: Driver;
  exit(): Promise<void>;
  cleanup(): void;
}

async function start(fx: Fixture): Promise<Harness> {
  const ctx = await spawnHarness({
    cwd: fx.repo,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--mock-llm", fx.fixDir, "--permission", "yolo"],
    env: {
      MUONROI_MOCK_MODEL_DUMP: fx.dumpPath,
      MUONROI_NO_SHELL_HOLD: "1",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_FLOW_ASSESSOR: "0",
      MUONROI_FLOW_HARD_GATE: "0",
      MUONROI_AUTO_COMMIT: "0",
      // The gate under test must not be pre-disabled by a developer's shell.
      MUONROI_ALLOW_PUSH_ON_RED: "",
    },
  });
  ctx.proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[child] ${chunk.toString("utf8")}`));
  await ctx.driver.wait_for({ idle: true, timeoutMs: 15_000 });
  await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  return {
    driver: ctx.driver,
    exit: async () => {
      ctx.driver.type("/exit");
      ctx.driver.press("Enter");
      await new Promise<void>((resolve) => {
        if (ctx.proc.exitCode !== null) return resolve();
        ctx.proc.once("exit", () => resolve());
        setTimeout(() => {
          try {
            ctx.proc.kill();
          } catch (err) {
            console.debug(`[push-test-gate spec] kill after exit timeout failed: ${(err as Error).message}`);
          }
          resolve();
        }, 20_000);
      });
    },
    cleanup: () => {
      try {
        ctx.proc.kill();
      } catch (err) {
        console.debug(`[push-test-gate spec] teardown kill failed: ${(err as Error).message}`);
      }
      ctx.cleanup?.();
    },
  };
}

/** Tool-result text the worker was fed for `callId`, across all its recorded rounds. */
function workerToolResult(dumpPath: string, callId: string): string {
  for (const call of loadWorkerDumpedRecordings(dumpPath)) {
    if (!call.systemText.includes(WORKER_ROLE_LINE)) continue;
    for (const msg of call.options.prompt ?? []) {
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content as Array<{ type: string; toolCallId?: string; output?: unknown }>)
        if (part.type === "tool-result" && part.toolCallId === callId) return JSON.stringify(part.output);
    }
  }
  return "";
}

/** Submit, wait for the main round fed the task result (host waited for the worker), exit. */
async function runTurn(h: Harness, fx: Fixture): Promise<void> {
  h.driver.type("push my branch");
  h.driver.press("Enter");
  for (let i = 0; i < 360; i++) {
    if (existsSync(fx.dumpPath)) {
      try {
        if (loadDumpedRecordings(fx.dumpPath).filter(isMainAgentCall).length >= 2) break;
      } catch (err) {
        console.debug(`[push-test-gate spec] dump not readable yet: ${(err as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await h.exit();
}

const remoteMain = (remote: string): string =>
  spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/main"], { cwd: remote, encoding: "utf8" }).stdout.trim();

describe("push test gate — E2E via a real worker's bash tool", { retry: 0 }, () => {
  let handle: Harness | null = null;
  let fx: Fixture | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
    if (fx) bestEffortRemoveSync(fx.root, "tests/harness/push-test-gate.spec.ts");
    fx = null;
  });

  it("BLOCKED: git push with no passing test run is refused and names the gate", async () => {
    fx = makeFixture([toolRound("push-1", "bash", { command: PUSH, timeout: 30_000 })]);
    handle = await start(fx);
    await runTurn(handle, fx);

    const result = workerToolResult(fx.dumpPath, "push-1");
    expect(result, `worker push result: ${result.slice(0, 600)}`).toContain(PUSH_REFUSAL);
    expect(result).toContain("npm run test");
    expect(remoteMain(fx.remote)).toBe("");
  }, 180_000);

  it("ALLOWED: after a passing `npm run test`, the same push lands on the bare remote", async () => {
    fx = makeFixture([
      toolRound("test-1", "bash", { command: "npm run test", timeout: 60_000 }),
      toolRound("push-1", "bash", { command: PUSH, timeout: 30_000 }),
    ]);
    handle = await start(fx);
    await runTurn(handle, fx);

    const testResult = workerToolResult(fx.dumpPath, "test-1");
    const pushResult = workerToolResult(fx.dumpPath, "push-1");
    const diag = `test: ${testResult.slice(0, 300)}\npush: ${pushResult.slice(0, 600)}`;
    expect(testResult, diag).toContain("1 passed");
    expect(pushResult, diag).not.toContain("BLOCKED");
    expect(remoteMain(fx.remote), diag).toBe(git(fx.repo, "rev-parse", "HEAD"));
  }, 180_000);
});
