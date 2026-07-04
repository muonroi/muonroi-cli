import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveLeaderModel } from "../council/leader.js";
import type { CouncilLLM, PreflightResponder, QuestionResponder } from "../council/types.js";
import type { EERouteResult } from "../ee/bridge.js";
import { routeModel as eeRouteModel } from "../ee/bridge.js";
import { fireAndForgetPhaseOutcome } from "../ee/phase-outcome.js";
import { readArtifact } from "../flow/artifact-io.js";
import { createRun, loadRun } from "../flow/run-manager.js";
import { getModelsForProvider } from "../models/registry.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";
import { ALL_PROVIDER_IDS } from "../providers/types.js";
import { defaultResolveChannelId, maybeAutoFire } from "../reporter/auto-fire.js";
import { activeRunStore } from "../state/active-run.js";
import { logInteraction, logUIInteraction } from "../storage/index.js";
import type { ModelInfo, StreamChunk, VerifyRecipe } from "../types/index.js";
import { markIterationCrashed, readIterations, readManifest, writeManifest } from "./artifact-io.js";
import { buildBacklog } from "./backlog-builder.js";
import { readBacklog, writeBacklog } from "./backlog-store.js";
import { formatCostPreview, previewRunCost } from "./cost-preview.js";
import { extractRunToEE } from "./cross-run-memory.js";
import { buildContinueFeedback, type ContinueFeedback } from "./feedback-routing.js";
import { type DriverContext, type DriverResult, runLoopDriver } from "./loop-driver.js";
import { resolveRoles } from "./role-registry.js";
import { polishDelivery } from "./ship-polish.js";
import { applySprintAssignments, planSprints } from "./sprint-planner.js";
import { runSprint } from "./sprint-runner.js";
import { readSprintPlan, setActiveSprint, writeSprintPlan } from "./sprint-store.js";
import type { ImplementationPlanArtifact, IterationState, ProductSpec, RoleSlot } from "./types.js";

export interface ProductLoopFlags {
  maxCost: number;
  maxSprints: number;
  doneThreshold: number;
  stack?: string;
  /** P2.7: when true, always run full council debate even for low-complexity ideas. */
  forceCouncil?: boolean;
  /** If set, halt when total tokens exceed this limit. */
  budgetTokens?: number;
}

export interface ProductLoopOptions {
  /** Required for `start` — the user's idea. Ignored for other subcommands. */
  idea?: string;
  /** Required for resume/abort/ship/status<runId>. */
  runId?: string;
  /** Subcommand selector. Default = start. */
  subcommand?: "start" | "status" | "resume" | "abort" | "ship";

  flowDir: string;
  /** Session model id from the orchestrator (this.modelId). Used to resolve real council models. */
  sessionModelId: string;
  llm: CouncilLLM;
  flags: ProductLoopFlags;
  respondToQuestion: QuestionResponder;
  respondToPreflight: PreflightResponder;

  /** Optional bridges; sprint-runner uses them when present. */
  cwd?: string;
  processMessageFn?: (message: string) => AsyncGenerator<StreamChunk, void, unknown>;
  detectVerifyRecipe?: () => Promise<VerifyRecipe | null>;
  /** Test hook: pre-resolved role assignments so the harness can pin model ids. */
  roleAssignments?: Map<RoleSlot, { modelId: string; provider: string; tier?: string }>;
  /** P5: when true, skip cross-run workspace memory injection. */
  skipPriorContext?: boolean;
  /**
   * Mode C — explicit override. When "maintain", runProductLoop dispatches to
   * runMaintain (single-task PR flow). When "new", forces Mode A (greenfield)
   * even if cwd has a verify recipe. When undefined, auto-detect (verify
   * recipe present + cwd looks like an existing project → Mode C).
   * See .planning/MAINTAIN-MODE.md.
   */
  mode?: "maintain" | "new";
  /** Mode C — opt-in: run `gh pr create` after PR is built. Default false (print to stdout + write to .planning/runs/<runId>/pr.md). */
  ghPr?: boolean;
  /**
   * P2.6: Complexity decision from PIL Layer 1. When "low" and forceCouncil is
   * not set, the dispatcher routes to runHotPath (single sprint, no council debate).
   */
  complexity?: "low" | "medium" | "high";
  /**
   * Sufficiency gaps from PIL Layer 1. When non-empty, the dispatcher forces
   * the Council path regardless of complexity — vague prompts MUST go through
   * AskCard discovery before any scaffolding. Each entry seeds a discovery
   * question category (scope/target/intent).
   */
  sufficiencyMissing?: readonly import("../pil/layer1-intent.js").SufficiencyMissing[];
  /**
   * Chat session id (sessions.id) — required for interaction_logs telemetry
   * inserts to satisfy the FK constraint. The /ideal runId is NOT a valid
   * sessions.id; passing runId there silently fails FK on STRICT bun:sqlite.
   */
  sessionId?: string;
}

export interface ProductLoopResult extends DriverResult {
  /** Number of sprints actually executed (≥ 0). */
  sprintsRun?: number;
  /** Whether the run reached the shipped state (Cond #5 passed). */
  shipped?: boolean;
}

/**
 * Entry point for the Product Ideal Loop.
 *
 * Subcommands:
 *  - start (default): create run → drive FSM → run sprints → done | halted
 *  - status:  list runs (or detail one when runId provided)
 *  - resume:  re-enter the FSM from state.md, marking any in-flight sprint as crashed
 *  - abort:   write manifest aborted=true and post EE phase-outcome=aborted
 *  - ship:    skip Cond #1-#4 if already passing; force final user gate (Cond #5)
 */
export async function* runProductLoop(
  opts: ProductLoopOptions,
): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const sub = opts.subcommand ?? "start";

  switch (sub) {
    case "status":
      return yield* runStatus(opts);
    case "resume":
      return yield* runResume(opts);
    case "abort":
      return yield* runAbort(opts);
    case "ship":
      return yield* runShip(opts);
    default: {
      // Mode C dispatch — see .planning/MAINTAIN-MODE.md "Trigger mechanism".
      //   1. Explicit --maintain   → Mode C
      //   2. Explicit --new        → Mode A (current behavior, skip detection)
      //   3. Auto-detect: verify recipe present in cwd → Mode C
      //   4. Otherwise             → Mode A
      if (opts.mode === "maintain") {
        return yield* runMaintain(opts);
      }
      if (opts.mode !== "new" && opts.detectVerifyRecipe) {
        try {
          const recipe = await opts.detectVerifyRecipe();
          if (recipe) {
            return yield* runMaintain(opts);
          }
        } catch {
          // Detection failure is non-fatal — fall through to Mode A.
        }
      }

      // C1 — Existing-repo bypass. The sufficiency gate below was tuned for
      // greenfield: a vague "todo app" prompt with no folder MUST go to
      // Council so AskCard can pin productType / audience / stack before
      // any scaffolding. But when /ideal runs inside a non-empty folder,
      // those answers are derivable from the source (manifests, dirs, deps)
      // — forcing the user through 6 AskCards is the regression session
      // e2660a052918 demonstrated. Skip the sufficiency gate (and prefer
      // hot-path over full Council for medium complexity) when the cwd is
      // an existing project AND the caller hasn't explicitly forced council.
      //
      // forceCouncil=true still wins — user can opt back into the full
      // Council pipeline when they actually want it (e.g. architectural
      // change to an existing repo).
      const existingRepoBypass = await detectExistingRepoBypass(opts);
      const hasGaps = !!(opts.sufficiencyMissing && opts.sufficiencyMissing.length > 0);
      if (hasGaps && !existingRepoBypass) {
        const forcedOpts: ProductLoopOptions = {
          ...opts,
          flags: { ...opts.flags, forceCouncil: true },
        };
        return yield* runStart(forcedOpts);
      }
      // Existing repo + complexity≠high → hot-path. The leader can grep
      // the source instead of interviewing the user. Only architectural
      // changes (complexity=high) still warrant the full Council debate.
      if (existingRepoBypass && opts.complexity !== "high" && !opts.flags.forceCouncil) {
        return yield* runHotPath(opts);
      }
      if (opts.complexity === "low" && !opts.flags.forceCouncil) {
        return yield* runHotPath(opts);
      }
      return yield* runStart(opts);
    }
  }
}

/**
 * C1 — Decide whether the existing-repo bypass should fire for THIS run.
 *
 * Returns true when `cwd` contains source code or a manifest (any of:
 * package.json, Cargo.toml, go.mod, pyproject.toml, *.csproj, *.sln,
 * Directory.Build.props, or a top-level source file). False when the
 * folder is empty / probe fails — in which case the original gating
 * (Council for vague greenfield prompts) takes over.
 *
 * Sync probe, no I/O retry. `forceCouncil` overrides this gate at the
 * call site — when the user explicitly asks for Council we honor it
 * even on an existing repo (e.g. "rearchitect this codebase").
 */
