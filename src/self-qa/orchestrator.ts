/**
 * orchestrator.ts — M2 of Self-QA.
 *
 * Spawns an inner muonroi-cli via the agent-harness, drives each Scenario
 * deterministically with the Driver API, and returns ScenarioRun[] that
 * the judge can score.
 *
 * Design notes:
 *   - The inner instance MUST run with --mock-llm so scenarios are reproducible
 *     and free. Real LLM verification is a future opt-in (set realLlm: true).
 *   - Each scenario gets a FRESH child. A shared child was cheaper but wrong:
 *     an agent-mode child stops responding after a handful of interactions and
 *     exits with code 0. `tests/harness/modal-focus-sweep.spec.ts:34-42`
 *     documents the same death at iteration 5 for a probe that opened no modal
 *     at all, so it is not modal-related, and that spec already spawns one
 *     child per case for this exact reason. Measured here 2026-09-05: two
 *     `/agents` open/close cycles succeeded and the third exited `code=0`.
 *     Because exit code 0 was indistinguishable from "still running" (the old
 *     guard was `code !== null && code !== 0`), every later scenario judged
 *     against a STALE final frame the dead child had left behind — a vacuous
 *     pass. Any premature exit now counts as a crash.
 *   - All event capture goes through driver.events() so the ring buffer's
 *     late-subscribe replay covers events emitted between spawn and subscribe.
 */

