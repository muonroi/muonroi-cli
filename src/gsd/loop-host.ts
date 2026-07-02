import { existsSync, readFileSync } from "node:fs";
import type { TaskRequest, ToolResult } from "../types/index.js";
import { ensurePlanningWorkspace } from "./config-bridge.js";
import { fireGsdVerifyOutcome, logGsdNativeEvent } from "./ee-closure.js";
import {
  dispatchConfigEnsure,
  dispatchLoopRenderHooks,
  dispatchStateUpdate,
  type LoopHooksEnvelope,
  PHASE_TO_GSD_STATUS,
} from "./gsd-dispatch.js";
import { allLoopHostPoints, loadLoopHostContract } from "./gsd-runtime.js";
import { buildGsdPerspectiveTaskRequest } from "./model-tier.js";
import { planningArtifact } from "./paths.js";
import {
  extractPlanTitle,
  mirrorVerifyMdToPhaseDir,
  syncTaskPhaseOnPlan,
  syncTaskPhaseOnVerifyPass,
} from "./phase-sync.js";
import { type PlanCouncilOpts, type RunPerspectiveFn, runPlanCouncil } from "./plan-council.js";
import { runTaskShip } from "./ship-bridge.js";
import type { GsdPhase } from "./types.js";
import { readState, readWorkflowKind, setStateField } from "./workflow-engine.js";

export interface LoopHostContext {
  cwd: string;
  sessionModelId: string;
  depth: string;
  phase?: GsdPhase | null;
  sessionId?: string;
  runPerspectiveFn?: RunPerspectiveFn;
  revisionCycle?: number;
  verifyPassed?: boolean;
  verifyEvidence?: Record<string, unknown>;
  planBody?: string;
  planTitle?: string;
  shipNotes?: string[];
  commitMessage?: string;
  runDebate?: (topic: string) => Promise<string>;
}

export interface LoopPointResult {
  point: string;
  gsdHooks?: LoopHooksEnvelope;
  overlayRan: boolean;
  overlayError?: string;
}

type OverlayHandler = (ctx: LoopHostContext) => Promise<void> | void;

/**
 * Full Loop Host — fires gsd-core loop render-hooks then muonroi overlay handlers.
 * gsd-core owns capability registry + hook resolution; muonroi owns plan-council + execute gates.
 */
export class GsdLoopHost {
  private overlays = new Map<string, OverlayHandler>();
  private readonly hostProfile = {
    embeddingMode: "imperative" as const,
    commandSurface: "slash-programmatic" as const,
    hookBus: "host" as const,
    stateIO: "filesystem" as const,
    runtime: "bun" as const,
    native_host: "muonroi-cli",
  };

  constructor() {
    this.registerDefaultOverlays();
  }

  registerOverlay(point: string, handler: OverlayHandler): void {
    this.overlays.set(point, handler);
  }

  contractSteps() {
    return loadLoopHostContract();
  }

  canonicalPoints(): string[] {
    return allLoopHostPoints();
  }

  /** Bootstrap .planning/ via gsd-tools + muonroi config bridge. */
  ensureHost(cwd: string, sessionModelId: string): void {
    dispatchConfigEnsure(cwd);
    ensurePlanningWorkspace(cwd, sessionModelId);
  }

  getHostProfile() {
    return { ...this.hostProfile };
  }

  /**
   * Fire one loop point: gsd-core hooks first (observability + gate metadata),
   * then muonroi overlay (plan-council, phase advance).
   */
  async firePoint(point: string, ctx: LoopHostContext): Promise<LoopPointResult> {
    this.ensureHost(ctx.cwd, ctx.sessionModelId);

    const canonical = this.canonicalPoints();
    let gsdHooks: LoopHooksEnvelope | undefined;
    if (canonical.includes(point)) {
      const gsdResult = dispatchLoopRenderHooks(ctx.cwd, point);
      gsdHooks = gsdResult.ok ? gsdResult.data : undefined;
    }

    if (gsdHooks?.activeHooks?.some((h) => h.blocking === true && h.kind === "gate")) {
      console.error(
        `[gsd-loop-host] blocking gate at ${point}: ${JSON.stringify(gsdHooks.activeHooks.filter((h) => h.blocking))}`,
      );
    }

    let overlayRan = false;
    let overlayError: string | undefined;
    const overlay = this.overlays.get(point);
    if (overlay) {
      overlayRan = true;
      try {
        await overlay(ctx);
      } catch (err) {
        overlayError = (err as Error).message;
        console.error(`[gsd-loop-host] overlay ${point} failed: ${overlayError}`);
      }
    }

    return { point, gsdHooks, overlayRan, overlayError };
  }