async function detectExistingRepoBypass(opts: ProductLoopOptions): Promise<boolean> {
  if (opts.flags?.forceCouncil) return false;
  const cwd = opts.cwd ?? process.cwd();
  try {
    const { detectExistingProject } = await import("./discovery-detection.js");
    const det = await detectExistingProject(cwd);
    return det.classification !== "greenfield";
  } catch {
    // Detection failure is non-fatal — fall back to the original gating.
    return false;
  }
}

/**
 * P2.5 — Hot-path for complexity=low ideas.
 *
 * Skips Council debate + scoping. Goes straight from idea → single sprint → ship.
 * extractRunToEE still fires so cross-run memory continues to build.
 */
async function* runHotPath(opts: ProductLoopOptions): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const { idea, flowDir, flags } = opts;
  if (!idea?.trim()) {
    yield { type: "content", content: "error: /ideal start requires an idea" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_idea" };
  }

  const runState = await createRun(flowDir);
  const runId = runState.id;

  await writeManifest(flowDir, runId, {
    idea,
    capUsd: flags.maxCost,
    maxSprints: 1, // hot-path always caps at 1 sprint
    doneThreshold: flags.doneThreshold,
    stack: flags.stack,
    createdAt: new Date(),
  });

  if (opts.cwd) {
    try {
      const { isGsdNativeEnabled } = await import("../gsd/flags.js");
      if (isGsdNativeEnabled()) {
        const { ensureProductPlanningWorkspace } = await import("../gsd/product-workspace.js");
        ensureProductPlanningWorkspace(opts.cwd, {
          idea,
          sessionModelId: opts.sessionModelId,
          runId,
        });
      }
    } catch (err) {
      console.error(`[ideal/hot-path] gsd product workspace bootstrap failed: ${(err as Error).message}`);
    }
  }

  yield {
    type: "content",
    content: "\n> hot-path: complexity=low → single sprint, no council debate\n",
  } as StreamChunk;

  // Emit route-decision harness event (agent-mode only; no-op otherwise).
  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({
      t: "event",
      kind: "route-decision",
      path: "hot-path",
      complexity: opts.complexity ?? "low",
      forceCouncil: false,
      runId,
    });
  } catch {
    /* best-effort */
  }

  // Telemetry: log routing decision.
  try {
    logInteraction(opts.sessionId ?? runId, "routing", {
      eventSubtype: "ideal_hot_path",
      data: { complexity: "low", forceCouncil: false },
    });
  } catch {
    // DB errors must not break /ideal
  }
  logUIInteraction(opts.sessionId, {
    subtype: "route_decision",
    data: { path: "hot-path", complexity: opts.complexity ?? "low", forceCouncil: false, runId },
  });

  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({
      t: "event",
      kind: "sprint-plan-committed",
      runId,
      projectDir: opts.cwd ?? null,
      sprintCount: 1,
      sprintIds: ["sprint-1"],
      source: "auto",
      ts: Date.now(),
    });
  } catch {
    /* best-effort */
  }

  // B1: update active-run store; B2: auto-fire plan committed.
  try {
    const { productSlug: deriveSlug } = await import("./product-identity.js");
    const slug = deriveSlug(idea);
    activeRunStore.setActiveRun(runId, flowDir, slug);
    fireAutoReport("sprint-plan-committed", { runId, flowDir, productSlug: slug, sprintCount: 1 });
  } catch {
    /* best-effort */
  }

  // Build a minimal ProductSpec inline (no LLM calls needed for the hot-path).
  const productSpec: ProductSpec = {
    idea,
    persona: "users",
    mvp: [],
    phase2: [],
    architecture: "",
    ioContract: "",
    folderStructure: "",
    sprintEstimate: 1,
    costEstimate: 1,
    stack: flags.stack,
    createdAt: new Date(),
  };

  const ctx: DriverContext = {
    runId,
    flowDir,
    idea,
    sessionModelId: opts.sessionModelId,
    llm: opts.llm,
    flags,
    respondToQuestion: opts.respondToQuestion,
    respondToPreflight: opts.respondToPreflight,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    processMessageFn: opts.processMessageFn,
    detectVerifyRecipe: opts.detectVerifyRecipe,
    skipPriorContext: opts.skipPriorContext,
    sufficiencyMissing: opts.sufficiencyMissing,
  };

  const roleAssignments = opts.roleAssignments ?? (await resolveRoleAssignments(opts.sessionModelId));

  // Run a single sprint (maxSprints=1 enforced regardless of opts.flags.maxSprints).
  let iter: import("./types.js").IterationState;
  try {
    const sprintGen = runSprint({
      sprintN: 1,
      ctx,
      productSpec,
      roleAssignments,
      history: [],
    });
    let result: import("./types.js").IterationState | undefined;
    while (true) {
      const step = await sprintGen.next();
      if (step.done) {
        result = step.value as import("./types.js").IterationState;
        break;
      }
      // Site 1 — forward halt chunk to UI, mark stage halted, stop iteration.
      if (step.value && (step.value as StreamChunk).type === "halt") {
        yield step.value as StreamChunk;
        const manifest = await readManifest(flowDir, runId);
        const haltReason = (step.value as StreamChunk).haltChunk?.reason ?? "no_recipe";
        if (manifest) {
          await writeManifest(flowDir, runId, {
            ...manifest,
            verdict: { pass: false, score: 0, reason: haltReason, failedCondition: undefined as any },
          });
        }
        return { runId, stage: "halted", success: false, reason: haltReason, sprintsRun: 0 };
      }
      yield step.value as StreamChunk;
    }
    iter = result!;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: "content", content: `\n> Sprint 1 halted: ${msg}\n` } as StreamChunk;
    const manifest = await readManifest(flowDir, runId);
    if (manifest) {
      await writeManifest(flowDir, runId, {
        ...manifest,
        verdict: { pass: false, score: 0, reason: msg, failedCondition: undefined as any },
      });
    }
    return { runId, stage: "halted", success: false, reason: msg, sprintsRun: 0 };
  }

  if (iter.stage !== "shipped") {
    return {
      runId,
      stage: "halted",
      success: false,
      reason: iter.lastVerifyResult ?? "sprint_not_shipped",
      sprintsRun: 1,
    };
  }

  // Sprint shipped — write final manifest.
  const manifest = await readManifest(flowDir, runId);
  if (manifest) {
    await writeManifest(flowDir, runId, {
      ...manifest,
      doneAt: new Date(),
      verdict: {
        pass: true,
        score: iter.scoreAfter,
        failedCondition: undefined as any,
        reason: "all_conditions_met",
      },
    });
  }

  // Delivery polish.
  if (opts.cwd) {
    try {
      const polish = await polishDelivery({
        cwd: opts.cwd,
        runDir: path.join(flowDir, "runs", runId),
        productSpec,
        runId,
      });
      if (polish.notes.length > 0) {
        yield {
          type: "content",
          content: `\n**Delivery polish:**\n${polish.notes.map((n) => `- ${n}`).join("\n")}\n`,
        } as StreamChunk;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "content", content: `\n_Delivery polish skipped: ${msg}_\n` } as StreamChunk;
    }
  }

  // P1.3: extract run artifacts to EE for cross-run memory.
  if (opts.cwd) {
    const eeResult = await extractRunToEE(flowDir, runId, opts.cwd);
    try {
      logInteraction(opts.sessionId ?? runId, "ee_injection", {
        eventSubtype: "extract",
        durationMs: Math.round(eeResult.durationMs),
        data: {
          ok: eeResult.ok,
          mistakes: eeResult.mistakes ?? null,
          stored: eeResult.stored ?? null,
        },
      });
    } catch {
      // DB errors must not break /ideal
    }
  }

  return { runId, stage: "approved", success: true, reason: "shipped", sprintsRun: 1, shipped: true };
}

/**
 * Heuristic kind detection from the user's idea text. Avoids hardcoding "bug"
 * for everything — keyword-anchored, falls back to "feature" because most
 * "/ideal foo" prompts are additive, not bug fixes.
 */
