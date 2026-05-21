/**
 * task-runner.ts — P15 single-task maintenance sprint.
 *
 * Mirror of src/product-loop/sprint-runner.ts but stripped for Mode C:
 * one task = one tight cycle: design → edit → verify → judge → review.
 *
 * No council debate, no multi-role, no CB-1/CB-2/CB-3. Verify recipe MUST exist.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { pickCouncilTaskModel } from "../council/leader.js";
import { phaseDone, phaseError, phaseStart } from "../council/phase-events.js";
import { evaluateDoneGate } from "../product-loop/done-gate.js";
import type { Criterion } from "../product-loop/types.js";
import type { StreamChunk } from "../types/index.js";
import { runVerifyOrchestration, type VerifyAgentLike } from "../verify/orchestrator.js";
import type { CodebaseIntel, MaintenanceTask } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Write pre-edit marker SHA so P16 buildPr's squash step can collapse all
 * Edit-stage commits into a single PR commit (D3 in MAINTAIN-MODE.md).
 * Non-fatal — squash degrades gracefully when marker is missing.
 */
async function writePreEditMarker(cwd: string, runId: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const sha = stdout.trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return;
    const markerPath = join(cwd, ".planning", "runs", runId, "pre-edit-marker.sha");
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, sha, "utf8");
  } catch {
    // No git repo, detached HEAD, or fs error — non-fatal.
  }
}

// ─── Public interfaces ───────────────────────────────────────────────────────

export interface RunMaintenanceTaskInput {
  task: MaintenanceTask;
  codebaseIntel: CodebaseIntel;
  ctx: MaintenanceCtx;
  leaderModelId: string;
  costAware: boolean;
}

/**
 * Minimal context needed by the maintenance task runner.
 * A subset of DriverContext — keeps task-runner independent of the full product-loop.
 */
export interface MaintenanceCtx {
  runId: string;
  sessionId?: string;
  cwd: string;
  llm: {
    generate(modelId: string, system: string, prompt: string, maxTokens?: number): Promise<string>;
  };
  processMessageFn: (message: string) => AsyncGenerator<StreamChunk, void, unknown>;
  detectVerifyRecipe: () => Promise<import("../types/index.js").VerifyRecipe | null>;
  respondToPreflight: import("../council/types.js").PreflightResponder;
}

export interface MaintenanceTaskResult {
  status: "done" | "blocked" | "failed";
  designPlan: string;
  verifyOutput: string;
  judgeScore: number;
  reviewConcerns: string[];
  failureReason?: string;
}

// ─── Phase IDs & labels ──────────────────────────────────────────────────────

const PHASE_IDS = {
  design: "maint-design",
  edit: "maint-edit",
  verify: "maint-verify",
  judge: "maint-judge",
  review: "maint-review",
} as const;

const PHASE_LABELS = {
  design: "Design",
  edit: "Edit",
  verify: "Verify",
  judge: "Judge",
  review: "Review",
} as const;

// ─── Main generator ──────────────────────────────────────────────────────────

/**
 * Run a single maintenance task through the 5-stage cycle.
 * Yields StreamChunk events for the TUI and returns a MaintenanceTaskResult.
 */
