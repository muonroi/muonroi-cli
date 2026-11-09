/**
 * tests/harness/ideal-autopilot.spec.ts
 *
 * `/ideal` is a long-running autonomous mode: the HOST starts the next turn.
 *
 * Evidence (session 55c5b65b6938): the work was done (545/545 tests) but the run
 * never closed — after every turn the host waited for a human "continue", and
 * the orchestrator had no `flow_verify` to satisfy the root-goal completion gate.
 *
 * Real orchestrator (the TUI main agent), scripted mock model, real host
 * autopilot (src/orchestrator/ideal-autopilot*.ts), real FLOW tools:
 *
 *   1. complete   — three turns: plan, flow_verify(pass), root_status=complete.
 *                   The human types ONE message; the host starts turns 2 and 3,
 *                   marks each in the transcript, and stops with
 *                   run-finished outcome=approved.
 *   2. no_progress — every turn ends with only text: the host stops by the
 *                   no-progress rule instead of looping.
 *   3. user wins  — the user types while an autopilot turn runs: the autopilot
 *                   yields, the typed message is answered, and no further
 *                   host turn starts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { ORCHESTRATOR_ROLE_PREFIX } from "../../src/orchestrator/orchestration-policy.js";
import { type HarnessContext, spawnHarness } from "./helpers.js";
import { loadDumpedRecordings } from "./recording.js";

const MODEL = "deepseek-v4-flash";
const CLASSIFY_QUICK = "generate, balanced, task, code, quick, local, english, clear";
const APPROVE_VERDICT = `\`\`\`council-verdict\n${JSON.stringify({
  verdict: "approve",
  concerns: [],
  evidence: ["VERIFY evidence names an executed 545/545 test run"],
  findings: [],
})}\n\`\`\``;

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const toolRound = (id: string, toolName: string, input: Record<string, unknown>) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(50, 20) },
];
const textRound = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(60, 4) },
];

const GOAL = "build the tiny parser";
const ledger = (extra: Record<string, unknown>) => ({
  topic: "working_set",
  action: "update",
  task_id: "tiny-parser",
  goal: "wave",
  ...extra,
});

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

type Run = {
  ctx: HarnessContext;
  work: string;
  dumpPath: string;
  seen: LiveEvent[];
  autopilot: () => Array<Extract<LiveEvent, { kind: "ideal-autopilot" }>>;
  finished: () => Extract<LiveEvent, { kind: "run-finished" }> | undefined;
  screen: () => string;
  /** Names of the transcript entries (semantic tree); long entries are cut at ~40 chars. */
  messageNames: () => string[];
  submit: (text: string) => Promise<void>;
  calls: () => ReturnType<typeof loadDumpedRecordings>;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function boot(
  stream: unknown[],
  opts: { chunkDelayMs?: number; env?: Record<string, string> } = {},
): Promise<Run> {
  const work = mkdtempSync(join(tmpdir(), "ideal-autopilot-"));
  // Harness artifacts live OUTSIDE the project cwd: the mock-call dump is rewritten on every
  // model call, which the autopilot would (correctly) count as a file change.
  const out = mkdtempSync(join(tmpdir(), "ideal-autopilot-out-"));
  const fixDir = join(out, "fix");
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({
      // Every council LLM call (the verify council at standard depth) answers "approve".
      responses: [{ match: "*", text: APPROVE_VERDICT }],
      classify: CLASSIFY_QUICK,
      ...(opts.chunkDelayMs ? { chunkDelayMs: opts.chunkDelayMs } : {}),
      model: {
        provider: "deepseek",
        modelId: MODEL,
        // The orchestrator's own calls follow the script; every other model call (the verify
        // council's participants and leader) must NOT consume a scripted round.
        routes: [{ systemIncludes: ORCHESTRATOR_ROLE_PREFIX, stream }],
        stream: [textRound(APPROVE_VERDICT)],
      },
    }),
    "utf8",
  );
  const dumpPath = join(out, "calls.json");
  const home = join(out, "home");
  mkdirSync(home, { recursive: true });
  const ctx = await spawnHarness({
    cwd: work,
    fixturesDir: fixDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", MODEL, "--permission", "auto-edit"],
    env: {
      // HOME apart from the project cwd (spawnHarness defaults them to the same dir): the
      // host writes session/cache files under HOME on every turn, which would read as
      // "files changed" in the project.
      HOME: home,
      USERPROFILE: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      MUONROI_FLOW_NATIVE: "1",
      MUONROI_FLOW_ASSESSOR: "0",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_ROUTER_SUB_SESSION: "0",
      MUONROI_NO_SHELL_HOLD: "1",
      ...(opts.env ?? {}),
    },
  });
  cleanups.push(() => {
    try {
      ctx.proc.kill();
    } catch (err) {
      console.error(`[ideal-autopilot.spec] kill failed: ${(err as Error).message}`);
    }
    ctx.cleanup();
    if (process.env.IDEAL_AUTOPILOT_SPEC_KEEP === "1") {
      console.info(`[ideal-autopilot.spec] artifacts kept: work=${work} out=${out}`);
      return;
    }
    bestEffortRemoveSync(work, "tests/harness/ideal-autopilot.spec.ts");
    bestEffortRemoveSync(out, "tests/harness/ideal-autopilot.spec.ts");
  });
  await ctx.driver.wait_for({ event: "input-ready", timeoutMs: 60_000 });
  await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });

  const seen: LiveEvent[] = [];
  void (async () => {
    for await (const e of ctx.driver.events(
      (e) => e.t === "event" && (e.kind === "ideal-autopilot" || e.kind === "run-finished"),
    ))
      seen.push(e);
  })();
  const screen = () => ctx.driver.render_visual();
  return {
    ctx,
    work,
    dumpPath,
    seen,
    autopilot: () =>
      seen.filter(
        (e): e is Extract<LiveEvent, { kind: "ideal-autopilot" }> => e.t === "event" && e.kind === "ideal-autopilot",
      ),
    finished: () =>
      seen.find((e): e is Extract<LiveEvent, { kind: "run-finished" }> => e.t === "event" && e.kind === "run-finished"),
    screen,
    messageNames: () => ctx.driver.queryAll('id*="^msg-\\d+$"').map((n) => n.name ?? ""),
    submit: async (text) => {
      ctx.driver.type(text);
      expect(await until(() => ctx.driver.query("id=composer")?.value === text, 10_000)).toBe(true);
      ctx.driver.press("Enter");
    },
    calls: () => (existsSync(dumpPath) ? loadDumpedRecordings(dumpPath) : []),
  };
}