export function detectMaintenanceKind(idea: string): "bug" | "feature" | "refactor" | "chore" | "docs" {
  const lower = idea.toLowerCase();
  if (/\b(fix|bug|broken|crash|error|fail|regression|hotfix|patch)\b/.test(lower)) return "bug";
  if (/\b(refactor|cleanup|reorganize|rename|split|extract|consolidat)/.test(lower)) return "refactor";
  if (/\b(docs?|documentation|readme|comment|jsdoc|tsdoc)\b/.test(lower)) return "docs";
  if (/\b(chore|cleanup|upgrade|bump|deps?|dependency|dependencies|lint|format)\b/.test(lower)) return "chore";
  return "feature";
}

/**
 * Build default acceptance criteria for Mode C tasks. Lifts heuristics from the
 * idea so the judge has something to evaluate against beyond "verify passes".
 */
export function buildDefaultAcceptanceCriteria(idea: string): string[] {
  const criteria: string[] = ["Existing verify recipe passes after edits"];
  const lower = idea.toLowerCase();
  if (/\b(test|spec|coverage)\b/.test(lower)) {
    criteria.push("New behavior is covered by at least one test");
  }
  if (/\b(no regression|don'?t break|without break|breaking|preserve|backward)/.test(lower)) {
    criteria.push("No regression in existing test suite");
  }
  if (/\b(error|exception|null|undefined|crash)\b/.test(lower)) {
    criteria.push("Error path is handled explicitly (no silent swallowing)");
  }
  return criteria;
}

/**
 * Mode C — single-task maintenance flow.
 *
 * Skeleton wiring per .planning/MAINTAIN-MODE.md. Builds a basic
 * MaintenanceTask from the user's idea (no clarify questions yet — P17
 * follow-up), gathers codebase intel, runs the 5-stage task cycle,
 * builds a PR, optionally invokes `gh pr create`.
 */
async function* runMaintain(opts: ProductLoopOptions): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const { idea, flowDir, llm, flags, cwd, processMessageFn, detectVerifyRecipe, respondToPreflight, sessionModelId } =
    opts;
  if (!idea?.trim()) {
    yield { type: "content", content: "error: /ideal maintain requires a task description" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_idea" };
  }
  if (!cwd || !processMessageFn || !detectVerifyRecipe) {
    yield {
      type: "content",
      content: "error: Mode C requires cwd, processMessageFn, and detectVerifyRecipe bridges",
    } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_bridges" };
  }

  const { gatherCodebaseIntel, runMaintenanceTask, buildPr, ghCreatePr } = await import("../maintain/index.js");
  const { randomUUID } = await import("node:crypto");
  const { promises: fsp } = await import("node:fs");
  const pathMod = await import("node:path");

  const runState = await createRun(flowDir);
  const runId = runState.id;

  await writeManifest(flowDir, runId, {
    idea,
    capUsd: flags.maxCost,
    maxSprints: 1,
    doneThreshold: flags.doneThreshold,
    stack: flags.stack,
    createdAt: new Date(),
  });

  yield { type: "content", content: "\n> Mode C: single-task maintenance flow\n" } as StreamChunk;

  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({
      t: "event",
      kind: "route-decision",
      path: "maintain",
      complexity: opts.complexity ?? "unknown",
      forceCouncil: false,
      runId,
    });
  } catch {
    /* best-effort */
  }
  try {
    logInteraction(opts.sessionId ?? runId, "routing", {
      eventSubtype: "ideal_maintain",
      data: { mode: "maintain", explicit: opts.mode === "maintain" },
    });
  } catch {
    /* DB errors must not break /ideal */
  }
  logUIInteraction(opts.sessionId, {
    subtype: "route_decision",
    data: { path: "maintain", complexity: opts.complexity ?? "unknown", forceCouncil: false, runId },
  });

  const taskId = randomUUID();
  const nowIso = new Date().toISOString();
  const task = {
    id: taskId,
    kind: detectMaintenanceKind(idea),
    title: idea.split("\n")[0]!.slice(0, 120),
    description: idea,
    acceptance_criteria: buildDefaultAcceptanceCriteria(idea),
    candidateFiles: [] as string[],
    impactRadius: [] as string[],
    regressionTestFiles: [] as string[],
    status: "queued" as const,
    createdAtUtc: nowIso,
    updatedAtUtc: nowIso,
  };

  yield { type: "content", content: "\n> Gathering codebase intel...\n" } as StreamChunk;
  const intel = await gatherCodebaseIntel({ cwd, task });

  // Populate task with intel-derived fields so the runner + PR body have them.
  task.candidateFiles = intel.candidateFiles.map((c) => c.path);
  task.impactRadius = intel.impactRadius;
  task.regressionTestFiles = intel.regressionTests;

  const ctx = {
    runId,
    sessionId: opts.sessionId,
    cwd,
    llm: {
      generate: (modelId: string, system: string, prompt: string, maxTokens?: number) =>
        llm.generate(modelId, system, prompt, maxTokens),
    },
    processMessageFn,
    detectVerifyRecipe,
    respondToPreflight,
  };

  const taskResult = yield* runMaintenanceTask({
    task,
    codebaseIntel: intel,
    ctx,
    leaderModelId: sessionModelId,
    costAware: true,
  });

  if (taskResult.status !== "done") {
    yield {
      type: "content",
      content: `\n> Mode C halted at status=${taskResult.status}: ${taskResult.failureReason ?? "unknown"}\n`,
    } as StreamChunk;
    return { runId, stage: "halted", success: false, reason: taskResult.failureReason ?? taskResult.status };
  }

  yield { type: "content", content: "\n> Building PR artifact...\n" } as StreamChunk;
  let pr: Awaited<ReturnType<typeof buildPr>>;
  try {
    pr = await buildPr({
      task,
      codebaseIntel: intel,
      result: taskResult,
      cwd,
      leaderModelId: sessionModelId,
      costAware: true,
      llm: { generate: ctx.llm.generate },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: "content", content: `\n> PR build failed: ${msg}\n` } as StreamChunk;
    return { runId, stage: "halted", success: false, reason: `pr_build_failed: ${msg}` };
  }

  // Always persist PR artifact for the user to review.
  const prMdPath = pathMod.join(flowDir, "runs", runId, "pr.md");
  try {
    await fsp.mkdir(pathMod.dirname(prMdPath), { recursive: true });
    const persistBody = `# ${pr.title}\n\nBranch: \`${pr.branch}\`\n\n${pr.body}\n\n---\n\n\`\`\`diff\n${pr.diff}\n\`\`\`\n`;
    await fsp.writeFile(prMdPath, persistBody, "utf8");
  } catch {
    /* non-fatal */
  }

  yield {
    type: "content",
    content: `\n## PR ready: ${pr.title}\nBranch: \`${pr.branch}\`\nFiles changed: ${pr.changedFiles.length}${
      pr.filesOutsideRadius.length > 0 ? ` (${pr.filesOutsideRadius.length} outside declared radius)` : ""
    }\nArtifact: \`${prMdPath}\`\n\n${pr.body}\n`,
  } as StreamChunk;

  if (opts.ghPr) {
    yield { type: "content", content: "\n> Creating PR via gh CLI...\n" } as StreamChunk;
    const ghResult = await ghCreatePr({ branch: pr.branch, title: pr.title, body: pr.body, cwd });
    if (ghResult.ok && ghResult.url) {
      yield { type: "content", content: `\n> PR created: ${ghResult.url}\n` } as StreamChunk;
    } else {
      yield {
        type: "content",
        content: `\n> gh pr create skipped/failed: ${ghResult.reason ?? "unknown"}\n`,
      } as StreamChunk;
    }
  }

  return { runId, stage: "approved", success: true, reason: "pr_ready", sprintsRun: 1, shipped: true };
}

/** start: createRun → loop-driver (gather/research/scoping) → sprint loop → done|halted. */
async function* runStart(opts: ProductLoopOptions): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const { idea, flowDir, llm, flags, respondToQuestion, respondToPreflight } = opts;
  if (!idea?.trim()) {
    yield { type: "content", content: "error: /ideal start requires an idea" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_idea" };
  }

  const runState = await createRun(flowDir);
  const runId = runState.id;

  await writeManifest(flowDir, runId, {
    idea,
    capUsd: flags.maxCost,
    maxSprints: flags.maxSprints,
    doneThreshold: flags.doneThreshold,
    stack: flags.stack,
    createdAt: new Date(),
  });

  if (opts.cwd) {
    try {
      const { isGsdNativeEnabled } = await import("../gsd/flags.js");
      if (isGsdNativeEnabled()) {
        const { ensureProductPlanningWorkspace } = await import("../gsd/product-workspace.js");
        ensureProductPlanningWorkspace(opts.cwd, {
          idea,
          sessionModelId: opts.sessionModelId,
          runId,
        });
      }
    } catch (err) {
      console.error(`[ideal] gsd product workspace bootstrap failed: ${(err as Error).message}`);
    }
  }

  // Surface a cost-vs-cap preview before the loop kicks off so $50 isn't
  // an arbitrary number — show predicted spend per sprint × max-sprints
  // against the configured cap, with a recommended max-sprints if it
  // would exceed. Falls back gracefully for unknown-pricing models.
  const preview = previewRunCost({
    sessionModelId: opts.sessionModelId,
    maxSprints: flags.maxSprints,
    capUsd: flags.maxCost,
  });
  yield { type: "content", content: `\n${formatCostPreview(preview)}\n` } as StreamChunk;

  // Emit route-decision harness event (agent-mode only; no-op otherwise).
  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({
      t: "event",
      kind: "route-decision",
      path: "council",
      complexity: opts.complexity ?? "unknown",
      forceCouncil: !!opts.flags.forceCouncil,
      sufficiencyMissing: opts.sufficiencyMissing ?? [],
      runId,
    });
  } catch {
    /* best-effort */
  }
  logUIInteraction(opts.sessionId, {
    subtype: "route_decision",
    data: {
      path: "council",
      complexity: opts.complexity ?? "unknown",
      forceCouncil: !!opts.flags.forceCouncil,
      sufficiencyMissing: opts.sufficiencyMissing ?? [],
      runId,
    },
  });

  const ctx: DriverContext = {
    runId,
    flowDir,
    idea,
    sessionModelId: opts.sessionModelId,
    llm,
    flags,
    respondToQuestion,
    respondToPreflight,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    processMessageFn: opts.processMessageFn,
    detectVerifyRecipe: opts.detectVerifyRecipe,
    skipPriorContext: opts.skipPriorContext,
    sufficiencyMissing: opts.sufficiencyMissing,
  };

  // Phase 1: outer FSM (gather → research → scoping → approved | halted).
  const driverGen = runLoopDriver(ctx);
  let driverResult: DriverResult | undefined;
  try {
    while (true) {
      const { value, done } = await driverGen.next();
      if (done) {
        driverResult = value as DriverResult;
        break;
      }
      yield value as StreamChunk;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Persist the halt/crash so forensics can surface it via `usage forensics`.
    // Circuit-breaker rejections (CB-1 cost-projection in sprint-runner) are
    // the common case — they previously vanished into the TUI scrollback only.
    try {
      const sid = opts.sessionId ?? runId;
      const isCB = msg.startsWith("Halted by circuit breaker");
      logInteraction(sid, "council", {
        eventSubtype: isCB ? "sprint_halt" : "loop_error",
        data: {
          runId,
          stage: "driver",
          reason: msg.slice(0, 2000),
          isCircuitBreaker: isCB,
        },
      });
    } catch {
      /* best-effort */
    }
    yield { type: "error", error: true, content: msg } as any;
    return { runId, stage: "error", success: false, reason: msg };
  }

  if (!driverResult?.success || driverResult.stage !== "approved") {
    return { ...driverResult!, runId };
  }

  // Phase 2: sprint loop until done or halted.
  const productSpec = await loadProductSpec(flowDir, runId, idea, opts.flags.stack);
  const roleAssignments = opts.roleAssignments ?? (await resolveRoleAssignments(opts.sessionModelId));

  // A2: Build Backlog + Sprint Plan before entering the sprint loop.
  // Idempotent — skips if backlog.json / sprint-plan.json already exist (resume safety).
  const { sprintCount, sprintIds } = await buildBacklogAndSprintPlan({
    flowDir,
    runId,
    productSpec,
    ctx,
    sessionModelId: opts.sessionModelId,
    maxSprints: flags.maxSprints,
    onChunk: (chunk) => void chunk, // chunks yielded below via the emit event
  });

  // Yield a brief confirmation chunk so the user sees the committed plan.
  yield {
    type: "content",
    content: `\n> Committed: ${sprintCount} sprint${sprintCount === 1 ? "" : "s"} planned. Sprint 1 active.\n`,
  } as StreamChunk;

  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({
      t: "event",
      kind: "sprint-plan-committed",
      runId,
      projectDir: opts.cwd ?? null,
      sprintCount,
      sprintIds,
      source: "council",
      ts: Date.now(),
    });
  } catch {
    /* best-effort */
  }

  // B1: update active-run store so StatusBar shows sprint progress.
  // B2: auto-fire "run started" to Discord when configured.
  try {
    const { productSlug: deriveSlug } = await import("./product-identity.js");
    const slug = deriveSlug(idea);
    activeRunStore.setActiveRun(runId, flowDir, slug);
    fireAutoReport("sprint-plan-committed", { runId, flowDir, productSlug: slug, sprintCount });
  } catch {
    /* best-effort — never break /ideal over status bar or reporter */
  }

  // Subsystem E: phase-orchestrated path (default ON; set MUONROI_PHASE_MODE=0 for legacy).
  if (process.env.MUONROI_PHASE_MODE !== "0") {
    const phaseResult = yield* runPhasesPath({ ctx, productSpec, roleAssignments });
    if (phaseResult !== null) return phaseResult;
    // phaseResult === null means runPhases prerequisites were unavailable; fall through to legacy.
  }

  return yield* drainSprints({
    ctx,
    productSpec,
    roleAssignments,
    history: [],
    flags,
  });
}

