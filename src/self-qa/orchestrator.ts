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
  proc.on("exit", (code, signal) => {
    if (!done) crashTrace = `child exited early: code=${code} signal=${signal ?? "none"}`;
    driver._closeAllSubscribers();
  });

  const syncTimeouts: string[] = [];
  let errorTrace: string | undefined;
  try {
    for (const step of scenario.steps) {
      await runStep(driver, step, scenario.budgetMs, syncTimeouts);
    }
  } catch (err) {
    errorTrace = err instanceof Error ? err.message : String(err);
    ctx.log(`[self-qa] ${scenario.id}: step error: ${errorTrace}`);
  }

  const finalFrame = driver.snapshot();
  const endedAt = Date.now();
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
async function runStep(
  driver: Driver,
  step: ScenarioStep,
  budgetMs: number,
  syncTimeouts: string[],
): Promise<void> {
  switch (step.op) {
    case "type":
      driver.type(step.text);
      return;
    case "press":
      driver.press(step.key);
      return;
    case "press_sequence":
      driver.press_sequence(step.keys);
      return;
    case "focus":
      try {
        driver.focus(step.selector);
      } catch (err) {
        syncTimeouts.push(`focus ${step.selector}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    case "wait_for": {
      const timeout = step.timeoutMs ?? Math.min(budgetMs, 5_000);
      const label = step.idle ? "idle" : (step.selector ?? step.event ?? "nothing");
      try {
        if (step.idle) await driver.wait_for({ idle: true, timeoutMs: timeout });
        else if (step.selector) await driver.wait_for({ selector: step.selector, timeoutMs: timeout });
        else if (step.event) await driver.wait_for({ event: step.event, timeoutMs: timeout });
      } catch (err) {
        syncTimeouts.push(`wait_for ${label} (${timeout}ms): ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
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
  };
}
