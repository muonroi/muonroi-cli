/**
 * tests/harness/ideal-local-subcommands.spec.ts
 *
 * `/ideal status` and `/ideal abort` are answered by the host, not the model.
 * Since b014c9b9 the orchestrator forwarded both to processMessage as a
 * "coordinate the user's /ideal status request" prompt (orchestrator.ts
 * runProductLoopV1), so status cost a model call and abort could only ask the
 * model to stop its workers.
 *
 *   1. `/ideal start` runs one coordination turn (one scripted model round).
 *   2. `/ideal status` renders the run without ANY new recorded model call.
 *   3. A running worker owned by the session (a real sleeper process) appears in
 *      status; `/ideal abort` kills it — the process exits and its record is
 *      cancelled — and confirms in the transcript, again with no model call.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { spawnHarness } from "./helpers.js";
import { loadDumpedRecordings } from "./recording.js";

const MODEL = "deepseek-v4-flash";
const COORDINATING = "IDEAL-COORDINATION-TURN-7d1e";
// Not starting with a reserved subcommand word ("ship", "status", …).
const GOAL = "build the tiny parser";
const JOB_ID = "quiet-amber-heron";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const textRound = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
];

function recordedCalls(dumpPath: string): number {
  if (!existsSync(dumpPath)) return 0;
  try {
    return loadDumpedRecordings(dumpPath).length;
  } catch (err) {
    // Rewritten atomically after every call; a torn read on Windows retries.
    console.warn(`[ideal-local-subcommands] dump not readable yet: ${(err as Error).message}`);
    return -1;
  }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; anything else (EPERM) still means it exists.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

it("/ideal status and /ideal abort run locally; abort stops the run's running worker", async () => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-ideal-local-"));
  const fixDir = join(home, "fix");
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({
      responses: [{ match: "*", text: COORDINATING }],
      model: { provider: "deepseek", modelId: MODEL, stream: [textRound(COORDINATING)] },
    }),
    "utf8",
  );
  const dumpPath = join(home, "calls.json");
  let sleeper: ChildProcess | undefined;
  const ctx = await spawnHarness({
    entry: resolve("tests/harness/fixtures/ideal-coordination-entry.ts"),
    cwd: home,
    fixturesDir: fixDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", MODEL, "--permission", "auto-edit"],
    env: {
      MUONROI_IDEAL_COORD_HOME: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      MUONROI_ROUTER_SUB_SESSION: "0",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_FLOW_ASSESSOR: "0",
      MUONROI_NO_SHELL_HOLD: "1",
    },
  });
  const { driver } = ctx;
  // The rendered screen: semantic entry names stop at 40 chars, the cell grid does not.
  const transcript = () => driver.render_visual();
  const submit = async (text: string) => {
    driver.type(text);
    expect(await until(() => driver.query("id=composer")?.value === text, 10_000)).toBe(true);
    driver.press("Enter");
  };
  try {
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 60_000 });
    const seeded = JSON.parse(readFileSync(join(home, "ideal-session.json"), "utf8")) as {
      sessionId: string;
      jobsDir: string;
    };

    // 1. start → exactly the coordination turn reaches the model.
    await submit(`/ideal ${GOAL}`);
    expect(await until(() => transcript().includes(COORDINATING), 60_000), transcript()).toBe(true);
    // The turn is over once the composer stops offering to queue a follow-up.
    expect(await until(() => !transcript().includes("Queue a follow-up"), 30_000), transcript()).toBe(true);
    expect(await until(() => recordedCalls(dumpPath) > 0, 15_000)).toBe(true);
    const callsAfterStart = recordedCalls(dumpPath);

    // A worker launched for the run: a real process, owned by this session,
    // started after `/ideal start` (the run's attribution rule).
    sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = sleeper.pid!;
    const jobPath = join(seeded.jobsDir, `${JOB_ID}.json`);
    writeFileSync(
      jobPath,
      JSON.stringify({
        id: JOB_ID,
        kind: "task",
        agent: "general",
        description: "Implement the tiny parser",
        prompt: "role: implementer; scope: src/parser.ts",
        writeScope: ["src/parser.ts"],
        model: MODEL,
        cwd: home,
        sandboxMode: "off",
        maxToolRounds: 4,
        maxTokens: 1000,
        status: "running",
        pid,
        startedAt: new Date().toISOString(),
        parentSessionId: seeded.sessionId,
        outputPath: join(seeded.jobsDir, `${JOB_ID}.md`),
      }),
    );

    // 2. status → rendered locally, worker listed, no model call.
    await submit("/ideal status");
    expect(
      await until(() => transcript().includes("/ideal status (local — no model call)"), 20_000),
      `${driver.render_text()}\n----\n${transcript()}\ncalls=${recordedCalls(dumpPath)} (after start ${callsAfterStart})`,
    ).toBe(true);
    expect(await until(() => transcript().includes(JOB_ID), 10_000), transcript()).toBe(true);
    expect(transcript()).toContain(`Goal: ${GOAL}`);

    // 3. abort → the worker process dies, its record is cancelled, transcript confirms.
    await submit("/ideal abort");
    expect(await until(() => transcript().includes(`Stopped 1 worker(s): ${JOB_ID}`), 20_000), transcript()).toBe(true);
    expect(await until(() => !isAlive(pid), 10_000), `sleeper ${pid} still alive after /ideal abort`).toBe(true);
    const record = JSON.parse(readFileSync(jobPath, "utf8")) as { status: string };
    expect(record.status).not.toBe("running");

    // The cancellation is delivered (recorded for the model) on the TUI's next
    // notification tick — gate on that real condition, then prove it did NOT
    // wake the model to "continue the task" the user just aborted.
    expect(
      await until(
        () => Boolean((JSON.parse(readFileSync(jobPath, "utf8")) as { notifiedAt?: string }).notifiedAt),
        15_000,
      ),
      "the cancelled worker's notice was never delivered",
    ).toBe(true);
    // A wake is started from the very tick that delivers the notice
    // (use-app-logic.tsx, 2 s notification interval), so a negative check needs
    // a window: one full extra tick. (`wait_for idle` cannot gate this — it
    // needs NEW activity, and a correct, quiet TUI produces none.)
    const names = () => driver.queryAll('id*="^msg-\\d+$"').map((n) => n.name ?? "");
    const woke = await until(() => names().some((n) => n.includes("background job")), 2_500);
    expect(woke, `a wake turn started: ${JSON.stringify(names())}`).toBe(false);
    // Neither status, abort nor the cancellation reached the model.
    expect(recordedCalls(dumpPath)).toBe(callsAfterStart);
  } finally {
    if (sleeper?.pid && isAlive(sleeper.pid)) sleeper.kill();
    ctx.proc.kill();
    ctx.cleanup();
    bestEffortRemoveSync(home, "tests/harness/ideal-local-subcommands.spec.ts");
  }
}, 240_000);