/**
 * A2 — Build Backlog + Sprint Plan after the council debate has produced a ProductSpec.
 *
 * Idempotent: skips if backlog.json / sprint-plan.json already exist on disk
 * (safe for resume flows that re-enter runStart after a crash).
 *
 * Returns the sprintCount + sprintIds that were committed (new or pre-existing),
 * for use in the sprint-plan-committed harness event.
 *
 * Model selection: delegates to backlog-builder.ts + sprint-planner.ts which both
 * use pickCouncilTaskModel — NO hardcoded model ids here.
 */
async function buildBacklogAndSprintPlan(args: {
  flowDir: string;
  runId: string;
  productSpec: ProductSpec;
  ctx: DriverContext;
  sessionModelId: string;
  maxSprints: number;
  onChunk: (chunk: StreamChunk) => void;
}): Promise<{ sprintCount: number; sprintIds: string[] }> {
  const { flowDir, runId, productSpec, ctx, sessionModelId, maxSprints } = args;

  // ── Check idempotency ──────────────────────────────────────────────────────
  const existingBacklog = await readBacklog(flowDir, runId).catch(() => null);
  const existingPlan = await readSprintPlan(flowDir, runId).catch(() => null);

  if (existingBacklog && existingPlan) {
    // Already built — return existing sprint ids for the harness event.
    const ids = existingPlan.sprints.map((s) => s.id);
    return { sprintCount: ids.length, sprintIds: ids };
  }

  // ── Derive ImplementationPlanArtifact from ProductSpec ────────────────────
  // ProductSpec.mvp is a string[] of feature titles. Map each to a mvp_definition
  // entry. This avoids an extra LLM call — the council debate has already produced
  // the plan text; we just need to structure it for the backlog builder.
  const implementationPlan: ImplementationPlanArtifact = {
    mvp_definition: productSpec.mvp.map((feature) => ({
      feature,
      included_in_v1: "yes" as const,
    })),
    acceptance_criteria: [], // council debate artifacts are in delegations.md; keep empty here
    entities: [],
    endpoints: [],
  };

  const leaderModelId = resolveLeaderModel(sessionModelId);

  // ── Build Backlog ──────────────────────────────────────────────────────────
  let backlog = existingBacklog;
  if (!backlog) {
    try {
      // Build ClarifiedSpec from persisted project context (written by loop-driver).
      const { readProjectContext } = await import("./discovery-persistence.js");
      const { clarifiedSpecFromContext } = await import("./gather.js");
      const projectContext = await readProjectContext(flowDir, runId);
      const clarifiedSpec = projectContext
        ? clarifiedSpecFromContext(projectContext)
        : {
            problemStatement: productSpec.idea,
            constraints: [],
            successCriteria: productSpec.mvp,
            scope: productSpec.idea,
            rawQA: [],
            resolved: {} as Record<string, "answered" | "unspecified" | "skipped">,
          };

      backlog = await buildBacklog({
        runId,
        productSlug: productSpec.idea.slice(0, 40).replace(/\s+/g, "-").toLowerCase(),
        spec: clarifiedSpec,
        implementationPlan,
        llm: ctx.llm,
        leaderModelId,
        costAware: true,
      });
      await writeBacklog(flowDir, runId, backlog);
    } catch (err) {
      // Non-fatal: sprint-runner has a backlog fallback (backlogAnchor="" when null).
      const msg = err instanceof Error ? err.message : String(err);
      args.onChunk({ type: "content", content: `\n> [backlog] Build skipped: ${msg}\n` } as StreamChunk);
      // Return a synthetic single-sprint plan so the harness event fires correctly.
      const sprintIds = Array.from({ length: maxSprints }, (_, i) => `sprint-${i + 1}`);
      return { sprintCount: maxSprints, sprintIds };
    }
  }

  // ── Plan Sprints ───────────────────────────────────────────────────────────
  let plan = existingPlan;
  if (!plan) {
    try {
      plan = await planSprints({
        runId,
        backlog,
        llm: ctx.llm,
        leaderModelId,
        costAware: true,
        targetEffortPerSprint: 8,
      });
      await writeSprintPlan(flowDir, runId, plan);
      // Update each BacklogItem with status="in_sprint" + assigned_sprint.
      await applySprintAssignments(flowDir, runId, plan);
    } catch (err) {
      // Non-fatal: build a synthetic plan from maxSprints.
      const msg = err instanceof Error ? err.message : String(err);
      args.onChunk({ type: "content", content: `\n> [sprint-plan] Build skipped: ${msg}\n` } as StreamChunk);
      const sprintIds = Array.from({ length: maxSprints }, (_, i) => `sprint-${i + 1}`);
      return { sprintCount: maxSprints, sprintIds };
    }
  }

  // ── Set Sprint 1 Active ────────────────────────────────────────────────────
  if (plan.sprints.length > 0 && !plan.activeSprintId) {
    try {
      const firstSprintId = plan.sprints[0]!.id;
      await setActiveSprint(flowDir, runId, firstSprintId);
    } catch {
      /* non-fatal */
    }
  }

  const ids = plan.sprints.map((s) => s.id);
  return {
    sprintCount: ids.length || maxSprints,
    sprintIds: ids.length > 0 ? ids : Array.from({ length: maxSprints }, (_, i) => `sprint-${i + 1}`),
  };
}

