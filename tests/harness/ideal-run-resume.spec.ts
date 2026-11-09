/**
 * tests/harness/ideal-run-resume.spec.ts
 *
 * The `/ideal` run record survives a CLI restart.
 *
 * `/ideal status` and `/ideal abort` answered from an in-memory field
 * (orchestrator.ts), so after a restart/resume they said "No /ideal run has been
 * started" while the run's workers kept running. The record is now saved with
 * the session (storage/transcript.ts persistIdealRun).
 *
 *   1. Process A: `/ideal start`, then a real worker (a sleeper process owned by
 *      the session) is recorded after it. Process A is killed.
 *   2. Process B resumes the SAME session. `/ideal status` shows the goal and the
 *      worker with no model call; its output (host-local) is still on screen
 *      after the next model turn, and that turn's prompt is the typed text, not
 *      the slash echo. `/ideal abort` kills the sleeper.
 *   3. Process C resumes again: the abort was durable — no run is reported.
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
const COORDINATING = "IDEAL-RESUME-COORDINATION-3c7a";
const AFTER_RESUME = "IDEAL-RESUME-AFTER-STATUS-91be";
const GOAL = "build the tiny parser";
const JOB_ID = "quiet-amber-heron";
const PROMPT = "now say the resume marker";

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

function writeFixture(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fixture.json"),
    JSON.stringify({
      responses: [{ match: "*", text }],
      model: { provider: "deepseek", modelId: MODEL, stream: [textRound(text)] },
    }),
    "utf8",
  );
}

function recordedCalls(dumpPath: string): number {
  if (!existsSync(dumpPath)) return 0;
  try {
    return loadDumpedRecordings(dumpPath).length;
  } catch (err) {
    // Rewritten atomically after every call; a torn read on Windows retries.
    console.warn(`[ideal-run-resume] dump not readable yet: ${(err as Error).message}`);
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

async function exited(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  await new Promise<void>((done) => {
    proc.once("exit", () => done());
    proc.kill();
    setTimeout(done, 10_000);
  });
}

it("/ideal status and /ideal abort find the run after the CLI restarts on the same session", async () => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-ideal-resume-"));
  let sleeper: ChildProcess | undefined;
  const boot = async (label: string, fixtureText: string, resumeSession?: string) => {
    const fixDir = join(home, `fix-${label}`);
    writeFixture(fixDir, fixtureText);
    const dumpPath = join(home, `calls-${label}.json`);
    const ctx = await spawnHarness({
      entry: resolve("tests/harness/fixtures/ideal-coordination-entry.ts"),
      cwd: home,
      fixturesDir: fixDir,
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", MODEL, "--permission", "auto-edit"],
      env: {
        MUONROI_IDEAL_COORD_HOME: home,
        ...(resumeSession ? { MUONROI_IDEAL_COORD_RESUME: resumeSession } : {}),
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
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 60_000 });
    const screen = () => ctx.driver.render_visual();
    const submit = async (text: string) => {
      ctx.driver.type(text);
      expect(await until(() => ctx.driver.query("id=composer")?.value === text, 10_000)).toBe(true);
      ctx.driver.press("Enter");
    };
    return { ctx, screen, submit, dumpPath };
  };

  try {
    // 1. Process A starts the run and a worker belonging to it.
    const a = await boot("a", COORDINATING);
    const seeded = JSON.parse(readFileSync(join(home, "ideal-session.json"), "utf8")) as {
      sessionId: string;
      jobsDir: string;
    };
    await a.submit(`/ideal ${GOAL}`);
    expect(await until(() => a.screen().includes(COORDINATING), 60_000), a.screen()).toBe(true);
    expect(await until(() => !a.screen().includes("Queue a follow-up"), 30_000), a.screen()).toBe(true);

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
    // The CLI goes away; the worker (its own process) keeps running.
    await exited(a.ctx.proc);
    a.ctx.cleanup();
    expect(isAlive(pid), "the worker must outlive the CLI restart").toBe(true);

    // 2. Process B resumes the same session.
    const b = await boot("b", AFTER_RESUME, seeded.sessionId);
    await b.submit("/ideal status");
    expect(
      await until(() => b.screen().includes("/ideal status (local — no model call)"), 30_000),
      `status never rendered after resume:\n${b.screen()}`,
    ).toBe(true);
    expect(b.screen(), "the resumed session lost its run record").toContain(`Goal: ${GOAL}`);
    expect(await until(() => b.screen().includes(JOB_ID), 10_000), b.screen()).toBe(true);
    expect(recordedCalls(b.dumpPath), "status must not reach the model").toBe(0);

    // The status output is host-local: a model turn must neither delete it nor
    // send it to the model, and the turn's user entry must stay the typed text.
    await b.submit(PROMPT);
    expect(await until(() => b.screen().includes(AFTER_RESUME), 60_000), b.screen()).toBe(true);
    expect(await until(() => !b.screen().includes("Queue a follow-up"), 30_000), b.screen()).toBe(true);
    const afterTurn = b.screen();
    expect(afterTurn, "status output vanished at the end of the model turn").toContain(`Goal: ${GOAL}`);
    expect(afterTurn).toContain(PROMPT);
    expect(await until(() => recordedCalls(b.dumpPath) > 0, 15_000)).toBe(true);
    for (const call of loadDumpedRecordings(b.dumpPath)) {
      expect(`${call.systemText}\n${call.userText}\n${call.assistantText}`).not.toContain(
        "/ideal status (local — no model call)",
      );
    }

    await b.submit("/ideal abort");
    expect(await until(() => b.screen().includes(`Stopped 1 worker(s): ${JOB_ID}`), 30_000), b.screen()).toBe(true);
    expect(await until(() => !isAlive(pid), 10_000), `worker ${pid} still alive after /ideal abort`).toBe(true);
    expect((JSON.parse(readFileSync(jobPath, "utf8")) as { status: string }).status).not.toBe("running");
    await exited(b.ctx.proc);
    b.ctx.cleanup();

    // 3. The abort is durable across another restart.
    const c = await boot("c", AFTER_RESUME, seeded.sessionId);
    await c.submit("/ideal status");
    expect(
      await until(() => c.screen().includes("No /ideal run has been started in this session."), 30_000),
      c.screen(),
    ).toBe(true);
    await exited(c.ctx.proc);
    c.ctx.cleanup();
  } finally {
    if (sleeper?.pid && isAlive(sleeper.pid)) sleeper.kill();
    bestEffortRemoveSync(home, "tests/harness/ideal-run-resume.spec.ts");
  }
}, 420_000);
