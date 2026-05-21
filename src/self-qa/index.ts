/**
 * Self-QA — public entry point.
 *
 * Usage:
 *   import { runSelfVerify } from "./self-qa/index.js";
 *   const report = await runSelfVerify({ baseRef: "HEAD~1" });
 */

import { judge, summariseResults } from "./judge.js";
import { type OrchestratorOptions, runScenarios } from "./orchestrator.js";
import { type PlannerOptions, planScenarios } from "./scenario-planner.js";
import { emitSpec } from "./spec-emitter.js";
import type { JudgeResult, Scenario, ScenarioRun } from "./types.js";

export type SelfVerifyOptions = {
  baseRef?: string;
  cwd?: string;
  maxScenarios?: number;
  mockLlmDir?: string;
  /** Emit .spec.ts for every passing scenario. Default: true. */
  emitSpecs?: boolean;
  /** Override spec output dir. */
  specOutDir?: string;
  /** Override file list (skip git diff). */
  diffFilesOverride?: string[];
  /** Optional logger. */
  log?: (msg: string) => void;
};

export type SelfVerifyReport = {
  scenarios: Scenario[];
  runs: ScenarioRun[];
  results: JudgeResult[];
  summary: ReturnType<typeof summariseResults>;
  emittedSpecs: string[];
  /** Wall-clock duration of the entire batch. */
  durationMs: number;
};

export async function runSelfVerify(opts: SelfVerifyOptions = {}): Promise<SelfVerifyReport> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();

  const plannerOpts: PlannerOptions = {
    baseRef: opts.baseRef,
    cwd: opts.cwd,
    maxScenarios: opts.maxScenarios,
    diffFilesOverride: opts.diffFilesOverride,
  };
  const scenarios = planScenarios(plannerOpts);
  log(`[self-verify] Planned ${scenarios.length} scenario(s)`);

  const orchOpts: OrchestratorOptions = {
    mockLlmDir: opts.mockLlmDir,
    log,
  };
  const runs = await runScenarios(scenarios, orchOpts);

  const results = runs.map(judge);
  const summary = summariseResults(results);
  log(
    `[self-verify] Summary: ${summary.passed}/${summary.total} passed, ` +
      `${summary.failed} failed, ${summary.inconclusive} inconclusive`,
  );

  const emittedSpecs: string[] = [];
  if (opts.emitSpecs !== false) {
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const scenario = scenarios[i];
      if (!result || !scenario) continue;
      if (result.verdict !== "pass") continue;
      try {
        const path = emitSpec(scenario, result, { outDir: opts.specOutDir });
        emittedSpecs.push(path);
        log(`[self-verify] Emitted spec: ${path}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[self-verify] Spec emit failed for ${scenario.id}: ${msg}`);
      }
    }
  }

  return {
    scenarios,
    runs,
    results,
    summary,
    emittedSpecs,
    durationMs: Date.now() - t0,
  };
}

export type { AgenticContextBlock, AgenticContextOptions } from "./agentic-context.js";
export { buildAgenticContext } from "./agentic-context.js";
export type {
  AgenticBrain,
  AgenticDecision,
  AgenticLoopOptions,
  AgenticReport,
  AgenticTurn,
  LLMBrainOptions,
} from "./agentic-loop.js";
export { createLLMBrain, createMockBrain, parseDecision, runAgenticLoop } from "./agentic-loop.js";
export { applyDelta, compressionRatio, encodeDelta } from "./delta-encoder.js";
export type {
  CheckResult,
  Expectation,
  FrameDelta,
  JudgeResult,
  JudgeVerdict,
  Scenario,
  ScenarioRun,
  ScenarioStep,
  SemanticHit,
} from "./types.js";
export { emitSpec, judge, planScenarios, runScenarios, summariseResults };