/** Drive sprint-runner repeatedly, honoring max-sprints and continue-feedback routing. */
async function* drainSprints(args: {
  ctx: DriverContext;
  productSpec: ProductSpec;
  roleAssignments: Map<RoleSlot, { modelId: string; provider: string; tier?: string }>;
  history: IterationState[];
  flags: ProductLoopFlags;
}): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const { ctx, productSpec, roleAssignments, flags } = args;
  const history = args.history.slice();
  let carryOver: ContinueFeedback | undefined;
  let sprintsRun = 0;

  for (let sprintN = history.length + 1; sprintN <= flags.maxSprints; sprintN++) {
    let iter: IterationState;
    // Check token budget
    if (flags.budgetTokens) {
      const { getProductTotalTokens } = await import("../usage/product-ledger.js");
      const totalTokens = await getProductTotalTokens(ctx.runId);
      if (totalTokens > flags.budgetTokens) {
        yield {
          type: "halt",
          haltChunk: {
            type: "halt",
            reason: "budget_exhausted",
            detail: `Token budget exceeded: used ${totalTokens} > limit ${flags.budgetTokens}`,
            recovery_options: [],
          },
        } as StreamChunk;
        return { runId: ctx.runId, stage: "halted", success: false, reason: "budget exhausted" };
      }
    }
    try {
      const sprintGen = runSprint({
        sprintN,
        ctx,
        productSpec,
        roleAssignments,
        history,
        carryOver,
      });
      let result: IterationState | undefined;
      while (true) {
        const step = await sprintGen.next();
        if (step.done) {
          result = step.value as IterationState;
          break;
        }
        // Site 2 — forward halt chunk to UI, mark stage halted, stop iteration.
        if (step.value && (step.value as StreamChunk).type === "halt") {
          yield step.value as StreamChunk;
          const haltReason = (step.value as StreamChunk).haltChunk?.reason ?? "no_recipe";
          const manifest = await readManifest(ctx.flowDir, ctx.runId);
          if (manifest) {
            await writeManifest(ctx.flowDir, ctx.runId, {
              ...manifest,
              verdict: { pass: false, score: 0, reason: haltReason, failedCondition: undefined as any },
            });
          }
          // B2: auto-fire halt notification; B1: clear active-run.
          try {
            const { productSlug: deriveSlug } = await import("./product-identity.js");
            const slug = deriveSlug(productSpec.idea);
            fireAutoReport("sprint-halt", { runId: ctx.runId, flowDir: ctx.flowDir, productSlug: slug, haltReason });
            activeRunStore.clearActiveRun();
          } catch {
            /* best-effort */
          }
          return {
            runId: ctx.runId,
            stage: "halted",
            success: false,
            reason: haltReason,
            sprintsRun,
          };
        }
        yield step.value as StreamChunk;
      }
      iter = result!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "content", content: `\n> Sprint ${sprintN} halted: ${msg}\n` } as StreamChunk;
      // Persist the sprint halt so forensics replay surfaces it. CB-1 cost
      // projection breaches (`Halted by circuit breaker: …`) are by far the
      // common case and they previously vanished into TUI scrollback only.
      try {
        const sid = ctx.sessionId ?? ctx.runId;
        const isCB = msg.startsWith("Halted by circuit breaker");
        logInteraction(sid, "council", {
          eventSubtype: "sprint_halt",
          data: {
            runId: ctx.runId,
            sprintN,
            stage: "sprint",
            reason: msg.slice(0, 2000),
            isCircuitBreaker: isCB,
            sprintsRun,
          },
        });
      } catch {
        /* best-effort */
      }
      // Mark manifest as halted (not aborted) so resume can pick up.
      const manifest = await readManifest(ctx.flowDir, ctx.runId);
      if (manifest) {
        await writeManifest(ctx.flowDir, ctx.runId, {
          ...manifest,
          verdict: { pass: false, score: 0, reason: msg, failedCondition: undefined as any },
        });
      }
      // B2: auto-fire halt notification; B1: clear active-run.
      try {
        const { productSlug: deriveSlug } = await import("./product-identity.js");
        const slug = deriveSlug(productSpec.idea);
        fireAutoReport("sprint-halt", { runId: ctx.runId, flowDir: ctx.flowDir, productSlug: slug, haltReason: msg });
        activeRunStore.clearActiveRun();
      } catch {
        /* best-effort */
      }
      return {
        runId: ctx.runId,
        stage: "halted",
        success: false,
        reason: msg,
        sprintsRun,
      };
    }

    history.push(iter);
    sprintsRun++;

    // B2: auto-fire sprint-done when judgment stage completes.
    // Compute overall pct from current iteration state.
    try {
      const { productSlug: deriveSlug } = await import("./product-identity.js");
      const slug = deriveSlug(productSpec.idea);
      // Compute overall completion pct across all sprints (rough estimate from criteria).
      const totalCriteria = (iter.criteriaMet ?? 0) + (iter.criteriaPartial ?? 0) + (iter.criteriaUnmet ?? 0);
      const overallPct = totalCriteria > 0 ? Math.round(((iter.criteriaMet ?? 0) / totalCriteria) * 1000) / 10 : 0;
      const verdict = iter.lastVerifyResult === "PASS" ? "pass" : "fail";
      fireAutoReport("sprint-done", {
        runId: ctx.runId,
        flowDir: ctx.flowDir,
        productSlug: slug,
        sprintN,
        pct: overallPct,
        verdict,
      });
    } catch {
      /* best-effort */
    }

    if (iter.stage === "shipped") {
      // Final manifest update + EE pass outcome
      const manifest = await readManifest(ctx.flowDir, ctx.runId);
      if (manifest) {
        await writeManifest(ctx.flowDir, ctx.runId, {
          ...manifest,
          doneAt: new Date(),
          verdict: {
            pass: true,
            score: iter.scoreAfter,
            failedCondition: undefined as any,
            reason: "all_conditions_met",
          },
        });
      }
      // Ship-time delivery polish: scaffold README, fill package.json
      // metadata, write delivery-notes. Idempotent + non-destructive.
      if (ctx.cwd) {
        try {
          const polish = await polishDelivery({
            cwd: ctx.cwd,
            runDir: path.join(ctx.flowDir, "runs", ctx.runId),
            productSpec,
            runId: ctx.runId,
          });
          if (polish.notes.length > 0) {
            yield {
              type: "content",
              content: `\n**Delivery polish:**\n${polish.notes.map((n) => `- ${n}`).join("\n")}\n`,
            } as StreamChunk;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          yield { type: "content", content: `\n_Delivery polish skipped: ${msg}_\n` } as StreamChunk;
        }
      }
      // P1.3: extract run artifacts to EE for cross-run memory. Non-fatal —
      // EE client absorbs failures into the offline queue.
      // P1.6: log telemetry for the extract outcome.
      if (ctx.cwd) {
        const eeResult = await extractRunToEE(ctx.flowDir, ctx.runId, ctx.cwd);
        try {
          logInteraction(ctx.sessionId ?? ctx.runId, "ee_injection", {
            eventSubtype: "extract",
            durationMs: Math.round(eeResult.durationMs),
            data: {
              ok: eeResult.ok,
              mistakes: eeResult.mistakes ?? null,
              stored: eeResult.stored ?? null,
            },
          });
        } catch {
          // DB errors must not break /ideal
        }
      }
      // B1: clear active-run on successful ship.
      activeRunStore.clearActiveRun();
      return {
        runId: ctx.runId,
        stage: "approved",
        success: true,
        reason: "shipped",
        sprintsRun,
        shipped: true,
      };
    }

    // Build continue-feedback for next iteration. The DoneVerdict is not
    // surfaced from sprint-runner directly, but the iteration state encodes
    // enough — derive a synthetic verdict from criteria counts.
    carryOver = {
      focus:
        iter.lastVerifyResult === "PASS"
          ? `improve criteria coverage: met=${iter.criteriaMet}, partial=${iter.criteriaPartial}, unmet=${iter.criteriaUnmet}`
          : `fix verify failures (last result: ${iter.lastVerifyResult})`,
    };
  }

  yield {
    type: "content",
    content: `\n> Reached max-sprints (${flags.maxSprints}) without satisfying Definition-of-Done.\n`,
  } as StreamChunk;
  // B1: clear active-run when max-sprints reached.
  activeRunStore.clearActiveRun();
  return {
    runId: ctx.runId,
    stage: "halted",
    success: false,
    reason: "max_sprints_reached",
    sprintsRun,
  };
}

