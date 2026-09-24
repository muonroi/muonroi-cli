/**
 * The verify stage's budget must scale with the work it measures.
 *
 * MEASURED DEFECT. `sprint_stage verification` → `sprint_stage judgment`
 * durations from `interaction_logs`, four real runs of the same task:
 *
 *     run mttwpmu8ee5b   sprint1 186s   sprint2 230s
 *     run mtv9v1xu7615   sprint1 412s   sprint2 340s
 *     run mtw9mpjt1ce3   sprint1 464s   sprint2 600s  ← hit the flat cap
 *
 * The stage shells out to the project's own build/test recipe (`dotnet restore`
 * → `dotnet build` → `dotnet test` across ~36 assemblies), so its cost grows
 * with the amount of code the run has produced. The bound was a constant 600s.
 * A budget that is fixed while the work it measures grows monotonically
 * PUNISHES PROGRESS: the further a run gets, the likelier verify is killed.
 *
 * On sprint 2 of `mtw9mpjt1ce3` it fired on a sprint that had ALREADY SUCCEEDED
 * — every compile error fixed, `dotnet build` green with 0 errors — and the
 * sprint was recorded `verify: "ERROR"`. Both the criteria judge and the F5
 * goal-contradiction gate are gated on `verifyVerdict === "PASS"`, so across all
 * four runs `CriteriaMet` stayed 0 and the goal gate never executed once.
 *
 * The budget is now derived from this run's OWN measured verify baseline
 * (`captureVerifyFloorBaseline`, which runs the very same commands before any
 * sprint starts). On run `mttwpmu8ee5b` that capture was measured at 53,133ms
 * (`verify-floor.ts:87`, `phase-runner.ts:324` — the freeze detector logged
 * `event loop blocked for 53029ms` in the same second).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../../types/index.js";

vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));

import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { buildVerifyTimeoutMessage, computeVerifyBudget, runVerifyWithWatchdog } from "../sprint-runner.js";

/** The flat constant the verify stage used to be bounded by, in ms. */
const OLD_FLAT_BUDGET_MS = 600_000;

/** `captureVerifyFloorBaseline` on run `mttwpmu8ee5b`, verbatim from the log line. */
const MEASURED_BASELINE_MS = 53_133;

const RUN_ID = "mtw9mpjt1ce3";
const SPRINT_N = 2;

let flowDir: string;

/**
 * The baseline record this run would have written at start, at exactly the path
 * the floor already reads (`verifyBaselinePath(flowDir, runId)`).
 */
function seedBaseline(elapsedMs: number | undefined, runId = RUN_ID): void {
  const dir = join(flowDir, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "verify-baseline.json"),
    JSON.stringify({
      version: 1,
      runId,
      capturedAtUtc: new Date().toISOString(),
      cwd: flowDir,
      gitCommit: null,
      gitBranch: null,
      gitDirty: null,
      commands: { build: ["dotnet build"], test: ["dotnet test"] },
      buildOk: true,
      failingTests: [],
      results: [],
      unattributable: false,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    }),
    "utf8",
  );
}

/** A verify orchestration that settles after `ms` of (fake) time. */
function verifyTaking(ms: number, result: ToolResult = { success: true, output: "VERIFY_PASS\n" }): void {
  (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => new Promise<ToolResult>((resolve) => setTimeout(() => resolve(result), ms)),
  );
}

/** A verify orchestration that never settles — a genuine hang. */
function verifyHangingForever(onProgress?: (emit: (d: string) => void) => void): void {
  (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_agent: unknown, opts?: { onProgress?: (d: string) => void }) =>
      new Promise<ToolResult>(() => {
        if (opts?.onProgress) onProgress?.(opts.onProgress);
      }),
  );
}

const AGENT = {} as never;

/**
 * Block until the watchdog has actually armed, then let the fake clock move.
 *
 * The watchdog resolves its budget from the baseline record on disk (a dynamic
 * import plus a `readFile`) BEFORE arming its timer. Those are real macrotasks
 * that advancing a fake clock does not run, so a test that advances too early
 * skips past a timer that does not exist yet and then waits forever — which is
 * exactly what a fixed number of pump turns did here, intermittently: it was
 * long enough only once vitest had already transformed and cached the
 * dynamically imported module.
 *
 * So the wait is on a REAL condition instead of a guessed turn count. The
 * watchdog creates its timeout promise (arming the timer) before it calls
 * `runVerifyOrchestration`, so one recorded call proves the timer is live.
 * `setImmediate` is left un-faked (see `toFake`) to serve as the real-loop pump.
 */
