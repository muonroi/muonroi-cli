import { breadcrumb } from "../council/crash-breadcrumb.js";
import { readState } from "../gsd/workflow-engine.js";
import { runPipeline } from "../pil/pipeline.js";
import type { PipelineContext } from "../pil/types.js";
import type { ToolResult } from "../types/index.js";
import { logger } from "../utils/logger.js";
import type { MessageProcessorDeps } from "./message-processor.js";
import { type ComplexitySize, getSessionLastTask, resolveCeiling } from "./scope-ceiling.js";

export interface PilSupplement {
  /** Synchronous read: pending/failed context never delays the leader. */
  read(): ToolResult;
  cancel(): void;
}

export interface PreprocessorResult {
  pilCtx: PipelineContext;
  pilSupplement: PilSupplement;
  _stepCeiling: number;
  _pilStart: number;
  _naturalCeiling: number;
  _ceilingTaskType: string;
  _ceilingSize: ComplexitySize;
}

function readPriorDepthTier(cwd: string): "quick" | "standard" | "heavy" | null {
  try {
    const depth = readState(cwd).depth;
    return depth === "quick" || depth === "standard" || depth === "heavy" ? depth : null;
  } catch (err) {
    logger.error("pil", "readState failed while resolving prior depth tier", { error: err, cwd });
    return null;
  }
}

function startPilSupplement(
  deps: MessageProcessorDeps,
  raw: string,
  priorDepthTier: PipelineContext["modelDepthTier"],
): PilSupplement {
  const parent = deps.getAbortController()?.signal;
  const controller = new AbortController();
  const sessionId = deps.session?.id ?? null;
  const cwd = deps.bash.getCwd();
  const modelId = deps.modelId;
  const resumeDigest = deps.getResumeDigest();
  const activeRunId = deps.getActiveRunId();
  const recentTurnsSummary = deps.buildRecentTurnsSummary();
  let alive = true;
  let delivered = false;
  let failed = false;
  let result: PipelineContext | undefined;
  const current = () =>
    alive && !parent?.aborted && (deps.session?.id ?? null) === sessionId && deps.bash.getCwd() === cwd;
  const cancel = () => {
    if (!alive) return;
    alive = false;
    result = undefined;
    clearImmediate(kickoff);
    parent?.removeEventListener("abort", cancel);
    controller.abort(parent?.reason ?? new Error("PIL supplement no longer belongs to the active turn"));
  };
  // Defer imports and server work until after foreground preparation returns.
  const kickoff = setImmediate(() => {
    void (async () => {
      try {
        if (!current()) {
          cancel();
          return;
        }
        const { createLlmClassifier } = await import("../pil/llm-classify.js");
        controller.signal.throwIfAborted();
        const ctx = await runPipeline(raw, {
          signal: controller.signal,
          sessionId,
          resumeDigest,
          activeRunId,
          recentTurnsSummary,
          priorDepthTier,
          llmFallback: createLlmClassifier(modelId, { routeFastTier: true }),
          // Background enrichment never owns human questions or main progress.
          onPhase: (name, state, error) => {
            if (!current()) cancel();
            controller.signal.throwIfAborted();
            breadcrumb("background.pil.phase", { sessionId, name, state, ...(error ? { error } : {}) });
          },
        });
        if (current()) result = ctx;
        else cancel();
      } catch (err) {
        failed = true;
        const error = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted) logger.debug("pil", "Background enrichment cancelled", { sessionId, error });
        else logger.error("pil", "Background enrichment failed; leader continues", { sessionId, error });
      } finally {
        parent?.removeEventListener("abort", cancel);
      }
    })();
  });
  parent?.addEventListener("abort", cancel, { once: true });
  return {
    cancel,
    read() {
      if (!current()) {
        cancel();
        return { success: true, output: "PIL supplement expired. Continue using your own judgment." };
      }
      if (delivered) return { success: true, output: "PIL supplement was already delivered this turn." };
      if (!result)
        return {
          success: true,
          output: failed
            ? "PIL supplement unavailable. Continue using your own judgment."
            : "PIL supplement pending. Continue the task without waiting or repeatedly polling.",
        };
      delivered = true;
      return {
        success: true,
        output: JSON.stringify({
          advisory:
            "Optional information for the leader; it does not decide routing, council, workflow, or permissions.",
          taskType: result.taskType,
          domain: result.domain,
          confidence: result.confidence,
          fallbackReason: result.fallbackReason ?? null,
          information: result.enriched.replace(raw, "").trim().slice(0, 6000),
        }),
      };
    },
  };
}

function emitOverrideToast(text: string): void {
  try {
    const runtime = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent?: (e: unknown) => void }
      | undefined;
    runtime?.emitEvent?.({ t: "event", kind: "toast", level: "info", text });
  } catch (err) {
    // A toast is informational; a broken sink must not fail the turn.
    logger.debug("pil", "override toast emit failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export function prepareTurnContext(
  deps: MessageProcessorDeps,
  userMessage: string,
  _budgetOverride: { override?: number },
): PreprocessorResult {
  deps.getAbortController()?.signal.throwIfAborted();
  const _pilStart = Date.now();
  const priorDepthTier = readPriorDepthTier(deps.bash.getCwd());
  // Only local workflow state and the original prompt enter foreground control.
  // Server-derived fields stay inside the optional supplement.
  const pilCtx: PipelineContext = {
    raw: userMessage,
    enriched: userMessage,
    taskType: null,
    domain: null,
    confidence: 0,
    outputStyle: null,
    tokenBudget: 500,
    metrics: null,
    layers: [],
    intentKind: null,
    fallbackReason: null,
    modelDepthTier: priorDepthTier,
    resumeDigest: deps.getResumeDigest(),
    activeRunId: deps.getActiveRunId(),
  };
  const lastTask = deps.session?.id ? getSessionLastTask(deps.session.id) : null;
  const _ceilingTaskType = lastTask?.taskType ?? "general";
  const _ceilingSize = lastTask?.size ?? "medium";
  const _naturalCeiling = resolveCeiling(_ceilingTaskType, _ceilingSize);
  // Phase 4 Plan 04 (4B) — `--budget-rounds N` (parsed and stripped by the
  // caller) wins over the matrix ceiling; tell the user the explicit cap is in
  // force. This needs only the local override + natural ceiling, never PIL, so
  // it survived the background-PIL move in bc8fe0e by intent — it was dropped
  // there only as collateral of rewriting this function.
  if (_budgetOverride.override !== undefined && _budgetOverride.override !== _naturalCeiling) {
    emitOverrideToast(
      `override active: ceiling ${_budgetOverride.override}, default was ${_naturalCeiling} (task=${_ceilingTaskType}/size=${_ceilingSize})`,
    );
  }
  const pilSupplement = startPilSupplement(deps, userMessage, priorDepthTier);
  return {
    pilCtx,
    pilSupplement,
    _pilStart,
    _naturalCeiling,
    _ceilingTaskType,
    _ceilingSize: _ceilingSize as ComplexitySize,
    _stepCeiling: _budgetOverride.override ?? _naturalCeiling,
  };
}