function chatEnvConfig(): { client: import("../chat/types.js").ChatClient } | null {
  // Lazy load to avoid circular imports
  const { readChatProvider } = require("../chat/factory.js") as typeof import("../chat/factory.js");
  const client = readChatProvider();
  return client ? { client } : null;
}

/**
 * Best-effort auto-fire helper (B2).
 * Fires-and-forgets a reporter event; never throws.
 * Only does I/O when a Discord client is configured AND reporter.autoFire=true.
 */
function fireAutoReport(
  kind: import("../reporter/auto-fire.js").AutoFireEvent["kind"],
  opts: {
    runId: string;
    flowDir: string;
    productSlug: string;
    sprintN?: number;
    pct?: number;
    verdict?: "pass" | "fail";
    haltReason?: string;
    sprintCount?: number;
  },
): void {
  const chatCfg = chatEnvConfig();
  if (!chatCfg) return;
  void maybeAutoFire(
    {
      kind,
      runId: opts.runId,
      flowDir: opts.flowDir,
      productSlug: opts.productSlug,
      sprintN: opts.sprintN,
      pct: opts.pct,
      verdict: opts.verdict,
      haltReason: opts.haltReason,
      sprintCount: opts.sprintCount,
    },
    {
      chat: chatCfg.client,
      resolveChannelId: defaultResolveChannelId,
    },
  );
}

/**
 * Phase-orchestrated sprint path (Subsystem E).
 *
 * Returns a ProductLoopResult when it ran to completion (pass or abort),
 * or null when prerequisites were unavailable (no projectContext) so the
 * caller can fall through to the legacy drainSprints path.
 *
 * Gated behind MUONROI_PHASE_MODE !== "0" by both callers (runStart / runResume).
 */
async function* runPhasesPath(args: {
  ctx: DriverContext;
  productSpec: ProductSpec;
  roleAssignments: Map<RoleSlot, { modelId: string; provider: string; tier?: string }>;
}): AsyncGenerator<StreamChunk, ProductLoopResult | null, unknown> {
  const { ctx, productSpec, roleAssignments } = args;

  // Load prerequisites: projectContext and manifest.
  const { readProjectContext } = await import("./discovery-persistence.js");
  const { getProductSpentUsd } = await import("../usage/product-ledger.js");
  const { runPhases } = await import("./phase-runner.js");

  const projectContext = await readProjectContext(ctx.flowDir, ctx.runId);
  const manifest = await readManifest(ctx.flowDir, ctx.runId);

  if (!projectContext || !manifest) {
    // Prerequisites unavailable — signal fall-through to legacy path.
    yield {
      type: "content",
      content: "\n> [phase-mode] projectContext or manifest unavailable — falling back to legacy sprint loop.\n",
    } as StreamChunk;
    return null;
  }

  // Build a ClarifiedSpec from the stored projectContext.
  const { clarifiedSpecFromContext } = await import("./gather.js");
  const clarifiedSpec = clarifiedSpecFromContext(projectContext);

  // Resolve leader model id and build a LeaderLike adapter over ctx.llm.
  const leaderModelId = resolveLeaderModel(ctx.sessionModelId);
  const leader = {
    generate: (leaderArgs: { system: string; prompt: string; maxTokens: number }) =>
      ctx.llm.generate(leaderModelId, leaderArgs.system, leaderArgs.prompt).then((text) => ({
        content: text,
        costUsd: 0,
      })),
  };

  // Build the sprintRunner adapter: runPhases passes { sprintN, phaseId, conversationContext, phaseScope }
  // while runSprint expects the full RunSprintArgs shape.
  // History is accumulated per-phase so circuit-breaker CB-2 (oscillation detection)
  // and carry-over between sprints within a phase work correctly.
  let currentPhaseId: string | null = null;
  let sprintHistory: IterationState[] = [];

  const sprintRunner = async function* (sprintCtx: unknown) {
    const sc = sprintCtx as {
      sprintN: number;
      phaseId?: string;
      conversationContext?: string;
      phaseScope?: { criteria: string[]; scope: string };
    };

    // Reset history when a new phase begins.
    if ((sc.phaseId ?? null) !== currentPhaseId) {
      currentPhaseId = sc.phaseId ?? null;
      sprintHistory = [];
    }

    const inner = runSprint({
      sprintN: sc.sprintN,
      ctx,
      productSpec,
      roleAssignments,
      history: [...sprintHistory],
      phaseScope: sc.phaseScope,
    });

    let result: IterationState | undefined;
    while (true) {
      const n = await inner.next();
      if (n.done) {
        result = n.value;
        break;
      }
      // Site 3 — no try/catch here; without explicit halt handling the generator
      // returns normally and the phase orchestrator treats it as a completed sprint.
      // Forward the halt chunk upstream so runPhases can surface it to the user.
      if (n.value && (n.value as StreamChunk).type === "halt") {
        yield n.value;
        // Return a sentinel IterationState so the phase runner records a halted stage.
        return {
          sprintN: sc.sprintN,
          stage: "halted",
          scoreBefore: 0,
          scoreAfter: 0,
          criteriaMet: 0,
          criteriaPartial: 0,
          criteriaUnmet: 0,
          costUsd: 0,
          lastVerifyResult: (n.value as any).reason ?? "no_recipe",
        } as IterationState;
      }
      yield n.value;
    }

    // Accumulate completed sprint into history for subsequent sprints in this phase.
    if (result && typeof result === "object" && "criteriaMet" in result) {
      sprintHistory.push(result);
    }
    return result!;
  };

  // Chat setup (opt-in via env vars; no-op when unset).
  const chatCfg = chatEnvConfig();
  let chatClient: import("../chat/types.js").ChatClient | null = null;
  let slug: string | null = null;
  if (chatCfg) {
    chatClient = chatCfg.client;
    const { productSlug } = await import("./product-identity.js");
    slug = productSlug(manifest.idea);
  }

  // Terminal fallback: use respondToQuestion (the existing user-prompt API).
  // QuestionResponder takes a questionId string; the UI layer resolves the prompt text.
  const terminalFallback = async (): Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }> => {
    const ans = await ctx.respondToQuestion("customer-review-verdict");
    const lower = (ans ?? "").trim().toLowerCase();
    if (lower.startsWith("x")) return { verdict: "abort" as const };
    if (lower.startsWith("r")) {
      const fb = await ctx.respondToQuestion("customer-review-feedback");
      return { verdict: "reject" as const, feedback: fb ?? "" };
    }
    return { verdict: "accept" as const };
  };

  const awaitCustomerVerdict = async (verdictArgs: {
    flowDir: string;
    runId: string;
    phaseId: string;
    sprintN: number;
    reviewSummary: string;
  }): Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }> => {
    if (!chatClient || !slug) return terminalFallback();
    const { ensureChannel } = await import("../chat/channel-manager.js");
    const { discordAwaitVerdict } = await import("../chat/verdict-resolver.js");
    const ch = await ensureChannel({
      client: chatClient,
      guildId: process.env.MUONROI_DISCORD_GUILD_ID ?? "unknown",
      slug,
      displayName: manifest.idea,
    });
    if (!ch) return terminalFallback();
    return discordAwaitVerdict({
      flowDir: verdictArgs.flowDir,
      runId: verdictArgs.runId,
      phaseId: verdictArgs.phaseId,
      sprintN: verdictArgs.sprintN,
      productSlug: slug,
      channelId: ch.channelId,
      client: chatClient,
      leader,
      capUsd: manifest.capUsd,
      remainingUsd: async () => {
        const { getProductSpentUsd } = await import("../usage/product-ledger.js");
        const spent = await getProductSpentUsd(verdictArgs.runId);
        return Math.max(0, manifest.capUsd - spent);
      },
      reviewSummary: verdictArgs.reviewSummary,
      fallback: terminalFallback,
    });
  };

  const phaseGen = runPhases({
    flowDir: ctx.flowDir,
    runId: ctx.runId,
    manifest,
    clarifiedSpec,
    projectContext,
    leader: leader as any,
    leaderModelId,
    capUsd: manifest.capUsd,
    remainingUsd: async () => Math.max(0, manifest.capUsd - (await getProductSpentUsd(ctx.runId))),
    awaitCustomerVerdict,
    sprintRunner,
    projectCwd: ctx.cwd,
    idea: ctx.idea,
  } as any);

  let phaseOutcome: { pass: boolean; reason?: string } = { pass: false };
  while (true) {
    const step = await phaseGen.next();
    if (step.done) {
      phaseOutcome = step.value as { pass: boolean; reason?: string };
      break;
    }
    const chunk = step.value as StreamChunk;
    if (chunk.type === "push_notification" && chatClient && slug) {
      try {
        const { ensureChannel } = await import("../chat/channel-manager.js");
        const { publish } = await import("../chat/broadcast-bus.js");
        const ch = await ensureChannel({
          client: chatClient,
          guildId: process.env.MUONROI_DISCORD_GUILD_ID ?? "unknown",
          slug,
          displayName: manifest.idea,
        });
        if (ch) {
          await publish({
            client: chatClient,
            channelId: ch.channelId,
            type: "phase-event",
            content: chunk.content ?? "",
          });
        }
      } catch (e) {
        console.warn("muonroi: chat broadcast failed", e);
      }
    }
    yield chunk;
  }

  if (!phaseOutcome.pass) {
    return {
      runId: ctx.runId,
      stage: "halted",
      success: false,
      reason: phaseOutcome.reason ?? "phase-orchestrator-halt",
    };
  }

  // All phases done — write final manifest.
  const finalManifest = await readManifest(ctx.flowDir, ctx.runId);
  if (finalManifest) {
    await writeManifest(ctx.flowDir, ctx.runId, {
      ...finalManifest,
      doneAt: new Date(),
      verdict: { pass: true, score: 1, failedCondition: undefined as any, reason: "phases_complete" },
    });
  }
  // P1.3: extract run artifacts to EE for cross-run memory. Non-fatal —
  // EE client absorbs failures into the offline queue.
  // P1.6: log telemetry for the extract outcome.
  if (ctx.cwd) {
    const eeResult = await extractRunToEE(ctx.flowDir, ctx.runId, ctx.cwd);
    try {
      logInteraction(ctx.sessionId ?? ctx.runId, "ee_injection", {
        eventSubtype: "extract",
        durationMs: Math.round(eeResult.durationMs),
        data: {
          ok: eeResult.ok,
          mistakes: eeResult.mistakes ?? null,
          stored: eeResult.stored ?? null,
        },
      });
    } catch {
      // DB errors must not break /ideal
    }
  }
  return {
    runId: ctx.runId,
    stage: "approved",
    success: true,
    reason: "phases_complete",
    shipped: true,
  };
}