const hostPromptCalls = (run: Run) => run.calls().filter((c) => c.userText.includes("[host: /ideal autopilot")).length;

describe("/ideal host autopilot", { retry: 0 }, () => {
  it("complete: one human message, the host drives plan → flow_verify → root complete and stops approved", async () => {
    const run = await boot([
      // Turn 1 (the human's `/ideal`): pin the root goal, write the plan, end the turn.
      toolRound(
        "t1-ledger",
        "context_load",
        ledger({ expected_revision: 0, root_goal: GOAL, open_items: ["parser", "verification"] }),
      ),
      toolRound("t1-plan", "flow_plan", { body: `# ${GOAL}\n1. Implement the parser\n## Acceptance\n- tests pass` }),
      textRound("AP-TURN-1-DONE"),
      // Turn 2 (host): record a passing verification with worker-style evidence.
      toolRound("t2-verify", "flow_verify", {
        passed: true,
        evidence: "worker quiet-amber-heron: 545/545 tests passed",
      }),
      textRound("AP-TURN-2-DONE"),
      // Turn 3 (host): the completion gate now accepts root_status=complete.
      toolRound(
        "t3-complete",
        "context_load",
        ledger({ expected_revision: 1, root_status: "complete", open_items: [] }),
      ),
      textRound("AP-TURN-3-DONE"),
    ]);

    await run.submit(`/ideal ${GOAL}`);
    await run.ctx.driver.wait_for({ event: "run-finished", timeoutMs: 240_000 });

    const finished = run.finished()!;
    expect(finished).toMatchObject({ outcome: "approved", success: true, reason: "complete" });
    const ap = run.autopilot();
    expect(ap.map((e) => e.action)).toEqual(["start", "continue", "continue", "stop"]);
    expect(ap.filter((e) => e.action === "continue").map((e) => e.turn)).toEqual([1, 2]);
    expect(ap.at(-1)?.reason).toBe("complete");

    // Evidence the gate was satisfied by the recorded verification, not by chance.
    const planning = [join(run.work, ".planning"), join(run.work, ".muonroi-flow", "planning")].find(existsSync)!;
    expect(readFileSync(join(planning, "VERIFY.md"), "utf8")).toMatch(/^verdict: pass$/m);

    // The user sees why turns 2 and 3 started (a visible host entry per turn), and that the run ended.
    expect(
      await until(() => run.screen().includes("/ideal autopilot stopped — root goal complete"), 20_000),
      run.screen(),
    ).toBe(true);
    const entries = run.messageNames();
    for (const n of [1, 2])
      expect(
        entries.some((e) => new RegExp(`/ideal autopilot.{1,4}turn ${n}/`).test(e)),
        JSON.stringify(entries),
      ).toBe(true);
    expect(run.screen()).toContain("AP-TURN-3-DONE");

    // Exactly the two host prompts reached the model, each a short instruction.
    expect(hostPromptCalls(run)).toBeGreaterThanOrEqual(2);
    for (const c of run.calls().filter((c) => c.userText.includes("[host: /ideal autopilot"))) {
      const line = c.userText.split("\n").find((l) => l.includes("[host: /ideal autopilot"))!;
      expect(line.length).toBeLessThan(400);
      expect(line).not.toMatch(/full authority|keep going/i);
    }
    // 3 turns, no extras: 7 scripted model rounds, and nothing after the stop.
    const callsAtStop = run.calls().length;
    await new Promise((r) => setTimeout(r, 6_000));
    expect(run.calls().length).toBe(callsAtStop);

    // /ideal status reports the stop reason (host-local, no model call).
    await run.submit("/ideal status");
    expect(await until(() => run.screen().includes("stopped (complete)"), 20_000), run.screen()).toBe(true);
    expect(run.calls().length).toBe(callsAtStop);
  }, 360_000);

  it("no_progress: turns that change nothing stop the run instead of looping", async () => {
    const run = await boot([textRound("NOTHING-CHANGED")], { env: { MUONROI_IDEAL_AUTOPILOT_NO_PROGRESS: "2" } });

    await run.submit(`/ideal ${GOAL}`);
    await run.ctx.driver.wait_for({ event: "run-finished", timeoutMs: 240_000 });

    const finished = run.finished()!;
    expect(finished).toMatchObject({ outcome: "halted", success: false, reason: "no_progress" });
    const continues = run.autopilot().filter((e) => e.action === "continue");
    expect(continues.length).toBeGreaterThanOrEqual(1);
    expect(continues.length).toBeLessThanOrEqual(3);
    expect(run.autopilot().at(-1)).toMatchObject({ action: "stop", reason: "no_progress" });
    expect(await until(() => run.screen().includes("no progress"), 20_000), run.screen()).toBe(true);

    // It really stopped: no host turn after the stop.
    const callsAtStop = run.calls().length;
    await new Promise((r) => setTimeout(r, 6_000));
    expect(run.calls().length).toBe(callsAtStop);
  }, 360_000);

  it("user wins: typing during an autopilot turn stops the autopilot and the message is answered", async () => {
    const run = await boot(
      [
        textRound("UW-TURN-1-DONE"),
        textRound("UW-TURN-2-DONE"),
        textRound("UW-ANSWER-TO-THE-USER"),
        textRound("UW-SHOULD-NOT-RUN"),
      ],
      // Slow chunks keep the host-started turn in flight long enough to type into it.
      { chunkDelayMs: 600, env: { MUONROI_IDEAL_AUTOPILOT_NO_PROGRESS: "9" } },
    );

    await run.submit(`/ideal ${GOAL}`);
    // The host started a turn on its own…
    await run.ctx.driver.wait_for({
      event: "ideal-autopilot",
      match: (e) => e.kind === "ideal-autopilot" && e.action === "continue",
      timeoutMs: 120_000,
    });
    // …and the user types while it runs.
    await run.submit("stop and tell me where you are");

    expect(await until(() => run.screen().includes("UW-ANSWER-TO-THE-USER"), 120_000), run.screen()).toBe(true);
    const stops = () => run.autopilot().filter((e) => e.action === "stop");
    expect(await until(() => stops().length > 0, 20_000)).toBe(true);
    expect(stops()[0]).toMatchObject({ reason: "user_message" });
    expect(run.finished()).toMatchObject({ outcome: "halted", reason: "user_message" });

    // No host turn after the user's: the call count settles at the answer.
    const callsAfterAnswer = run.calls().length;
    await new Promise((r) => setTimeout(r, 8_000));
    expect(run.calls().length).toBe(callsAfterAnswer);
    expect(run.screen()).not.toContain("UW-SHOULD-NOT-RUN");
    expect(run.autopilot().filter((e) => e.action === "continue")).toHaveLength(1);
  }, 360_000);
});