async function untilWatchdogArmed(): Promise<void> {
  const mock = runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>;
  for (let i = 0; i < 5_000; i++) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("verify orchestration was never invoked — the watchdog never armed");
}

beforeAll(async () => {
  // Warm the modules `resolveVerifyBudget` pulls in via dynamic `import()`.
  // vitest's module loader cannot complete a FIRST-TIME transform while the
  // clock is faked, so without this the very first watchdog call never reaches
  // the point of arming its timer and the test waits forever — while later
  // tests in the same file pass, because the earlier attempts warmed the cache.
  // That asymmetry is what made this look like a flake rather than a fixture bug.
  await import("../verify-floor.js");
  await import("../verify-baseline.js");
});

beforeEach(() => {
  // Fake only what the watchdog schedules on. setImmediate stays real so
  // `untilWatchdogArmed` can pump genuine file I/O to completion.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  flowDir = mkdtempSync(join(tmpdir(), "verify-budget-flow-"));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(flowDir, { recursive: true, force: true });
});

describe("verify budget — derived from the run's own measured baseline", () => {
  it("does NOT abort a verify that runs past 600s but stays inside the derived budget (run mtw9mpjt1ce3, sprint 2)", async () => {
    seedBaseline(MEASURED_BASELINE_MS);
    // 700s: longer than the old flat cap that killed this sprint, and well
    // inside 53.133s × 20 = 1062.7s.
    verifyTaking(700_000);

    const p = runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { flowDir });
    await untilWatchdogArmed();
    await vi.advanceTimersByTimeAsync(OLD_FLAT_BUDGET_MS + 1_000);
    await vi.advanceTimersByTimeAsync(100_000);
    const res = await p;

    expect(res.error ?? "").not.toContain("verify-timeout");
    expect(res.success).toBe(true);
  });

  it("still aborts a genuinely hung verify, at the derived budget", async () => {
    seedBaseline(MEASURED_BASELINE_MS);
    verifyHangingForever();

    const p = runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { flowDir });
    await untilWatchdogArmed();
    // Still alive well past the old flat cap.
    await vi.advanceTimersByTimeAsync(700_000);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // 53.133s × 20 = 1_062_660ms.
    await vi.advanceTimersByTimeAsync(400_000);
    const res = await p;
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("verify-timeout");
  });

  it("falls back to the 600s floor when no baseline cost was recorded", async () => {
    seedBaseline(undefined);
    verifyHangingForever();

    const p = runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { flowDir });
    await untilWatchdogArmed();
    await vi.advanceTimersByTimeAsync(OLD_FLAT_BUDGET_MS + 1_000);
    // A stage that never settles uses the whole partial-report salvage grace
    // (`salvageAbortedVerifyOutput`, default 30s) before the caller is unblocked.
    await vi.advanceTimersByTimeAsync(31_000);
    const res = await p;
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("verify-timeout");
  });
});

describe("verify timeout message — measured facts only", () => {
  it("asserts no cause, and reports elapsed, the bound, and the activity observed", async () => {
    seedBaseline(MEASURED_BASELINE_MS);
    let emit: ((d: string) => void) | undefined;
    verifyHangingForever((e) => {
      emit = e;
    });

    const p = runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { flowDir });
    await untilWatchdogArmed();
    await vi.advanceTimersByTimeAsync(1_000);
    emit?.("Running verify sub-agent");
    await vi.advanceTimersByTimeAsync(1_200_000);
    const msg = (await p).error ?? "";

    // 1 — no cause is asserted. These are the exact guesses the old text made,
    // both of which were FALSE on the run that produced it: the sandbox was
    // fine and the build had already succeeded.
    expect(msg).not.toMatch(/likely/i);
    expect(msg).not.toMatch(/shuru/i);
    expect(msg).not.toMatch(/TTFB/i);
    expect(msg).not.toMatch(/hung sandbox/i);
    expect(msg).toContain("cause not diagnosed");

    // 2 — the measured facts ARE there.
    expect(msg).toMatch(/sprint 2/);
    expect(msg).toContain(RUN_ID);
    expect(msg).toMatch(/1062/); // the derived budget, in seconds
    expect(msg).toMatch(/53\.1/); // the baseline it was derived from
    expect(msg).toMatch(/Running verify sub-agent/); // the activity actually seen
  });

  it("names the floor, and does not invent a baseline it never had", async () => {
    const budget = computeVerifyBudget(null);
    const msg = buildVerifyTimeoutMessage({
      sprintN: 1,
      runId: RUN_ID,
      budget,
      elapsedMs: 600_000,
      observation: { events: 0, lastEventAtMs: null, lastDetail: null },
    });
    expect(msg).toContain("no verify baseline cost was recorded");
    expect(msg).toContain("observed 0 stage activity events");
    expect(msg).toContain("cause not diagnosed");
    expect(msg).not.toMatch(/likely|shuru|TTFB/i);
  });
});

