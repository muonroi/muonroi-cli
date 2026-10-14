import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePhasePlan } from "../phase-plan.js";
import { runPhases } from "../phase-runner.js";
import { captureVerifyFloorBaseline, type FloorProgress, runFloorCommand } from "../verify-floor.js";

/**
 * F6 — capturing the verify floor's baseline froze the whole UI.
 *
 * Measured, run `mttwpmu8ee5b`, within the same second:
 *
 *     [freeze] event loop blocked for 53029ms — UI was frozen and no timer could fire
 *     [verify-floor] baseline captured … elapsedMs: 53133
 *
 * 100ms apart, because `runFloorCommand` shelled out with `spawnSync`. A user
 * watching that sees a hang: no frame, no timer, no keystroke, for a minute.
 *
 * These tests measure the property directly — whether a timer can fire while a
 * gate command runs — rather than asserting on an implementation detail. A
 * regression to any blocking runner fails them regardless of how it is spelled.
 */

/**
 * Counts timer ticks over the lifetime of `work`. On a blocked event loop the
 * count is 0 no matter how long `work` takes: the timer physically cannot fire.
 */
async function ticksDuring<T>(work: () => Promise<T>, everyMs = 25): Promise<{ ticks: number; value: T }> {
  let ticks = 0;
  const t = setInterval(() => {
    ticks += 1;
  }, everyMs);
  try {
    const value = await work();
    return { ticks, value };
  } finally {
    clearInterval(t);
  }
}

/** A command that takes visibly longer than the tick interval, on any platform. */
const SLOW_OK = 'node -e "setTimeout(()=>process.exit(0), 700)"';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "floor-nonblock-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("runFloorCommand — the event loop stays free while a gate runs", () => {
  it("timers keep firing for the whole duration of a slow gate command", async () => {
    const { ticks, value } = await ticksDuring(() => runFloorCommand("build", SLOW_OK, cwd, 30_000));

    expect(value.exitCode).toBe(0);
    expect(value.ok).toBe(true);
    expect(value.elapsedMs).toBeGreaterThanOrEqual(500);
    // With spawnSync this is exactly 0. Well under the ~28 a 700ms command at a
    // 25ms interval would produce, so the assertion is not timing-sensitive.
    expect(ticks).toBeGreaterThan(3);
  }, 30_000);

  it("still captures output and honours a timeout without blocking", async () => {
    const chatty = "node -e \"console.log('hello-from-gate'); process.exit(3)\"";
    const check = await runFloorCommand("build", chatty, cwd, 30_000);
    expect(check.exitCode).toBe(3);
    expect(check.ok).toBe(false);
    expect(check.outputTail).toContain("hello-from-gate");

    const { ticks, value } = await ticksDuring(() =>
      runFloorCommand("build", 'node -e "setTimeout(()=>process.exit(0), 10000)"', cwd, 600),
    );
    expect(value.timedOut).toBe(true);
    expect(value.ok).toBe(false);
    expect(ticks).toBeGreaterThan(3);
  }, 30_000);
});

describe("captureVerifyFloorBaseline — reports progress per command", () => {
  it("emits a start and a done beat for every discovered gate, and never blocks", async () => {
    const beats: FloorProgress[] = [];
    const { ticks, value } = await ticksDuring(() =>
      captureVerifyFloorBaseline({
        cwd,
        runId: "run-progress",
        baselinePath: path.join(cwd, "baseline.json"),
        timeoutMs: 30_000,
        commandsOverride: { build: [SLOW_OK], test: [] },
        onProgress: (p) => beats.push(p),
      }),
    );

    expect(value.baseline.buildOk).toBe(true);
    expect(beats.map((b) => b.phase)).toEqual(["start", "done"]);
    expect(beats[0]?.command).toBe(SLOW_OK);
    expect(beats[1]?.ok).toBe(true);
    expect(ticks).toBeGreaterThan(3);
  }, 30_000);
});

describe("phase-runner call site — the run SHOWS the capture instead of freezing on it", () => {
  let flowDir: string;
  let projectCwd: string;
  const runId = "cap";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `cap-${Math.random().toString(36).slice(2)}`);
    projectCwd = mkdtempSync(path.join(os.tmpdir(), "cap-cwd-"));
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    // A real project whose own build gate takes long enough to observe.
    writeFileSync(
      path.join(projectCwd, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: { typecheck: 'node -e "setTimeout(()=>process.exit(0), 700)"' },
      }),
      "utf8",
    );
    writeFileSync(path.join(projectCwd, "bun.lock"), "", "utf8");
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("streams baseline progress chunks and leaves timers able to fire", async () => {
    await writePhasePlan(flowDir, runId, {
      version: 1,
      generatedAt: "t",
      phases: [
        {
          id: "P1",
          name: "n",
          goal: "g",
          successCriteria: ["A"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.9 },
          dependsOn: [],
          maxSprints: 1,
        },
      ],
    });
    const sprintRunner = vi.fn(async function* () {
      yield { type: "info", content: "" };
      return { scoreBefore: 0, scoreAfter: 1, criteriaMet: 1, totalCriteria: 1 };
    });
    const args = {
      flowDir,
      runId,
      projectCwd,
      manifest: { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.9, createdAt: new Date() },
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A"], scope: "s", rawQA: [] },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify({ wentWell: ["w"], toImprove: ["i"], nextSprintFocus: "f" }),
          costUsd: 0,
        }),
      },
      leaderModelId: "m1",
      capUsd: 10,
      remainingUsd: async () => 5,
      awaitCustomerVerdict: async () => ({ verdict: "accept" as const }),
      suppressPush: true,
      backoffDelays: [1, 1, 1],
      sprintRunner,
    };

    const chunks: Array<Record<string, unknown>> = [];
    const { ticks } = await ticksDuring(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: runPhases takes the full loop arg shape
      const gen = runPhases(args as any);
      while (true) {
        const n = await gen.next();
        if (n.done) break;
        chunks.push(n.value as unknown as Record<string, unknown>);
      }
    });

    const text = chunks
      .filter((c) => c.type === "content")
      .map((c) => String(c.content ?? ""))
      .join("");
    // The user sees WHAT is running, not a still screen.
    expect(text).toContain("[verify-floor] baseline");
    expect(text).toContain("Baseline captured in");
    // …and a live timeline row rather than only a wall of text.
    const phaseIds = chunks
      .filter((c) => c.type === "council_phase")
      .map((c) => (c.councilPhase as { phaseId?: string } | undefined)?.phaseId);
    expect(phaseIds).toContain(`verify-floor-baseline:${runId}`);
    // The whole point: the loop was free the entire time.
    expect(ticks).toBeGreaterThan(3);
  }, 60_000);
});