async function loadProductSpec(flowDir: string, runId: string, idea: string, stack?: string): Promise<ProductSpec> {
  const runDir = path.join(flowDir, "runs", runId);
  const roadmap = await readArtifact(runDir, "roadmap.md");
  const raw = roadmap?.sections.get("Product Specification") ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Partial<ProductSpec>;
      return {
        idea: parsed.idea ?? idea,
        persona: parsed.persona ?? "users",
        mvp: parsed.mvp ?? [],
        phase2: parsed.phase2 ?? [],
        architecture: parsed.architecture ?? "",
        ioContract: parsed.ioContract ?? "",
        folderStructure: parsed.folderStructure ?? "",
        sprintEstimate: parsed.sprintEstimate ?? 1,
        costEstimate: parsed.costEstimate ?? 1,
        stack: parsed.stack ?? stack,
        createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
      };
    } catch {
      /* fall through */
    }
  }
  return {
    idea,
    persona: "users",
    mvp: [],
    phase2: [],
    architecture: "",
    ioContract: "",
    folderStructure: "",
    sprintEstimate: 1,
    costEstimate: 1,
    stack,
    createdAt: new Date(),
  };
}

// ── Subcommands: status / resume / abort / ship ─────────────────────────────

async function* runStatus(opts: ProductLoopOptions): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const runsRoot = path.join(opts.flowDir, "runs");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsRoot);
  } catch {
    yield { type: "content", content: "No runs found.\n" } as StreamChunk;
    return { runId: "", stage: "approved", success: true };
  }

  if (opts.runId) {
    const m = await readManifest(opts.flowDir, opts.runId);
    if (!m) {
      yield { type: "content", content: `Run not found: ${opts.runId}\n` } as StreamChunk;
      return { runId: opts.runId, stage: "error", success: false, reason: "not_found" };
    }
    const iters = await readIterations(opts.flowDir, opts.runId);
    yield {
      type: "content",
      content:
        `Run ${opts.runId}: ${m.idea}\n` +
        `Cap: $${m.capUsd}  MaxSprints: ${m.maxSprints}  DoneThreshold: ${m.doneThreshold}\n` +
        `Iterations: ${iters.length}  Aborted: ${m.aborted ?? false}  DoneAt: ${m.doneAt?.toISOString() ?? "—"}\n`,
    } as StreamChunk;
    return { runId: opts.runId, stage: "approved", success: true };
  }

  const lines: string[] = [`Active runs (${entries.length}):`];
  for (const id of entries) {
    const m = await readManifest(opts.flowDir, id).catch(() => null);
    const iters = await readIterations(opts.flowDir, id).catch(() => []);
    if (!m) continue;
    lines.push(`  ${id}  ${m.idea.slice(0, 60)}  sprints=${iters.length}  aborted=${m.aborted ?? false}`);
  }
  yield { type: "content", content: `${lines.join("\n")}\n` } as StreamChunk;
  return { runId: "", stage: "approved", success: true };
}

async function* runAbort(opts: ProductLoopOptions): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  if (!opts.runId) {
    yield { type: "content", content: "error: abort requires a runId\n" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_runId" };
  }
  const m = await readManifest(opts.flowDir, opts.runId);
  if (!m) {
    yield { type: "content", content: `Run not found: ${opts.runId}\n` } as StreamChunk;
    return { runId: opts.runId, stage: "error", success: false, reason: "not_found" };
  }
  await writeManifest(opts.flowDir, opts.runId, { ...m, aborted: true, doneAt: new Date() });
  // Fire-and-forget EE phase-outcome=aborted (extension landed in 13-05).
  try {
    fireAndForgetPhaseOutcome({
      sessionId: opts.runId,
      phaseName: "product-loop",
      outcome: "aborted" as any,
    });
  } catch {
    /* non-fatal */
  }
  // P1.3: extract run artifacts to EE even on abort — we still want to learn
  // from partial runs. runAbort does not have a full DriverContext so cwd is
  // not available here; fall back to process.cwd() as the project path.
  // EE client is non-fatal (offline queue absorbs transport failures).
  // P1.6: log telemetry for the extract outcome.
  {
    const eeResult = await extractRunToEE(opts.flowDir, opts.runId, opts.cwd ?? process.cwd());
    try {
      logInteraction(opts.sessionId ?? opts.runId ?? "abort", "ee_injection", {
        eventSubtype: "extract",
        durationMs: Math.round(eeResult.durationMs),
        data: {
          ok: eeResult.ok,
          mistakes: eeResult.mistakes ?? null,
          stored: eeResult.stored ?? null,
        },
      });
    } catch {
      // DB errors must not break /ideal
    }
  }
  yield { type: "content", content: `Aborted run ${opts.runId}.\n` } as StreamChunk;
  return { runId: opts.runId, stage: "halted", success: false, reason: "aborted" };
}

