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
 *   - We close the child after the scenario batch finishes (or on first crash).
 *     Each scenario does NOT spawn its own child — the cost would dominate.
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

  log(`[self-qa] Spawning child: ${entry} (mock-llm: ${mockDir})`);

  const args = [entry, "--agent-mode", "--mock-llm", mockDir, ...(opts.extraArgs ?? [])];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MUONROI_TEST_NO_PERSIST: "1",
    MUONROI_INTERNAL_SHIM_OK: "1",
    ...(opts.env ?? {}),
  };

  let spawnResult: Awaited<ReturnType<typeof spawnAgentTui>>;
  try {
    spawnResult = await spawnAgentTui(args, { spawnOpts: { env } });
  } catch (err) {
    const trace = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[self-qa] Spawn failed: ${trace}`);
    return scenarios.map((s) => crashedRun(s, trace));
  }

  const { proc, inWrite, outRead, cleanup } = spawnResult;
  const driver = wireDriver(inWrite, outRead);
  const eventBus: LiveEvent[] = [];
  attachEventCollector(driver, eventBus);

  let childCrashed = false;
  let crashTrace: string | undefined;
  proc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      childCrashed = true;
      crashTrace = `child exited code=${code} signal=${signal ?? "none"}`;
    }
    driver._closeAllSubscribers();
  });

  const runs: ScenarioRun[] = [];
  try {
    // Wait for the TUI to become idle before driving the first scenario.
    await safeWait(() => driver.wait_for({ idle: true, timeoutMs: 15_000 }));

    for (const scenario of scenarios) {
      if (Date.now() - batchStart > batchBudget) {
        log(`[self-qa] Batch budget exhausted — marking remaining as timed-out`);
        for (const remaining of scenarios.slice(runs.length)) {
          runs.push(timedOutRun(remaining));
        }
        break;
      }

      log(`[self-qa] → ${scenario.id}: ${scenario.description}`);
      const before = eventBus.length;
      const startedAt = Date.now();
      let timedOut = false;
      let errorTrace: string | undefined;

      try {
        await driveScenario(driver, scenario);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timeout") || msg.includes("wait_for")) {
          timedOut = true;
        }
        errorTrace = msg;
      }

      const endedAt = Date.now();
      const sliced = eventBus.slice(before);

      const finalFrame = driver.snapshot();
      runs.push({
        scenario,
        events: sliced,
        finalFrame,
        startedAt,
        endedAt,
        timedOut,
        crashed: childCrashed,
        errorTrace: childCrashed ? crashTrace : errorTrace,
      });

      if (childCrashed) {
        log(`[self-qa] Child crashed — aborting remaining scenarios`);
        for (const remaining of scenarios.slice(runs.length)) {
          runs.push(crashedRun(remaining, crashTrace ?? "child crashed"));
        }
        break;
      }
    }
  } finally {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    cleanup();
  }

  return runs;
}

function wireDriver(inWrite: NodeJS.WritableStream, outRead: NodeJS.ReadableStream): Driver {
  const driver = createDriver({
    sendKey: (k) => inWrite.write(JSON.stringify({ op: "press", key: k }) + "\n"),
    sendType: (t) => inWrite.write(JSON.stringify({ op: "type", text: t }) + "\n"),
  });

  const splitter = createLineSplitter((line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg["mode"] === "live") {
        driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      } else if (msg["t"] === "idle") {
        driver._ingest({ kind: "idle" });
      } else if (msg["t"] === "event") {
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

async function driveScenario(driver: Driver, scenario: Scenario): Promise<void> {
  for (const step of scenario.steps) {
    await runStep(driver, step, scenario.budgetMs);
  }
}

async function runStep(driver: Driver, step: ScenarioStep, budgetMs: number): Promise<void> {
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
      } catch {
        // Focus may throw if selector is ambiguous or missing — non-fatal in
        // probe scenarios; judge will detect via selectorPresent if needed.
      }
      return;
    case "wait_for": {
      const timeout = step.timeoutMs ?? Math.min(budgetMs, 5_000);
      if (step.idle) {
        await driver.wait_for({ idle: true, timeoutMs: timeout });
        return;
      }
      if (step.selector) {
        await driver.wait_for({ selector: step.selector, timeoutMs: timeout });
        return;
      }
      if (step.event) {
        await driver.wait_for({ event: step.event, timeoutMs: timeout });
        return;
      }
      return;
    }
  }
}

async function safeWait(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Initial idle may fail on slow boot — downstream scenarios handle their
    // own wait_for so this is best-effort.
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
  };
}