import { resolve } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { createDriver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { createLineSplitter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { spawnAgentTui } from "../agent-harness/test-spawn.js";
import type { Scenario, ScenarioRun, ScenarioStep } from "./types.js";

/** Cap on the retained stderr tail — enough for a stack trace, not a log dump. */
const STDERR_TAIL_CHARS = 4_000;

export type OrchestratorOptions = {
  /** Path to muonroi-cli entry file. Default: resolved src/index.ts of this repo. */
  entry?: string;
  /** Path to mock-llm fixture dir. Default: tests/harness/fixtures/llm. */
  mockLlmDir?: string;
  /** Extra CLI args appended after --agent-mode --mock-llm <dir>. */
  extraArgs?: string[];
  /** Env vars merged with process.env. */
  env?: Record<string, string>;
  /** Hard cap on total batch runtime. Default: 5 minutes. */
  batchBudgetMs?: number;
  /** Optional logger — receives short status strings. */
  log?: (msg: string) => void;
};

export async function runScenarios(scenarios: Scenario[], opts: OrchestratorOptions = {}): Promise<ScenarioRun[]> {
  const log = opts.log ?? (() => {});
  const entry = opts.entry ?? resolve("src/index.ts");
  const mockDir = opts.mockLlmDir ?? resolve("tests/harness/fixtures/llm");
  const batchBudget = opts.batchBudgetMs ?? 5 * 60_000;
  const batchStart = Date.now();

  if (scenarios.length === 0) {
    log("[self-qa] No scenarios to run");
    return [];
  }

  const args = [entry, "--agent-mode", "--mock-llm", mockDir, ...(opts.extraArgs ?? [])];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MUONROI_TEST_NO_PERSIST: "1",
    MUONROI_INTERNAL_SHIM_OK: "1",
    ...(opts.env ?? {}),
  };

  const runs: ScenarioRun[] = [];
  for (const scenario of scenarios) {
    if (Date.now() - batchStart > batchBudget) {
      log("[self-qa] Batch budget exhausted — marking remaining as timed-out");
      for (const remaining of scenarios.slice(runs.length)) runs.push(timedOutRun(remaining));
      break;
    }
    log(`[self-qa] → ${scenario.id}: ${scenario.description}`);
    runs.push(await runOneScenario(scenario, { args, env, entry, mockDir, log }));
  }

  return runs;
}

/**
 * Drive ONE scenario against a child spawned solely for it.
 *
 * Never throws: any failure is folded into the returned ScenarioRun so the
 * judge — not the orchestrator — decides the verdict.
 */
async function runOneScenario(
  scenario: Scenario,
  ctx: { args: string[]; env: Record<string, string>; entry: string; mockDir: string; log: (m: string) => void },
): Promise<ScenarioRun> {
  const startedAt = Date.now();

  let spawnResult: Awaited<ReturnType<typeof spawnAgentTui>>;
  try {
    spawnResult = await spawnAgentTui(ctx.args, { spawnOpts: { env: ctx.env } });
  } catch (err) {
    const trace = err instanceof Error ? (err.stack ?? err.message) : String(err);
    ctx.log(`[self-qa] Spawn failed for ${scenario.id}: ${trace}`);
    return crashedRun(scenario, trace);
  }

  const { proc, inWrite, outRead, cleanup } = spawnResult;

  // The child is spawned with `stdio: ["pipe","pipe","pipe"]` and nothing here
  // used to read stdout or stderr, so everything it printed while failing was
  // discarded. Keep a bounded stderr tail — that is where a failing child says
  // WHY — and drain stdout so the rendered-TUI bytes (measured ~1.4 KB/s at the
  // prompt, 17.5 KB over a 5 s scenario) do not pile up unread in the pipe.
  //
  // Draining is NOT a fix for a wedged child: measured 2026-09-24, a child left
  // with a completely unread stdout for 150 s (~210 KB) still mounted, still
  // answered `/agents`, and still reported `exitCode === null`. So the pipe does
  // not block here; the reason to read it is diagnostic, not liveness.
  const stderrChunks: string[] = [];
  let stderrBytes = 0;
  proc.stderr?.on("data", (d: Buffer | string) => {
    const text = typeof d === "string" ? d : d.toString("utf8");
    stderrBytes += text.length;
    stderrChunks.push(text);
    // Bounded: keep the TAIL, because the useful line is the last one.
    while (stderrChunks.length > 1 && stderrChunks.join("").length > STDERR_TAIL_CHARS) stderrChunks.shift();
  });
  proc.stdout?.on("data", () => {
    // Intentionally discarded: this is the rendered TUI, not diagnostics. The
    // listener exists so the stream is consumed rather than left unread.
  });

  let idleObserved = 0;
  const driver = wireDriver(inWrite, outRead, () => {
    idleObserved++;
  });
  const eventBus: LiveEvent[] = [];
  attachEventCollector(driver, eventBus);

  // ANY exit before we deliberately kill the child is a crash — including
  // `code=0`. The child leaves its last frame behind in the driver, so without
  // this a dead child's stale tree would satisfy `selectorPresent`.
  let done = false;
  let crashTrace: string | undefined;
  let childExit: { code: number | null; signal: string | null } | undefined;
  proc.on("exit", (code, signal) => {
    childExit = { code, signal: signal ?? null };
    if (!done) crashTrace = `child exited early: code=${code} signal=${signal ?? "none"}`;
    driver._closeAllSubscribers();
  });

  const syncTimeouts: string[] = [];
  // Readiness is assumed until a step marked `guard` actually expires, so a
  // scenario with no guard (smoke-boot) is judged exactly as before.
  let mounted = true;
  let mountGuard: ScenarioRun["mountGuard"];
  let errorTrace: string | undefined;
  let stepIndex = -1;
  try {
    for (const step of scenario.steps) {
      stepIndex++;
      const outcome = await runStep(driver, step, scenario.budgetMs, syncTimeouts);
      if (step.op === "wait_for" && step.guard === true) {
        mountGuard = { label: outcome.label ?? "?", timeoutMs: outcome.timeoutMs ?? 0, waitedMs: outcome.waitedMs };
        if (outcome.expired) mounted = false;
      }
    }
  } catch (err) {
    errorTrace = err instanceof Error ? err.message : String(err);
    ctx.log(`[self-qa] ${scenario.id}: step error at step ${stepIndex}: ${errorTrace}`);
  }

  const finalFrame = driver.snapshot();
  const endedAt = Date.now();
  const childAlive = proc.exitCode === null && proc.signalCode === null;
  const stderrTail = stderrChunks.join("").slice(-STDERR_TAIL_CHARS);
  done = true;
  try {
    proc.kill();
  } catch (err) {
    ctx.log(`[self-qa] ${scenario.id}: failed to kill child: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    cleanup();
  } catch (err) {
    ctx.log(`[self-qa] ${scenario.id}: transport cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    scenario,
    events: eventBus,
    finalFrame,
    startedAt,
    endedAt,
    timedOut: endedAt - startedAt > scenario.budgetMs,
    crashed: crashTrace !== undefined,
    errorTrace: crashTrace ?? errorTrace,
    idleObserved,
    syncTimeouts,
    mounted,
    ...(mountGuard ? { mountGuard } : {}),
    childAlive,
    ...(childExit ? { childExit } : {}),
    ...(stderrBytes > 0 ? { stderrTail } : {}),
  };
}

function wireDriver(inWrite: NodeJS.WritableStream, outRead: NodeJS.ReadableStream, onIdle: () => void): Driver {
  const driver = createDriver({
    sendKey: (k) => inWrite.write(`${JSON.stringify({ op: "press", key: k })}\n`),
    sendType: (t) => inWrite.write(`${JSON.stringify({ op: "type", text: t })}\n`),
  });

  const splitter = createLineSplitter((line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.mode === "live") {
        driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      } else if (msg.t === "idle") {
        onIdle();
        driver._ingest({ kind: "idle" });
      } else if (msg.t === "event") {
        driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
      }
    } catch {
      // Ignore malformed lines — sidechannel may emit partial chunks.
    }
  });

  outRead.on("data", (chunk: Buffer | string) => {
    splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });

  return driver;
}

