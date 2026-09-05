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
  /** Only the scenarios that were actually DRIVEN — `runs`/`results` align 1:1. */
  scenarios: Scenario[];
  runs: ScenarioRun[];
  results: JudgeResult[];
  summary: ReturnType<typeof summariseResults>;
  /**
   * Surfaces the planner noticed but knows no way to reach. Reported rather
   * than driven: driving them produces a guaranteed-permanent `inconclusive`
   * that says nothing about the change under test. "I could not reach this" is
   * deliberately distinct from "I drove it and could not establish a result".
   */
  skipped: { id: string; reason: string }[];
  emittedSpecs: string[];
  /** Wall-clock duration of the entire batch. */
  durationMs: number;
};

/** Exit codes for `muonroi-cli self-verify`. See {@link selfVerifyExitCode}. */
export const SELF_VERIFY_EXIT = {
  /** Every scenario that ran asserted successfully. */
  OK: 0,
  /** At least one scenario FAILED an expectation — a definite negative. */
  FAILED: 1,
  /** Nothing failed, but at least one scenario established nothing. */
  INCONCLUSIVE: 3,
} as const;

/**
 * The exit-code contract.
 *
 * Exit 0 means, and may only mean: **every scenario that ran actually asserted
 * something, and those assertions held.**
 *
 * Previously this was `failed > 0 ? 1 : 0`, which made `inconclusive`
 * indistinguishable from success. Because a `wait_for` expiry short-circuited
 * the judge before the expectation loop, a scenario that tested NOTHING landed
 * in `inconclusive` and the gate reported success: measured on commit 932dab45,
 * `self-verify --since HEAD~2 --max 6` printed "1/6 passed, 0 failed, 5
 * inconclusive" and exited 0, and `scripts/self-verify-pre-push.cjs:79` logged
 * "self-verify PASSED". A gate that cannot say "no" is not a gate.
 *
 * `inconclusive` is kept as a real third outcome rather than folded into
 * `failed`, because "the child died" and "the feature is broken" call for
 * different responses — but it is NOT success, so it gets its own non-zero
 * code. Every non-zero blocks the pre-push hook identically; the distinct code
 * exists so a caller can tell a regression from a broken instrument.
 *
 * `total === 0` (nothing planned) stays 0: there was nothing to verify, which
 * is not the same as a failure to verify.
 */
export function selfVerifyExitCode(summary: {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
}): number {
  if (summary.failed > 0) return SELF_VERIFY_EXIT.FAILED;
  if (summary.inconclusive > 0) return SELF_VERIFY_EXIT.INCONCLUSIVE;
  // Guard against a future path that reports scenarios but judges none of them.
  if (summary.total > 0 && summary.passed === 0) return SELF_VERIFY_EXIT.INCONCLUSIVE;
  return SELF_VERIFY_EXIT.OK;
}

export async function runSelfVerify(opts: SelfVerifyOptions = {}): Promise<SelfVerifyReport> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();

  const plannerOpts: PlannerOptions = {
    baseRef: opts.baseRef,
    cwd: opts.cwd,
    maxScenarios: opts.maxScenarios,
    diffFilesOverride: opts.diffFilesOverride,
  };
  const planned = planScenarios(plannerOpts);
  const scenarios = planned.filter((s) => s.reachable !== false);
  const skipped = planned
    .filter((s) => s.reachable === false)
    .map((s) => ({ id: s.id, reason: s.unreachableReason ?? "unreachable" }));
  log(`[self-verify] Planned ${planned.length} scenario(s): ${scenarios.length} drivable, ${skipped.length} skipped`);
  for (const s of skipped) log(`[self-verify]   skipped ${s.id} — ${s.reason}`);

  const orchOpts: OrchestratorOptions = {
    mockLlmDir: opts.mockLlmDir,
    log,
  };
  const runs = await runScenarios(scenarios, orchOpts);

  const results = runs.map(judge);
  const summary = summariseResults(results);
  log(
    `[self-verify] Summary: ${summary.passed}/${summary.total} passed, ` +
      `${summary.failed} failed, ${summary.inconclusive} inconclusive, ${skipped.length} skipped`,
  );
  for (const r of results) {
    if (r.verdict === "pass") continue;
    log(`[self-verify]   ${r.verdict.toUpperCase()} ${r.scenarioId}`);
    for (const c of r.checks) {
      if (!c.passed) log(`[self-verify]     · ${c.expectation.kind}: ${c.reason}`);
    }
  }

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
    skipped,
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