  /** Map tool lifecycle → loop points. */
  async onDiscussComplete(ctx: LoopHostContext): Promise<LoopPointResult> {
    return this.firePoint("discuss:post", ctx);
  }

  async onPlanWritten(ctx: LoopHostContext): Promise<LoopPointResult> {
    return this.firePoint("plan:pre", ctx);
  }

  /** plan:post (council) + plan-review:post (execute gate). */
  async onPlanReviewComplete(ctx: LoopHostContext): Promise<LoopPointResult> {
    await this.firePoint("plan:post", ctx);
    return this.firePoint("plan-review:post", ctx);
  }

  async onExecuteStart(ctx: LoopHostContext): Promise<LoopPointResult> {
    return this.firePoint("execute:pre", ctx);
  }

  async onExecuteComplete(ctx: LoopHostContext): Promise<LoopPointResult> {
    return this.firePoint("execute:post", ctx);
  }

  async onVerifyComplete(ctx: LoopHostContext): Promise<LoopPointResult> {
    await this.firePoint("verify:pre", ctx);
    return this.firePoint("verify:post", ctx);
  }

  async onShipComplete(ctx: LoopHostContext): Promise<LoopPointResult> {
    await this.firePoint("ship:pre", ctx);
    return this.firePoint("ship:post", ctx);
  }

  private registerDefaultOverlays(): void {
    this.registerOverlay("discuss:post", (ctx) => {
      this.advanceTaskPhase(ctx, "plan");
    });

    this.registerOverlay("plan:pre", (ctx) => {
      if (readWorkflowKind(ctx.cwd) === "product") return;
      const planPath = planningArtifact(ctx.cwd, "PLAN.md");
      try {
        if (!existsSync(planPath)) return;
        const body = ctx.planBody ?? readFileSync(planPath, "utf8");
        const title = ctx.planTitle ?? extractPlanTitle(body);
        syncTaskPhaseOnPlan(ctx.cwd, {
          planTitle: title,
          planBody: body,
          sessionId: ctx.sessionId,
        });
      } catch (err) {
        console.error(`[gsd-loop-host] plan:pre phase-sync failed: ${(err as Error).message}`);
      }
    });

    this.registerOverlay("plan:post", async (ctx) => {
      const council = await runPlanCouncil({
        cwd: ctx.cwd,
        sessionModelId: ctx.sessionModelId,
        depth: ctx.depth,
        runPerspectiveFn: ctx.runPerspectiveFn,
        revisionCycle: ctx.revisionCycle,
        runDebate: ctx.runDebate,
      });
      logGsdNativeEvent(ctx.sessionId ?? "gsd-native", {
        phase: ctx.phase ?? readState(ctx.cwd).phase,
        depth: ctx.depth,
        loopPoint: "plan:post",
        planVerified: council.verdict === "pass",
        councilPerspectives: council.perspectives.length,
        leaderModelId: council.leaderModelId,
        councilContextChars: council.contextBundleChars,
        councilHadPriorConcerns: council.hadPriorConcerns,
        councilVerdictSource: council.verdictSource,
        councilVerdictParseFailed: council.verdictParseFailed,
      });
    });

    this.registerOverlay("plan-review:post", (ctx) => {
      const state = readState(ctx.cwd);
      if (state.planVerified) {
        this.advanceTaskPhase(ctx, "execute");
      }
    });

    this.registerOverlay("execute:pre", (ctx) => {
      dispatchStateUpdate(ctx.cwd, "Status", "In progress");
    });

    this.registerOverlay("execute:post", (ctx) => {
      this.advanceTaskPhase(ctx, "verify");
    });

    this.registerOverlay("verify:pre", (_ctx) => {
      /* Tests/self-verify run in gsd_verify tool body. */
    });

    this.registerOverlay("verify:post", (ctx) => {
      const passed = ctx.verifyPassed === true;
      fireGsdVerifyOutcome({
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        depth: ctx.depth,
        passed,
        evidence: ctx.verifyEvidence,
      });
      if (!passed) {
        this.advanceTaskPhase(ctx, "debug");
        dispatchStateUpdate(ctx.cwd, "Status", "In progress");
        return;
      }
      if (readWorkflowKind(ctx.cwd) !== "product") {
        const evidence = typeof ctx.verifyEvidence?.evidence === "string" ? ctx.verifyEvidence.evidence : undefined;
        const sync = syncTaskPhaseOnVerifyPass(ctx.cwd, {
          evidence,
          sessionId: ctx.sessionId,
        });
        const phaseDir = sync.phaseDirName;
        if (phaseDir) mirrorVerifyMdToPhaseDir(ctx.cwd, phaseDir);
      }
      this.advanceTaskPhase(ctx, "review");
      dispatchStateUpdate(ctx.cwd, "Status", PHASE_TO_GSD_STATUS.review ?? "Phase complete");
    });

    this.registerOverlay("ship:pre", (ctx) => {
      dispatchStateUpdate(ctx.cwd, "Status", "Phase complete");
    });

    this.registerOverlay("ship:post", (ctx) => {
      const result = runTaskShip({
        cwd: ctx.cwd,
        notes: ctx.shipNotes,
        commitMessage: ctx.commitMessage,
      });
      logGsdNativeEvent(ctx.sessionId ?? "gsd-native", {
        phase: "review",
        depth: ctx.depth,
        loopPoint: "ship:post",
        shipNotes: result.notes,
      });
    });
  }

