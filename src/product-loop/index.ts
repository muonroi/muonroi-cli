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
import { logInteraction } from "../storage/index.js";
import type { ModelInfo, StreamChunk, VerifyRecipe } from "../types/index.js";
import { markIterationCrashed, readIterations, readManifest, writeManifest } from "./artifact-io.js";
import { formatCostPreview, previewRunCost } from "./cost-preview.js";
import { extractRunToEE } from "./cross-run-memory.js";
import { buildContinueFeedback, type ContinueFeedback } from "./feedback-routing.js";
import { type DriverContext, type DriverResult, runLoopDriver } from "./loop-driver.js";
import { resolveRoles } from "./role-registry.js";
import { polishDelivery } from "./ship-polish.js";
import { runSprint } from "./sprint-runner.js";
import type { IterationState, ProductSpec, RoleSlot } from "./types.js";

export interface ProductLoopFlags {
  maxCost: number;
  maxSprints: number;
  doneThreshold: number;
  stack?: string;
  /** P2.7: when true, always run full council debate even for low-complexity ideas. */
  forceCouncil?: boolean;
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
   * P2.6: Complexity decision from PIL Layer 1. When "low" and forceCouncil is
   * not set, the dispatcher routes to runHotPath (single sprint, no council debate).
   */
  complexity?: "low" | "medium" | "high";
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
    default:
      if (opts.complexity === "low" && !opts.flags.forceCouncil) {
        return yield* runHotPath(opts);
      }
      return yield* runStart(opts);
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

  yield {
    type: "content",
    content: "\n> hot-path: complexity=low → single sprint, no council debate\n",
  } as StreamChunk;

  // Telemetry: log routing decision.
  try {
    logInteraction(runId, "routing", {
      eventSubtype: "ideal_hot_path",
      data: { complexity: "low", forceCouncil: false },
    });
  } catch {
    // DB errors must not break /ideal
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
    processMessageFn: opts.processMessageFn,
    detectVerifyRecipe: opts.detectVerifyRecipe,
    skipPriorContext: opts.skipPriorContext,
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
      logInteraction(runId, "ee_injection", {
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

/** start: createRun → loop-driver (gather/research/scoping) → sprint loop → done|halted. */
async function* runStart(opts: ProductLoopOptions): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const { idea, flowDir, llm, flags, respondToQuestion, respondToPreflight } = opts;
  if (!idea || !idea.trim()) {
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
    processMessageFn: opts.processMessageFn,
    detectVerifyRecipe: opts.detectVerifyRecipe,
    skipPriorContext: opts.skipPriorContext,
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
    yield { type: "error", error: true, content: msg } as any;
    return { runId, stage: "error", success: false, reason: msg };
  }

  if (!driverResult?.success || driverResult.stage !== "approved") {
    return { ...driverResult!, runId };
  }

  // Phase 2: sprint loop until done or halted.
  const productSpec = await loadProductSpec(flowDir, runId, idea, opts.flags.stack);
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
    history: [],
    flags,
  });
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
        yield step.value as StreamChunk;
      }
      iter = result!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "content", content: `\n> Sprint ${sprintN} halted: ${msg}\n` } as StreamChunk;
      // Mark manifest as halted (not aborted) so resume can pick up.
      const manifest = await readManifest(ctx.flowDir, ctx.runId);
      if (manifest) {
        await writeManifest(ctx.flowDir, ctx.runId, {
          ...manifest,
          verdict: { pass: false, score: 0, reason: msg, failedCondition: undefined as any },
        });
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
          logInteraction(ctx.runId, "ee_injection", {
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
      logInteraction(ctx.runId, "ee_injection", {
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
      logInteraction(opts.runId, "ee_injection", {
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
  const order: ProviderId[] = ["anthropic", "openai", "google", "deepseek", "siliconflow", "ollama"];
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
