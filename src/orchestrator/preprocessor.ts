import type { DiscoveryInteractionHandler } from "../pil/discovery-types.js";
import { runPipeline } from "../pil/pipeline.js";
import type { StreamChunk } from "../types/index.js";
import { logger } from "../utils/logger.js";
import type { MessageProcessorDeps } from "./message-processor.js";
import { type ComplexitySize, getSessionLastTask, recordSessionLastTask, resolveCeiling } from "./scope-ceiling.js";

export interface PreprocessorResult {
  pilCtx: Awaited<ReturnType<typeof runPipeline>>;
  _stepCeiling: number;
  _pilStart: number;
  _naturalCeiling: number;
  _ceilingTaskType: string;
  _ceilingSize: ComplexitySize;
}

export async function* prepareTurnContext(
  deps: MessageProcessorDeps,
  userMessage: string,
  _budgetOverride: any,
): AsyncGenerator<StreamChunk, PreprocessorResult, unknown> {
  // PIL: enrich prompt before pushing to messages (D-01, D-03, D-04)
  // Promise.race timeout of 200ms is inside runPipeline — fail-open guaranteed
  // --- PIL with discovery (interactive path) ---
  const pilChunkQueue: StreamChunk[] = [];
  const pilResponder = deps.councilManager.createQuestionResponder();

  const discoveryHandler: DiscoveryInteractionHandler = {
    askQuestion: async (question) => {
      pilChunkQueue.push({
        type: "council_question",
        content: question.question,
        councilQuestion: question,
      } as StreamChunk);
      const text = await pilResponder(question.questionId);
      return { questionId: question.questionId, text, kind: "choice" as const };
    },
  };

  const _pilStart = Date.now();
  let pilCtxResolved: Awaited<ReturnType<typeof runPipeline>> | null = null;
  let pilDone = false;

  const pilTask = (async () => {
    try {
      // Build Pass 4 LLM fallback closure using the orchestrator's already-
      // constructed provider factory + current model. PIL stays ignorant of
      // provider wiring — it just receives a `classify(prompt)` callback.
      let llmFallback: import("../pil/llm-classify.js").LlmClassifyFn | undefined;
      try {
        const { createLlmClassifier } = await import("../pil/llm-classify.js");
        llmFallback = createLlmClassifier(deps.modelId, { routeFastTier: true });
      } catch (err) {
        logger.error("pil", "LLM fallback wiring failed", { error: err });
      }

      // Model-driven clarification proposer (for discovery interview).
      // The actual task model (via the same provider + modelId) generates the
      // questions based on raw + CLI enrichment. Then discovery asks user.
      let clarificationProposer: import("../pil/discovery-types.js").ModelClarificationProposer | undefined;
      try {
        const { createModelClarificationProposer } = await import("../pil/discovery.js");
        clarificationProposer = createModelClarificationProposer(deps.modelId);
      } catch (err) {
        logger.error("pil", "clarification proposer wiring failed", { error: err });
      }

      pilCtxResolved = await runPipeline(userMessage, {
        resumeDigest: deps.getResumeDigest(),
        activeRunId: deps.getActiveRunId(),
        sessionId: deps.session?.id ?? null,
        interactionHandler: discoveryHandler,
        llmFallback,
        clarificationProposer,
        recentTurnsSummary: deps.buildRecentTurnsSummary(),
      });
    } catch (err) {
      pilCtxResolved = {
        raw: userMessage,
        enriched: userMessage,
        taskType: null,
        domain: null,
        confidence: 0,
        outputStyle: null,
        tokenBudget: 500,
        metrics: null,
        layers: [],
        gsdPhase: null,
        activeRunId: null,
        intentKind: null as "task" | "chitchat" | null,
        fallbackReason: err instanceof Error ? `orchestrator-catch:${err.name}` : "orchestrator-catch:unknown",
      };
    } finally {
      pilDone = true;
    }
  })();

  while (!pilDone) {
    while (pilChunkQueue.length > 0) {
      yield pilChunkQueue.shift()!;
    }
    if (!pilDone) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  while (pilChunkQueue.length > 0) {
    yield pilChunkQueue.shift()!;
  }
  await pilTask;

  const pilCtx = pilCtxResolved!;

  // Phase 4 Plan 04 (4B) — resolve per-session step ceiling using
  // (task_type × complexitySize) matrix. Override (from --budget-rounds N
  // parsed earlier) wins. When the override differs from the natural
  // ceiling, emit info toast so the user sees the explicit cap.
  //
  // Phase 5 Fix 2 — continuation phrases ("tiếp tục" / "continue") are
  // classified `general/chitchat` by PIL Layer 1 Pass 0. Resolving the
  // ceiling from that label collapses the budget to general × small = 5,
  // which is wrong: the user wants the agent to RESUME the prior task,
  // not start a generic chitchat. When this session has a recorded
  // non-chitchat task row, inherit it for ceiling resolution. The Pass 0
  // classification itself stays general so downstream code (style /
  // chitchat skip / tools-empty optimization in `BUG-A guard`) reads the
  // correct intent; only the ceiling row is borrowed.
  const _pilTaskType = pilCtx.taskType ?? "general";
  const _pilSize = pilCtx.complexitySize?.size ?? "medium";
  const _sessionIdForLastTask = deps.session?.id ?? "";
  const _isContinuationChitchat =
    _pilTaskType === "general" && pilCtx.intentKind === "chitchat" && _sessionIdForLastTask !== "";
  const _lastTask = _isContinuationChitchat ? getSessionLastTask(_sessionIdForLastTask) : null;
  const _ceilingTaskType = _lastTask?.taskType ?? _pilTaskType;
  const _ceilingSize = _lastTask?.size ?? _pilSize;
  const _naturalCeiling = resolveCeiling(_ceilingTaskType, _ceilingSize);
  // Phase 5 Fix 4 (Option A) — make ceiling mutable so the stopWhen
  // closure can bump it on auto-continue checkpoints. See checkpoint
  // logic at dynamicStopWhen below for the bump policy.
  const _stepCeiling = _budgetOverride.override ?? _naturalCeiling;
  // Record this turn's task row for future continuation inheritance.
  // Only non-chitchat task turns update the slot.
  if (_sessionIdForLastTask && _pilTaskType !== "general" && pilCtx.intentKind === "task") {
    recordSessionLastTask(_sessionIdForLastTask, _pilTaskType, _pilSize);
  }
  if (_budgetOverride.override !== undefined && _budgetOverride.override !== _naturalCeiling) {
    try {
      const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
        | { emitEvent: (e: unknown) => void }
        | undefined;
      _ar?.emitEvent({
        t: "event",
        kind: "toast",
        level: "info",
        text: `override active: ceiling ${_budgetOverride.override}, default was ${_naturalCeiling} (task=${_ceilingTaskType}/size=${_ceilingSize})`,
      });
    } catch {
      /* best-effort */
    }
  }

  return {
    pilCtx,
    _stepCeiling,
    _pilStart,
    _naturalCeiling,
    _ceilingTaskType,
    _ceilingSize: _ceilingSize as ComplexitySize,
  };
}