describe("computeVerifyBudget — the clamp", () => {
  const OPTS = { multiplier: 20, floorMs: 600_000, ceilingMs: 3_600_000 };

  it("derives from the baseline when the product lands between floor and ceiling", () => {
    const b = computeVerifyBudget(MEASURED_BASELINE_MS, OPTS);
    expect(b.basis).toBe("baseline-derived");
    expect(b.budgetMs).toBe(53_133 * 20); // 1_062_660ms
    // The measured stage durations on this repo, as multiples of that baseline.
    expect(b.budgetMs).toBeGreaterThan(464_000); // largest uncensored observation
    expect(b.budgetMs).toBeGreaterThan(600_000); // the censored one's lower bound
  });

  it("never returns less than the floor — the bound that already shipped", () => {
    // A cheap repo: 2s to build and test. 2s x 20 = 40s would be a regression.
    const b = computeVerifyBudget(2_000, OPTS);
    expect(b.basis).toBe("floor");
    expect(b.budgetMs).toBe(600_000);
    expect(b.derivedMs).toBe(40_000);
  });

  it("caps at the ceiling so a pathological baseline cannot disarm the watchdog", () => {
    const b = computeVerifyBudget(600_000, OPTS); // a baseline that itself timed out
    expect(b.basis).toBe("ceiling");
    expect(b.budgetMs).toBe(3_600_000);
  });

  it("treats an absent or zero baseline as unknown, never as a zero budget", () => {
    for (const v of [null, 0, Number.NaN]) {
      const b = computeVerifyBudget(v as number | null, OPTS);
      expect(b.basis).toBe("no-baseline");
      expect(b.budgetMs).toBe(600_000);
      expect(b.baselineMs).toBeNull();
    }
  });

  it("lets the floor win a misconfigured ceiling below it", () => {
    const b = computeVerifyBudget(MEASURED_BASELINE_MS, { ...OPTS, ceilingMs: 60_000 });
    expect(b.budgetMs).toBeGreaterThanOrEqual(600_000);
  });
});

describe("the baseline records the cost the budget is derived from", () => {
  it("persists a real measured elapsedMs, and reads it back", async () => {
    const { captureVerifyFloorBaseline, readBaselineVerifyCostMs } = await import("../verify-floor.js");
    vi.useRealTimers(); // this one shells out for real

    const cwd = mkdtempSync(join(tmpdir(), "verify-budget-cwd-"));
    const baselinePath = join(flowDir, "baseline.json");
    const { baseline } = await captureVerifyFloorBaseline({
      cwd,
      runId: "run-elapsed",
      baselinePath,
      // A command that takes a measurable, non-zero amount of wall clock, so a
      // passing assertion cannot be satisfied by a hardcoded 0.
      commandsOverride: { build: ['node -e "setTimeout(()=>process.exit(0),150)"'], test: [] },
    });

    expect(baseline.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(readFileSync(baselinePath, "utf8")).toContain("elapsedMs");
    await expect(readBaselineVerifyCostMs(baselinePath, "run-elapsed")).resolves.toBe(baseline.elapsedMs);
    // Scope: another run's measurement is a different amount of code.
    await expect(readBaselineVerifyCostMs(baselinePath, "some-other-run")).resolves.toBeNull();

    rmSync(cwd, { recursive: true, force: true });
  }, 30_000);

  it("returns null for a record written before the field existed", async () => {
    const { readBaselineVerifyCostMs } = await import("../verify-floor.js");
    seedBaseline(undefined);
    const p = join(flowDir, "runs", RUN_ID, "verify-baseline.json");
    await expect(readBaselineVerifyCostMs(p, RUN_ID)).resolves.toBeNull();
  });
});
