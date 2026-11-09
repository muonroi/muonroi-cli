/**
 * tests/harness/auto-ack-delivery.spec.ts
 *
 * A result delivered to the orchestrator and processed by a completed model
 * turn must end up acknowledged (acknowledgedVersion === resultVersion), on
 * paths where the whole body is NOT in the notice. Replay c2fda568be6b left 10
 * of 33 jobs delivered-but-unacked, so working-context's outstanding-job
 * protection kept every turn that mentioned them in full (~830k tokens) and
 * compaction saved 0.
 *
 * Driven end-to-end through the real TUI with the mock LLM and the inline
 * completion fixture (a resumed main session with one dispatched worker whose
 * job record the spec finishes on disk, exactly as a worker process does):
 *
 * 1. A FAILED worker: the failure notice carries summary + error and only a
 *    pointer to the body, so it was never a "whole" delivery. It must be
 *    ACKed after the wake turn that started with it.
 * 2. A result bigger than the inline limit whose remainder the model never
 *    pages: not ACKed by the first turn, but the stale-delivery guard
 *    (STALE_DELIVERY_TURNS completed turns) acknowledges it. The count is
 *    persisted on the job record (deliveredTurnsSeen), so it is asserted turn
 *    by turn.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { completeDelegation, failDelegation, STALE_DELIVERY_TURNS } from "../../src/orchestrator/delegations.js";
import { spawnHarness } from "./helpers.js";

const MODEL = "deepseek-v4-flash";

function textRound(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    },
  ];
}

interface JobRecord {
  resultVersion?: string;
  deliveredVersion?: string;
  acknowledgedVersion?: string;
  deliveredTurnsSeen?: number;
}

const readJob = (jobPath: string): JobRecord => {
  try {
    return JSON.parse(readFileSync(jobPath, "utf8")) as JobRecord;
  } catch (err) {
    // The TUI rewrites the record under a lock; a torn read retries.
    console.warn(`[auto-ack-delivery] job record not readable yet: ${String(err)}`);
    return {};
  }
};

async function withFixture(
  name: string,
  rounds: string[],
  extraEnv: Record<string, string>,
  body: (ctx: {
    driver: Awaited<ReturnType<typeof spawnHarness>>["driver"];
    jobPath: string;
    dumpPath: string;
  }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), `muonroi-autoack-${name}-`));
  const fixDir = join(home, "fix");
  mkdirSync(fixDir, { recursive: true });
  const jobId = "brisk-teal-otter";
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({
      responses: [{ match: "*", text: rounds[0] }],
      model: { provider: "deepseek", modelId: MODEL, stream: rounds.map(textRound) },
    }),
    "utf8",
  );
  const dumpPath = join(home, "calls.json");
  const ctx = await spawnHarness({
    entry: resolve("tests/harness/fixtures/inline-completion-entry.ts"),
    cwd: home,
    fixturesDir: fixDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", MODEL],
    env: {
      MUONROI_INLINE_COMPLETION_HOME: home,
      MUONROI_INLINE_COMPLETION_JOB: jobId,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      MUONROI_ROUTER_SUB_SESSION: "0",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_FLOW_ASSESSOR: "0",
      MUONROI_NO_SHELL_HOLD: "1",
      ...extraEnv,
    },
  });
  try {
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 60_000 });
    expect(existsSync(join(home, "inline-session.json"))).toBe(true);
    const seeded = JSON.parse(readFileSync(join(home, "inline-session.json"), "utf8")) as { jobsDir: string };
    await body({ driver: ctx.driver, jobPath: join(seeded.jobsDir, `${jobId}.json`), dumpPath });
  } catch (err) {
    console.error(`auto-ack ${name}: ${err instanceof Error ? err.message : String(err)}\n${ctx.driver.render_text()}`);
    throw err;
  } finally {
    ctx.proc.kill();
    await new Promise<void>((resolveExit) => {
      if (ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) resolveExit();
      else ctx.proc.once("exit", () => resolveExit());
    });
    ctx.cleanup();
    bestEffortRemoveSync(home, "tests/harness/auto-ack-delivery.spec.ts");
  }
}

it("host-ACKs a FAILED worker's result after the wake turn that started with its notice", async () => {
  const REPLY = "AUTOACK-FAIL reconciled the failed worker";
  await withFixture("failed", [REPLY], {}, async ({ driver, jobPath }) => {
    await failDelegation(jobPath, "ENOENT: spawn dotnet failed (fixture)");
    await driver.wait_for({ visualText: REPLY, timeoutMs: 60_000 });
    await expect
      .poll(
        () => {
          const record = readJob(jobPath);
          return !!record.resultVersion && record.acknowledgedVersion === record.resultVersion;
        },
        { timeout: 30_000, interval: 250 },
      )
      .toBe(true);
    const record = readJob(jobPath);
    expect(record.deliveredVersion).toBe(record.resultVersion);
  });
}, 180_000);

it("acknowledges an oversize, never-paged result after STALE_DELIVERY_TURNS completed turns, not before", async () => {
  const replies = ["AUTOACK-BIG wake turn done", "AUTOACK-BIG second turn done", "AUTOACK-BIG third turn done"];
  expect(replies).toHaveLength(STALE_DELIVERY_TURNS);
  await withFixture(
    "oversize",
    replies,
    // Inline limit well under the result so the notice carries only the first part.
    { MUONROI_DELEGATION_INLINE_RESULT_CHARS: "300" },
    async ({ driver, jobPath }) => {
      await completeDelegation(jobPath, `Parser implemented at src/parser.ts:1-40.\n${"detail line\n".repeat(400)}`);
      await driver.wait_for({ visualText: replies[0]!, timeoutMs: 60_000 });
      // Turn 1 (the wake turn) saw the partial notice: counted, not yet ACKed.
      await expect.poll(() => readJob(jobPath).deliveredTurnsSeen, { timeout: 30_000, interval: 250 }).toBe(1);
      expect(readJob(jobPath).acknowledgedVersion).toBeUndefined();

      for (let turn = 2; turn <= STALE_DELIVERY_TURNS; turn++) {
        driver.type(`status check number ${turn}`);
        driver.press("Enter");
        await driver.wait_for({ visualText: replies[turn - 1]!, timeoutMs: 60_000 });
        if (turn < STALE_DELIVERY_TURNS) {
          await expect.poll(() => readJob(jobPath).deliveredTurnsSeen, { timeout: 30_000, interval: 250 }).toBe(turn);
          expect(readJob(jobPath).acknowledgedVersion).toBeUndefined();
        }
      }
      await expect
        .poll(
          () => {
            const record = readJob(jobPath);
            return !!record.resultVersion && record.acknowledgedVersion === record.resultVersion;
          },
          { timeout: 30_000, interval: 250 },
        )
        .toBe(true);
    },
  );
}, 240_000);