  private advanceTaskPhase(ctx: LoopHostContext, phase: GsdPhase): void {
    setStateField(ctx.cwd, "Phase", phase);
    setStateField(ctx.cwd, "Depth", ctx.depth);
    const status = PHASE_TO_GSD_STATUS[phase];
    if (status) {
      dispatchStateUpdate(ctx.cwd, "Status", status);
    }
  }
}

let _defaultHost: GsdLoopHost | null = null;

export function getGsdLoopHost(): GsdLoopHost {
  if (!_defaultHost) _defaultHost = new GsdLoopHost();
  return _defaultHost;
}

export function taskToRunPerspectiveFn(
  runTask: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>,
  sessionModelId: string,
): RunPerspectiveFn {
  return async (prompt, perspective) => {
    const result = await runTask(buildGsdPerspectiveTaskRequest(prompt, perspective, sessionModelId));
    return result.output ?? "";
  };
}

export function loopHostContext(
  cwd: string,
  sessionModelId: string,
  depth: string,
  opts?: Pick<
    LoopHostContext,
    | "runPerspectiveFn"
    | "revisionCycle"
    | "phase"
    | "sessionId"
    | "verifyPassed"
    | "verifyEvidence"
    | "planBody"
    | "planTitle"
    | "shipNotes"
    | "commitMessage"
    | "runDebate"
  >,
): LoopHostContext {
  return {
    cwd,
    sessionModelId,
    depth,
    phase: opts?.phase ?? readState(cwd).phase,
    sessionId: opts?.sessionId,
    runPerspectiveFn: opts?.runPerspectiveFn,
    revisionCycle: opts?.revisionCycle,
    verifyPassed: opts?.verifyPassed,
    verifyEvidence: opts?.verifyEvidence,
    planBody: opts?.planBody,
    planTitle: opts?.planTitle,
    shipNotes: opts?.shipNotes,
    commitMessage: opts?.commitMessage,
    runDebate: opts?.runDebate,
  };
}
