/**
 * The verify watchdog must not read "a human is being asked" as silence, and a
 * stage it cuts must keep the work that stage had already done.
 *
 * MEASURED DEFECT — run `muc2joffe506`, sprint 2, parent session `1756b9775bef`,
 * verify sub-session `548913168ae0` (`~/.muonroi-cli/muonroi.db`):
 *
 *   14:42:34.453Z  last stage-activity beat, detail "Running verify sub-agent"
 *   14:50:21.922Z  tool_calls id 3558  tool_name 'ask_user'  (a blocking card)
 *   14:52:34/35Z   the 600s silence budget expired; stage aborted;
 *                  sprints/2-outcome.json → verify: "ERROR", score 0
 *   2026-09-24T01:14:10.012Z  that same tool_calls row completed — 10.5h later
 *
 * Two separate facts got merged into one. FIRST, `ask_user` brackets its wait with
 * `beginInteractivePause()` (orchestrator.ts:4319) exactly so watchdogs re-arm
 * instead of aborting; the per-attempt stall watchdog and the turn-idle watchdog
 * both consult `isInteractivePaused()` (orchestrator.ts:2594, :3871). The verify
 * SILENCE watchdog did not, so a stage blocked on a pending human and a stage that
 * died were the same observation to it. SECOND, the timeout branch resolved
 * `{success:false, output:"", error}` — throwing away the partial payload
 * `buildVerifyAgent.runTaskRequest` already returns on an aborted turn
 * (sprint-runner.ts:3844-3848). The stage had genuinely verified Docker up, all
 * services healthy and /api/health OK; `2-verify.md` recorded only the timeout.
 *
 * Fixture strings below are the real ones from `tool_calls.args_json` id 3558 and
 * from `sprints/2-verify.md`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../../types/index.js";

vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));

import {
  __resetInteractivePauseForTests,
  beginInteractivePause,
  endInteractivePause,
} from "../../orchestrator/interactive-pause.js";
import { runInIdealScope } from "../../utils/ideal-run-scope.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { computeVerifyBudget, runVerifyWithWatchdog } from "../sprint-runner.js";

const RUN_ID = "muc2joffe506";
const SPRINT_N = 2;

/** The floor the incident ran under: no baseline was recorded for that run. */
const BUDGET = computeVerifyBudget(null);
const BUDGET_MS = BUDGET.budgetMs;

/** Verbatim, `sprints/2-verify.md` — what the stage HAD established. */
const PARTIAL_REPORT = [
  "## Summary",
  "Phases 1-3 completed successfully (Docker stack up, all services healthy, /api/health OK).",
  "## Blockers",
  "Phase 4 browser QA could not run: `agent-browser` is not installed on this Windows host.",
  "sh: line 1: agent-browser: command not found",
].join("\n");

const AGENT = {} as never;

let flowDir: string;

/** A verify orchestration that never settles on its own — the incident's shape. */
function verifyGoesQuiet(onProgress?: (emit: (d: string) => void) => void): void {
  (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_agent: unknown, opts?: { onProgress?: (d: string) => void }) =>
      new Promise<ToolResult>(() => {
        if (opts?.onProgress) onProgress?.(opts.onProgress);
      }),
  );
}

/**
 * A verify orchestration that, when aborted, hands back the partial payload —
 * exactly what `buildVerifyAgent.runTaskRequest` does for a killed turn
 * (sprint-runner.ts:3844-3848).
 */
function verifyYieldsPartialOnAbort(): void {
  (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_agent: unknown, opts?: { abortSignal?: AbortSignal }) =>
      new Promise<ToolResult>((resolve) => {
        opts?.abortSignal?.addEventListener("abort", () => {
          resolve({
            success: false,
            output: PARTIAL_REPORT,
            error: "verify turn ended in failure: aborted",
          } as ToolResult);
        });
      }),
  );
}

/** Block until the watchdog has armed (see verify-budget-scaling.test.ts). */
async function untilWatchdogArmed(): Promise<void> {
  const mock = runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>;
  for (let i = 0; i < 5_000; i++) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("verify orchestration was never invoked — the watchdog never armed");
}

beforeAll(async () => {
  await import("../verify-floor.js");
  await import("../verify-baseline.js");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  flowDir = mkdtempSync(join(tmpdir(), "verify-pending-flow-"));
  mkdirSync(join(flowDir, "runs", RUN_ID), { recursive: true });
  // No `elapsedMs` — the incident's basis was "no-baseline" → the 600s floor.
  writeFileSync(
    join(flowDir, "runs", RUN_ID, "verify-baseline.json"),
    JSON.stringify({ version: 1, runId: RUN_ID, verdict: "PASS", failures: [] }),
    "utf8",
  );
  vi.clearAllMocks();
  __resetInteractivePauseForTests();
});