function attachEventCollector(driver: Driver, bus: LiveEvent[]): void {
  // Buffer every typed event so per-scenario slices can be cut by index.
  // We listen via the async iterable so late-subscribe replay applies.
  void (async () => {
    try {
      for await (const e of driver.events()) {
        bus.push(e);
      }
    } catch {
      // iterator terminated cleanly when driver closed.
    }
  })();
}

/**
 * A `wait_for` step is SYNCHRONISATION, not an assertion.
 *
 * Its expiry is recorded in `syncTimeouts` and the scenario CONTINUES, so the
 * scenario's real `expectations` are still evaluated against the final frame.
 * Aborting here was the defect: one expired wait discarded every assertion the
 * scenario had, and the result was reported as `inconclusive` — which the
 * process exit code then ignored entirely.
 */
type StepOutcome = {
  /** True when a `wait_for` gave up instead of resolving. */
  expired: boolean;
  /** What it was waiting for, for the failure line. */
  label?: string;
  timeoutMs?: number;
  /** How long it ACTUALLY waited — the number missing from every old report. */
  waitedMs: number;
};

async function runStep(
  driver: Driver,
  step: ScenarioStep,
  budgetMs: number,
  syncTimeouts: string[],
): Promise<StepOutcome> {
  switch (step.op) {
    case "type":
      driver.type(step.text);
      return { expired: false, waitedMs: 0 };
    case "press":
      driver.press(step.key);
      return { expired: false, waitedMs: 0 };
    case "press_sequence":
      driver.press_sequence(step.keys);
      return { expired: false, waitedMs: 0 };
    case "focus":
      try {
        driver.focus(step.selector);
      } catch (err) {
        syncTimeouts.push(`focus ${step.selector}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { expired: false, waitedMs: 0 };
    case "wait_for": {
      const timeout = step.timeoutMs ?? Math.min(budgetMs, 5_000);
      const label = step.idle ? "idle" : (step.selector ?? step.event ?? "nothing");
      const t0 = Date.now();
      try {
        if (step.idle) await driver.wait_for({ idle: true, timeoutMs: timeout });
        else if (step.selector) await driver.wait_for({ selector: step.selector, timeoutMs: timeout });
        else if (step.event) await driver.wait_for({ event: step.event, timeoutMs: timeout });
      } catch (err) {
        const waitedMs = Date.now() - t0;
        // Report the MEASURED wait next to the budget. Without it, "expired
        // after its 15000ms timeout" and "gave up 300ms in because the driver
        // rejected" read identically, and only the first is a timing problem.
        syncTimeouts.push(
          `wait_for ${label} (budget ${timeout}ms, waited ${waitedMs}ms): ${err instanceof Error ? err.message : String(err)}`,
        );
        return { expired: true, label, timeoutMs: timeout, waitedMs };
      }
      return { expired: false, label, timeoutMs: timeout, waitedMs: Date.now() - t0 };
    }
  }
}

function crashedRun(scenario: Scenario, trace: string): ScenarioRun {
  return {
    scenario,
    events: [],
    finalFrame: null,
    startedAt: Date.now(),
    endedAt: Date.now(),
    timedOut: false,
    crashed: true,
    errorTrace: trace,
    idleObserved: 0,
    syncTimeouts: [],
    // The child never existed, so it was never ready and never alive.
    mounted: false,
    childAlive: false,
  };
}

function timedOutRun(scenario: Scenario): ScenarioRun {
  return {
    scenario,
    events: [],
    finalFrame: null,
    startedAt: Date.now(),
    endedAt: Date.now(),
    timedOut: true,
    crashed: false,
    idleObserved: 0,
    syncTimeouts: [],
    // Never spawned: the batch budget ran out before its turn.
    mounted: false,
    childAlive: false,
  };
}