export async function* runMaintenanceTask(
  input: RunMaintenanceTaskInput,
): AsyncGenerator<StreamChunk, MaintenanceTaskResult, unknown> {
  const { task, codebaseIntel, ctx, leaderModelId, costAware } = input;

  // ── Stage 1: Design ────────────────────────────────────────────────────────
  const designStartedAt = Date.now();
  yield phaseStart({
    phaseId: PHASE_IDS.design,
    kind: "sprint_stage",
    label: PHASE_LABELS.design,
    detail: "Generating 5-10 line fix plan from codebase intel",
    startedAt: designStartedAt,
  });

  let designPlan = "";
  try {
    const designModelId = pickCouncilTaskModel("maintain_design", leaderModelId, costAware);
    const designSystem = [
      "You are a senior software engineer performing a surgical code fix.",
      "You MUST produce a concise 5-10 line action plan (numbered list).",
      "Be specific: name the files and functions to change.",
      "Do NOT write code — write the plan only.",
    ].join(" ");

    const designPrompt = buildDesignPrompt(task, codebaseIntel);
    designPlan = await ctx.llm.generate(designModelId, designSystem, designPrompt, 512);

    yield { type: "content", content: `\n## Design Plan\n${designPlan}\n` };
    yield phaseDone({
      phaseId: PHASE_IDS.design,
      kind: "sprint_stage",
      label: PHASE_LABELS.design,
      startedAt: designStartedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield phaseError({
      phaseId: PHASE_IDS.design,
      kind: "sprint_stage",
      label: PHASE_LABELS.design,
      startedAt: designStartedAt,
      errorMessage: msg,
    });
    return {
      status: "failed",
      designPlan: "",
      verifyOutput: "",
      judgeScore: 0,
      reviewConcerns: [],
      failureReason: `design stage failed: ${msg}`,
    };
  }

  // ── Stage 2: Edit ──────────────────────────────────────────────────────────
  // D3: snapshot HEAD BEFORE any edits so P16 can squash agent commits into one.
  await writePreEditMarker(ctx.cwd, ctx.runId);

  const editStartedAt = Date.now();
  yield phaseStart({
    phaseId: PHASE_IDS.edit,
    kind: "sprint_stage",
    label: PHASE_LABELS.edit,
    detail: "Orchestrator executing design plan",
    startedAt: editStartedAt,
  });

  let editError: string | null = null;
  const editPrompt = buildEditPrompt(task, designPlan);
  try {
    const editGen = ctx.processMessageFn(editPrompt);
    for await (const chunk of editGen) {
      yield chunk as StreamChunk;
    }
  } catch (e) {
    editError = e instanceof Error ? e.message : String(e);
  }

  if (editError) {
    yield phaseError({
      phaseId: PHASE_IDS.edit,
      kind: "sprint_stage",
      label: PHASE_LABELS.edit,
      startedAt: editStartedAt,
      errorMessage: editError,
    });
    return {
      status: "failed",
      designPlan,
      verifyOutput: "",
      judgeScore: 0,
      reviewConcerns: [],
      failureReason: `edit stage failed: ${editError}`,
    };
  }

  yield phaseDone({
    phaseId: PHASE_IDS.edit,
    kind: "sprint_stage",
    label: PHASE_LABELS.edit,
    startedAt: editStartedAt,
  });

  // ── Stage 3: Verify ────────────────────────────────────────────────────────
  const verifyStartedAt = Date.now();
  yield phaseStart({
    phaseId: PHASE_IDS.verify,
    kind: "sprint_stage",
    label: PHASE_LABELS.verify,
    detail: "Running existing test suite",
    startedAt: verifyStartedAt,
  });

  // Mode C REQUIRES a verify recipe — fail early if missing.
  const verifyRecipe = await ctx.detectVerifyRecipe();
  if (!verifyRecipe) {
    const noRecipeMsg = "no verify recipe — Mode C requires existing project with detectable recipe";
    yield phaseError({
      phaseId: PHASE_IDS.verify,
      kind: "sprint_stage",
      label: PHASE_LABELS.verify,
      startedAt: verifyStartedAt,
      errorMessage: noRecipeMsg,
    });
    return {
      status: "failed",
      designPlan,
      verifyOutput: "",
      judgeScore: 0,
      reviewConcerns: [],
      failureReason: noRecipeMsg,
    };
  }

  const verifyAgent = buildVerifyAgent(ctx, verifyRecipe);
  const verifyResult = await runVerifyOrchestration(verifyAgent);
  const verifyOutput = (verifyResult.output ?? "") + (verifyResult.error ?? "");

  yield phaseDone({
    phaseId: PHASE_IDS.verify,
    kind: "sprint_stage",
    label: PHASE_LABELS.verify,
    startedAt: verifyStartedAt,
  });

  // ── Stage 4: Judge ─────────────────────────────────────────────────────────
  const judgeStartedAt = Date.now();
  yield phaseStart({
    phaseId: PHASE_IDS.judge,
    kind: "sprint_stage",
    label: PHASE_LABELS.judge,
    detail: "Evaluating acceptance criteria against verify output",
    startedAt: judgeStartedAt,
  });

  // Map task.acceptance_criteria strings to Criterion shape.
  const criteria: Criterion[] = task.acceptance_criteria.map((text, i) => ({
    id: `ac-${i}`,
    status: "unmet" as const,
    evidence: verifyOutput.toLowerCase().includes(text.toLowerCase().slice(0, 20))
      ? verifyOutput.slice(0, 200)
      : undefined,
  }));

  // Use a minimal no-op CouncilLLM wrapper for done-gate (Mode C: no cost metering).
  const minimalLlm = {
    generate: (modelId: string, system: string, prompt: string) => ctx.llm.generate(modelId, system, prompt),
    research: async () => "",
    debate: async () => ({ text: "", toolCalls: [] as Array<{ toolName: string; result?: unknown }> }),
  };

  // Map verifyResult to the expected ToolResult shape.
  const lastVerify = {
    success: verifyResult.success,
    output: verifyOutput,
    error: verifyResult.error,
    verifyRecipe,
  };

  const verdict = await evaluateDoneGate({
    lastVerify,
    recipe: verifyRecipe,
    criteria,
    history: [],
    roleAssignments: new Map(),
    llm: minimalLlm,
    respondToPreflight: ctx.respondToPreflight,
  });

  yield phaseDone({
    phaseId: PHASE_IDS.judge,
    kind: "sprint_stage",
    label: PHASE_LABELS.judge,
    startedAt: judgeStartedAt,
  });

  if (!verdict.pass) {
    const failReason =
      verdict.reason ??
      `judge failed condition: ${verdict.failedCondition ?? "unknown"} (score ${verdict.score.toFixed(2)})`;
    yield phaseError({
      phaseId: PHASE_IDS.judge,
      kind: "sprint_stage",
      label: PHASE_LABELS.judge,
      startedAt: judgeStartedAt,
      errorMessage: failReason,
    });
    yield {
      type: "content",
      content: `\n> Mode C judge halted: ${failReason}\n`,
    };
    return {
      status: "blocked",
      designPlan,
      verifyOutput,
      judgeScore: verdict.score,
      reviewConcerns: [],
      failureReason: failReason,
    };
  }

  // ── Stage 5: Review ────────────────────────────────────────────────────────
  const reviewStartedAt = Date.now();
  yield phaseStart({
    phaseId: PHASE_IDS.review,
    kind: "sprint_stage",
    label: PHASE_LABELS.review,
    detail: "Review agent scanning for regression risks",
    startedAt: reviewStartedAt,
  });

  let reviewConcerns: string[] = [];
  try {
    const reviewModelId = pickCouncilTaskModel("maintain_review", leaderModelId, costAware);
    const reviewSystem =
      "You are a code review agent. Your job is to identify regression risks, missed edge cases, and pattern violations. " +
      'Output ONLY a JSON object in the format: { "ok": boolean, "concerns": string[] }. No other text.';

    const reviewPrompt = buildReviewPrompt(task, designPlan, verifyOutput);
    const reviewText = await ctx.llm.generate(reviewModelId, reviewSystem, reviewPrompt, 512);

    try {
      // Extract JSON from response (may have markdown fencing)
      const jsonMatch = reviewText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { ok?: boolean; concerns?: string[] };
        reviewConcerns = Array.isArray(parsed.concerns) ? parsed.concerns : [];
      }
    } catch {
      // Non-parseable review is non-fatal — treat as no concerns.
    }

    yield phaseDone({
      phaseId: PHASE_IDS.review,
      kind: "sprint_stage",
      label: PHASE_LABELS.review,
      startedAt: reviewStartedAt,
    });

    if (reviewConcerns.length > 0) {
      const concernsList = reviewConcerns.map((c, i) => `${i + 1}. ${c}`).join("\n");
      yield {
        type: "content",
        content: `\n## Review Concerns\n${concernsList}\n\n> These are visible for your review — no auto-block.\n`,
      };
    }
  } catch (err) {
    // Review failure is non-fatal — log and continue to done.
    const msg = err instanceof Error ? err.message : String(err);
    yield phaseError({
      phaseId: PHASE_IDS.review,
      kind: "sprint_stage",
      label: PHASE_LABELS.review,
      startedAt: reviewStartedAt,
      errorMessage: msg,
    });
  }

  return {
    status: "done",
    designPlan,
    verifyOutput,
    judgeScore: verdict.score,
    reviewConcerns,
  };
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildDesignPrompt(task: MaintenanceTask, intel: CodebaseIntel): string {
  const candidates = intel.candidateFiles
    .slice(0, 5)
    .map((f) => `  - ${f.path} (score=${f.matchScore.toFixed(2)}; ${f.reason})`)
    .join("\n");

  const impactList = intel.impactRadius.slice(0, 8).join(", ") || "none detected";
  const regressionList = intel.regressionTests.slice(0, 5).join(", ") || "none detected";

  return [
    `Task: [${task.kind}] ${task.title}`,
    ``,
    `Description:\n${task.description}`,
    task.reproSteps ? `\nRepro steps:\n${task.reproSteps}` : "",
    task.expectedBehavior ? `\nExpected behavior:\n${task.expectedBehavior}` : "",
    task.observedBehavior ? `\nObserved behavior:\n${task.observedBehavior}` : "",
    ``,
    `Acceptance criteria:`,
    task.acceptance_criteria.map((c) => `  - ${c}`).join("\n"),
    ``,
    `Candidate files to change:\n${candidates}`,
    ``,
    `Impact radius (files that import candidates): ${impactList}`,
    `Regression test files: ${regressionList}`,
    `Detected frameworks: ${intel.detectedFrameworks.join(", ") || "unknown"}`,
    ``,
    `Codebase map (excerpt):\n${intel.repoMap.slice(0, 1500)}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function buildEditPrompt(task: MaintenanceTask, designPlan: string): string {
  return [
    `You are executing a maintenance task. Follow the design plan EXACTLY.`,
    ``,
    `Task: [${task.kind}] ${task.title}`,
    ``,
    `Description:\n${task.description}`,
    ``,
    `Acceptance criteria:`,
    task.acceptance_criteria.map((c) => `  - ${c}`).join("\n"),
    ``,
    `Design plan to execute:\n${designPlan}`,
    ``,
    `Make the minimal changes needed to satisfy the acceptance criteria.`,
    `Do NOT refactor unrelated code. Do NOT add features outside the task scope.`,
  ].join("\n");
}

function buildReviewPrompt(task: MaintenanceTask, designPlan: string, verifyOutput: string): string {
  return [
    `Task: [${task.kind}] ${task.title}`,
    `Description: ${task.description}`,
    ``,
    `Design plan that was executed:\n${designPlan}`,
    ``,
    `Verify output (last 2000 chars):\n${verifyOutput.slice(-2000)}`,
    ``,
    `Acceptance criteria:`,
    task.acceptance_criteria.map((c) => `  - ${c}`).join("\n"),
    ``,
    `Identify regression risks, missed edge cases, or pattern violations.`,
    `Output ONLY: { "ok": boolean, "concerns": string[] }`,
  ].join("\n");
}

// ─── Verify agent builder ────────────────────────────────────────────────────

function buildVerifyAgent(ctx: MaintenanceCtx, recipe: import("../types/index.js").VerifyRecipe): VerifyAgentLike {
  let sandboxSettings: import("../utils/settings.js").SandboxSettings =
    {} as import("../utils/settings.js").SandboxSettings;

  return {
    getCwd: () => ctx.cwd,
    getSandboxSettings: () => sandboxSettings,
    setSandboxSettings: (s) => {
      sandboxSettings = s;
    },
    detectVerifyRecipe: async () => recipe,
    runTaskRequest: async (req) => {
      const gen = ctx.processMessageFn(req.prompt);
      let output = "";
      for await (const chunk of gen) {
        if (chunk.type === "content" && typeof chunk.content === "string") {
          output += chunk.content;
        }
      }
      return { success: true, output } as import("../types/index.js").ToolResult;
    },
  };
}