afterEach(() => {
  vi.useRealTimers();
  __resetInteractivePauseForTests();
  rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("verify silence budget — a pending human is not silence", () => {
  it("does NOT fire while a blocking card is open, and fires once it is answered", async () => {
    verifyGoesQuiet();
    const p = runInIdealScope(() => runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { budget: BUDGET }));
    await untilWatchdogArmed();

    // The card opens 8 minutes in — as `ask_user` did at 14:50:21, 467s after the
    // last beat at 14:42:34.
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    beginInteractivePause();

    // Three whole budgets pass with the human still reading.
    await vi.advanceTimersByTimeAsync(BUDGET_MS * 3);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // The human answers. The budget now runs from here, not from the stale beat.
    endInteractivePause();
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(BUDGET_MS + 30_000);
    const res = await p;
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("verify-timeout");
  }, 30_000);

  it("states in the abort message that a human question was open, and for how long", async () => {
    verifyGoesQuiet();
    const p = runInIdealScope(() => runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { budget: BUDGET }));
    await untilWatchdogArmed();

    // Open the card BEFORE the deadline and hold it OPEN across it — the shape of
    // the incident, where `ask_user` was still pending when the 600s bound came up.
    // The watchdog samples on re-arm, so this is the window in which the pause is
    // observable at all; it then polls while the card stays open.
    beginInteractivePause();
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 60_000);
    endInteractivePause();
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 60_000);

    const msg = (await p).error ?? "";
    expect(msg).toContain("this was a SILENCE budget, not a total");
    // The measurement, not a cause.
    expect(msg).toMatch(/human question was open for \d+\.\d+s of that window/i);
    expect(msg).toContain("the budget did not run while it was");
    expect(msg).toContain("cause not diagnosed");
  }, 30_000);
});

describe("verify timeout — the work the stage did must survive", () => {
  it("keeps the partial report in `output` instead of replacing it with an empty string", async () => {
    verifyYieldsPartialOnAbort();
    const p = runInIdealScope(() => runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { budget: BUDGET }));
    await untilWatchdogArmed();
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1_000);
    // Let the salvage grace window run.
    await vi.advanceTimersByTimeAsync(30_000);

    const res = await p;
    expect(res.success).toBe(false);
    expect(res.error ?? "").toContain("verify-timeout");
    // The three phases that genuinely passed are named.
    expect(res.output).toContain("Phases 1-3 completed successfully");
    expect(res.output).toContain("all services healthy");
    // And so is the phase that could not run, with its evidence.
    expect(res.output).toContain("Phase 4 browser QA could not run");
    expect(res.output).toContain("agent-browser: command not found");
  }, 30_000);

  it("says the salvage ITSELF timed out — never leaves an empty payload looking like the old behaviour", async () => {
    verifyGoesQuiet();
    const p = runInIdealScope(() => runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { budget: BUDGET }));
    await untilWatchdogArmed();
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1_000);
    await vi.advanceTimersByTimeAsync(60_000);

    const res = await p;
    expect(res.success).toBe(false);
    expect(res.output).toBe("");
    expect(res.error ?? "").toContain("verify-timeout");
    // The trap this closes: an empty `output` is byte-identical to the defect this
    // whole change fixed, so the artifact must say WHICH empty it is. "the aborted
    // stage did not answer within the grace" is a different fact from "the stage
    // answered and had nothing".
    expect(res.error ?? "").toMatch(/did not hand anything back within the \d+\.\d+s salvage grace/);
    expect(res.error ?? "").toMatch(/may still be running when this returned/i);
    // And it must NOT claim anything about the payload it never saw.
    expect(res.error ?? "").toMatch(/says NOTHING about what it had produced/);
  }, 30_000);

  it("distinguishes a stage that answered with an EMPTY payload from one that never answered", async () => {
    (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_agent: unknown, opts?: { abortSignal?: AbortSignal }) =>
        new Promise<ToolResult>((resolve) => {
          opts?.abortSignal?.addEventListener("abort", () => {
            // Settles promptly, but with nothing to show.
            resolve({ success: false, output: "   ", error: "verify turn ended in failure: aborted" } as ToolResult);
          });
        }),
    );
    const p = runInIdealScope(() => runVerifyWithWatchdog(AGENT, RUN_ID, SPRINT_N, { budget: BUDGET }));
    await untilWatchdogArmed();
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1_000);
    await vi.advanceTimersByTimeAsync(60_000);

    const res = await p;
    expect(res.output).toBe("");
    expect(res.error ?? "").toMatch(/answered the abort but had produced nothing/i);
    expect(res.error ?? "").not.toMatch(/salvage grace/);
  }, 30_000);
});