async function* runResume(opts: ProductLoopOptions): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  if (!opts.runId) {
    yield { type: "content", content: "error: resume requires a runId\n" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_runId" };
  }
  const run = await loadRun(opts.flowDir, opts.runId);
  if (!run) {
    yield { type: "content", content: `Run not found: ${opts.runId}\n` } as StreamChunk;
    return { runId: opts.runId, stage: "error", success: false, reason: "not_found" };
  }
  const manifest = await readManifest(opts.flowDir, opts.runId);
  if (!manifest) {
    yield { type: "content", content: `Manifest missing for ${opts.runId}\n` } as StreamChunk;
    return { runId: opts.runId, stage: "error", success: false, reason: "manifest_missing" };
  }
  if (manifest.aborted) {
    yield { type: "content", content: `Run ${opts.runId} was aborted; cannot resume.\n` } as StreamChunk;
    return { runId: opts.runId, stage: "halted", success: false, reason: "aborted" };
  }

  // Detect crashed in-flight sprint: an iterations.md entry without a closing
  // Verify line is treated as crashed. Our schema always writes the Verify line
  // before returning, so an iteration is "in-flight" iff the file has a Sprint
  // heading but no matching Verify field. readIterations skips malformed
  // entries — so we mark the highest sprint number as crashed regardless.
  const iters = await readIterations(opts.flowDir, opts.runId);
  let nextSprint = iters.length + 1;
  if (iters.length > 0) {
    const last = iters[iters.length - 1]!;
    if (!last.lastVerifyResult || last.lastVerifyResult === "UNKNOWN") {
      await markIterationCrashed(opts.flowDir, opts.runId, last.sprintN);
      nextSprint = last.sprintN; // retry with retryOf metadata
      yield {
        type: "content",
        content: `Detected crashed sprint ${last.sprintN}; restarting fresh.\n`,
      } as StreamChunk;
    }
  }

  // Fire EE phase-outcome=resumed (extension landed in 13-05).
  try {
    fireAndForgetPhaseOutcome({
      sessionId: opts.runId,
      phaseName: `sprint-${Math.max(1, nextSprint - 1)}`,
      outcome: "resumed" as any,
    });
  } catch {
    /* non-fatal */
  }

  // Resume into sprint loop with reconstructed history + manifest flags.
  const productSpec = await loadProductSpec(opts.flowDir, opts.runId, manifest.idea, manifest.stack);
  const ctx: DriverContext = {
    runId: opts.runId,
    flowDir: opts.flowDir,
    idea: manifest.idea,
    sessionModelId: opts.sessionModelId,
    llm: opts.llm,
    flags: opts.flags,
    respondToQuestion: opts.respondToQuestion,
    respondToPreflight: opts.respondToPreflight,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    processMessageFn: opts.processMessageFn,
    detectVerifyRecipe: opts.detectVerifyRecipe,
  };
  const roleAssignments = opts.roleAssignments ?? (await resolveRoleAssignments(opts.sessionModelId));

  // Subsystem E: phase-orchestrated path (default ON; set MUONROI_PHASE_MODE=0 for legacy).
  if (process.env.MUONROI_PHASE_MODE !== "0") {
    const phaseResult = yield* runPhasesPath({ ctx, productSpec, roleAssignments });
    if (phaseResult !== null) return phaseResult;
    // phaseResult === null means runPhases prerequisites were unavailable; fall through to legacy.
  }

  return yield* drainSprints({
    ctx,
    productSpec,
    roleAssignments,
    history: iters.filter((i) => !i.crashed),
    flags: opts.flags,
  });
}

/**
 * Build the inventory of models reachable in this session (= every provider
 * that has a key on the keychain) and let role-registry assign one model per
 * RoleSlot. The resulting Map is consumed by sprint-runner → done-gate Cond #4
 * (PO ↔ Customer cross-model debate). Without this, the Map is empty and the
 * gate immediately returns "missing_roles".
 *
 * On refusal (no keys, single-provider with too few models, or PO/Customer
 * collision) we return an empty Map; done-gate's R5 short-circuit (skip Cond
 * #4 when score < 0.85) keeps early sprints unblocked, and the user-approval
 * gate (Cond #5) still runs so the loop can ship via /ship.
 */
async function resolveRoleAssignments(
  sessionModelId: string,
): Promise<Map<RoleSlot, { modelId: string; provider: string; tier?: string }>> {
  const out = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
  // Role-assignment inventory scan: intentionally excludes xai for legacy
  // resolveRoles ranking. Derived from ALL_PROVIDER_IDS so future additions
  // are picked up automatically.
  const order: readonly ProviderId[] = ALL_PROVIDER_IDS.filter((p) => p !== "xai");
  const inventory: ModelInfo[] = [];
  for (const p of order) {
    try {
      await loadKeyForProvider(p);
    } catch {
      continue;
    }
    inventory.push(...getModelsForProvider(p));
  }
  if (inventory.length === 0) return out;

  // EE-driven override: ask the experience brain for the best (model,tier)
  // per role, given accumulated past-performance signals. routeModel returns
  // null when no EE core is installed, in which case role-registry falls
  // back to its tier-preference cold-start logic.
  const eeRouteOverride = async (slot: RoleSlot): Promise<EERouteResult | null> => {
    const task = describeRoleTask(slot);
    try {
      return await eeRouteModel(
        task,
        { role: slot, sessionModel: sessionModelId, source: "product-loop" },
        "muonroi-cli",
      );
    } catch {
      return null;
    }
  };

  const result = await resolveRoles({ inventory, eeRouteOverride });
  if (result.kind !== "ok") return out;
  for (const [slot, a] of Object.entries(result.roles)) {
    out.set(slot as RoleSlot, { modelId: a.model, provider: a.provider, tier: a.tier });
  }
  return out;
}

/**
 * Slot → human-readable task description fed to EE's routeModel. The brain
 * uses this string as the primary classification key, so phrasing matters:
 * keep it specific to the role's actual deliverable.
 */
function describeRoleTask(slot: RoleSlot): string {
  switch (slot) {
    case "PO":
      return "product owner: clarify product spec and acceptance criteria";
    case "Architect":
      return "software architect: design module boundaries and data flow";
    case "Implementer":
      return "implementer: write production code from a spec";
    case "Tester":
      return "tester: design and write unit/integration tests";
    case "Reviewer":
      return "code reviewer: critique code for bugs, perf, and clarity";
    case "Customer":
      return "customer proxy: validate that built feature meets user need";
    default:
      return `role ${String(slot)}`;
  }
}

async function* runShip(opts: ProductLoopOptions): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  if (!opts.runId) {
    yield { type: "content", content: "error: ship requires a runId\n" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_runId" };
  }
  const m = await readManifest(opts.flowDir, opts.runId);
  if (!m) {
    yield { type: "content", content: `Run not found: ${opts.runId}\n` } as StreamChunk;
    return { runId: opts.runId, stage: "error", success: false, reason: "not_found" };
  }
  const iters = await readIterations(opts.flowDir, opts.runId);
  if (iters.length === 0) {
    yield { type: "content", content: `not ready to ship: no iterations recorded\n` } as StreamChunk;
    return { runId: opts.runId, stage: "halted", success: false, reason: "not_ready" };
  }
  const last = iters[iters.length - 1]!;
  if (last.lastVerifyResult !== "PASS") {
    yield {
      type: "content",
      content: `not ready to ship: last verify=${last.lastVerifyResult}\n`,
    } as StreamChunk;
    return { runId: opts.runId, stage: "halted", success: false, reason: "not_ready" };
  }

  // Force final user-approval gate (Cond #5). Reuse runPreflight via the
  // respondToPreflight responder: caller handles approve/reject prompt.
  const approved = await opts.respondToPreflight("ship-final");
  if (!approved) {
    yield { type: "content", content: `Ship rejected by user.\n` } as StreamChunk;
    // Build feedback so caller can pipe back into a continue cycle.
    buildContinueFeedback(
      { pass: false, failedCondition: "user_approval", score: last.scoreAfter, reason: "user_rejected" },
      null,
      [],
    );
    return { runId: opts.runId, stage: "halted", success: false, reason: "user_rejected" };
  }
  await writeManifest(opts.flowDir, opts.runId, {
    ...m,
    doneAt: new Date(),
    verdict: { pass: true, score: last.scoreAfter, failedCondition: undefined as any, reason: "force_shipped" },
  });
  yield { type: "content", content: `Shipped run ${opts.runId}.\n` } as StreamChunk;
  return { runId: opts.runId, stage: "approved", success: true, reason: "shipped", shipped: true };
}
