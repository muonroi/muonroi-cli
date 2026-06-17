// MessageProcessor — extracted from orchestrator.ts as part of Phase 12.4.
//
// Owns the main streaming turn loop that lives in `Agent.processMessage`:
//   - Abort wiring (external AbortContext + per-turn AbortController)
//   - Trajectory + phase tracker observations on user_turn / abort
//   - PIL enrichment pipeline (layers 1/3/6 — fail-open with logging)
//   - ROUTE-11 per-turn model routing (decide + fallback to non-disabled
//     provider via CouncilManager)
//   - Vision proxy (history + current turn)
//   - Auto-council gate (PIL taskType + heavy tier + role count) — routes
//     into runCouncilV2 and re-enters processMessage with synthesis
//   - System prompt assembly (chitchat / playwright gating + PIL suffix +
//     model constraints)
//   - SAMR step-aware routing (phase1 reasoning → phase2 execution)
//   - Tool roundtrip loop:
//       - Compaction (relax on overflow recovery, B4 top-level prepareStep)
//       - Tool set assembly: builtin + MCP (smart filter for chitchat /
//         browser-vocab) + PIL response tools, all wrapped with top-level
//         cumulative cap (F1), cross-turn dedup (C3), read-path budget
//       - ProviderOptions composition (buildTurnProviderOptions +
//         taskTypeToReasoningEffort budget + thinkingType adaptive override
//         + O1 shape capture)
//       - streamText({...}) with prepareStep (top-level compactor +
//         capability sanitizeHistory), onStepStart/Finish, onFinish
//         (correlation cleanup)
//       - fullStream consumer (text-delta / reasoning-delta / tool-call
//         with EE PreToolUse intercept / tool-result with EE PostToolUse
//         and vision-bridge / tool-error / tool-approval-request /
//         error / abort)
//   - Write-ahead persistence (Phase A4 tool_calls, A5 message_seq)
//   - Context-overflow recovery + transient retry with exponential backoff
//   - Post-turn compact + Stop / StopFailure hooks
//   - Debug pipeline trace
//
// Zero behavioral changes — every method body mirrors the original
// `processMessage` (see commit history). The DI surface (`MessageProcessorDeps`)
// is the minimum proxy onto Agent state needed to reach back into Agent
// without holding a circular reference. Public `Agent.processMessage`
// signature is unchanged and continues to be the entrypoint; internally it
// constructs a `MessageProcessor` per call.
//
// Cost-leak code paths preserved here:
//   - F1 (top-level cumulative cap)         — wrapToolSetWithCap (top-level)
//   - F1 (openai.promptCacheKey)            — buildTurnProviderOptions
//   - G1 (OAuth `maxOutputTokens` drop)     — shouldDropParam(runtime, ...)
//   - B4 (top-level prepareStep compaction) — compactSubAgentMessages
//   - C3 (cross-turn dedup wrap)            — wrapToolSetWithDedup
//   - A4 (tool_call write-ahead)            — persistToolCallWriteAhead
//   - A5 (message_seq write-ahead)          — persistMessageWriteAhead
//   - O1 (providerOptions shape forensics)  — extractProviderOptionsShape
//   - siliconflow reasoning-strip           — turnCaps.sanitizeHistory

import { type ModelMessage, type StopCondition, stepCountIs, streamText, type ToolSet } from "ai";
import { recordArtifact } from "../ee/artifact-cache.js";
import { getCachedAuthToken, getCachedServerBaseUrl } from "../ee/auth.js";
import { routeFeedback, routeModel } from "../ee/bridge.js";
import { getDefaultEEClient } from "../ee/intercept.js";
import { getMistakeDetector } from "../ee/mistake-detector.js";
import { fireAndForgetPhaseOutcome } from "../ee/phase-outcome.js";
import * as phaseTracker from "../ee/phase-tracker.js";
import { buildScope as buildScopeForVeto } from "../ee/scope.js";
import { fireTrajectoryEvent } from "../ee/session-trajectory.js";
import { getTenantId as getTenantIdForVeto } from "../ee/tenant.js";
import { mentionsEcosystemScope } from "../gsd/directives.js";
import type {
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  UserPromptSubmitHookInput,
} from "../hooks/types";
import { acquireMcpTools } from "../mcp/client-pool";
import { dropRedundantFsMcpTools, filterMcpServersByMessage } from "../mcp/smart-filter";
import { getModelInfo } from "../models/registry.js";
import {
  cheapModelShellLine,
  injectCheapModelPlaybook,
  injectCheapModelShellDirective,
  shouldInjectCheapModelPlaybook,
} from "../pil/cheap-model-playbook.js";
import { injectCheapModelWorkbook, shouldInjectCheapModelWorkbook } from "../pil/cheap-model-workbooks.js";
import type { DiscoveryInteractionHandler } from "../pil/discovery-types.js";
import {
  applyPilSuffix,
  getResponseTaskType,
  getResponseToolSet,
  isResponseTool,
  runPipeline,
  shouldHaltOnResponseTool,
} from "../pil/index.js";
import { isMetaAnalysisPrompt } from "../pil/layer6-output.js";
import { taskTypeToMaxTokens, taskTypeToReasoningEffort, taskTypeToTier } from "../pil/task-tier-map.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import {
  bridgeMcpToolResult,
  getVisionGuidanceForTextOnly,
  listCachedImages,
  scrubImagePayloadsInMessages,
} from "../providers/mcp-vision-bridge.js";
import { captureToolSchemas } from "../providers/patch-zod-schema.js";
import {
  buildTurnProviderOptions,
  detectProviderForModel,
  type ResolvedModelRuntime,
  requireRuntimeProvider,
  resolveModelRuntime,
  shouldDropParam,
} from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { needsVisionProxy, proxyVision } from "../providers/vision-proxy.js";
import { wireDebug } from "../providers/wire-debug.js";
import { reportRouteOutcome } from "../router/decide.js";
import { decideStepRouting, getStepRouterConfig } from "../router/step-router.js";
import { routerStore } from "../router/store.js";
import {
  getNextMessageSequence,
  logInteraction,
  markMessageErrored,
  markToolCallErrored,
  persistMessageWriteAhead,
  persistToolCallWriteAhead,
  type SessionStore,
} from "../storage/index.js";
import { persistSessionExperience } from "../storage/session-experience-store.js";
import { createBuiltinTools } from "../tools/registry.js";
import { snapshotFromTodoWriteArgs } from "../tools/todo-write-snapshot.js";
import { visionToolsNeeded } from "../tools/vision-gate.js";
import type { SessionInfo, StreamChunk, SubagentStatus, ToolCall } from "../types/index";
import { isDebugEnabled, type PipelineStep, recordTurnTrace, type TurnTrace } from "../ui/slash/debug.js";
import { statusBarStore } from "../ui/status-bar/store.js";
import { appendDecisionLog } from "../usage/decision-log.js";
import { openUrl } from "../utils/open-url.js";
import { appendAudit, type PermissionMode, toolNeedsApproval } from "../utils/permission-mode.js";
import {
  getAutoCouncilConfidence,
  getAutoCouncilMinRoles,
  getProviderStallRetries,
  getProviderStallTimeoutMs,
  getRoleModels,
  getTopLevelCompactKeepLast,
  getTopLevelCompactThresholdChars,
  getTopLevelToolBudgetChars,
  isAutoCouncilEnabled,
  isProviderDisabled,
  loadMcpServers,
  loadValidSubAgents,
} from "../utils/settings";
import { resolveShell } from "../utils/shell.js";
import type { AbortContext } from "./abort.js";
import type { LegacyProvider, ProcessMessageObserver } from "./agent-options";
import { relaxCompactionSettings } from "./compaction";
import type { CouncilManager } from "./council-manager.js";
import type { CrossTurnDedup } from "./cross-turn-dedup.js";
import { wrapToolSetWithDedup } from "./cross-turn-dedup.js";
import { humanizeApiError, isAuthenticationError, isContextLimitError, summarizeApiErrorForLog } from "./error-utils";
import { buildGroundingFootnote, findUnverifiedClaims } from "./grounding-check.js";
import { buildInterruptedTurnNote } from "./interrupted-turn.js";
import type { PendingCallsLog } from "./pending-calls.js";
import { stableCallId } from "./pending-calls.js";
import { applyModelConstraints, buildMcpCapabilityBlock, buildSystemPromptParts } from "./prompts";
import { extractProviderOptionsShape } from "./provider-options-shape.js";
import type { ReadPathBudget } from "./read-path-budget.js";
import { wrapToolSetWithReadBudget } from "./read-path-budget.js";
import { containsEncryptedReasoning, sanitizeModelMessages } from "./reasoning";
import { repairToolCallHook } from "./repair-tool-call.js";
import {
  buildRepetitionReminder,
  recordAssistantBurst,
  shouldInjectRepetitionReminder,
} from "./repetition-detector.js";
import { classifyStreamError } from "./retry-classifier.js";
import {
  forcedFinalize,
  getSessionLastTask,
  incSessionStep,
  parseBudgetOverride,
  recordSessionLastTask,
  resetSessionStep,
  resolveCeiling,
} from "./scope-ceiling.js";
import {
  attachReminderToMessages,
  buildCheckpointReminder,
  buildScopeReminder,
  type ComplexitySize,
  cadenceForSize,
  shouldInjectCeilingCrossing,
  shouldInjectReminder,
  shouldInjectSoftWarn,
  shouldPreWarnCompaction,
} from "./scope-reminder.js";
import {
  formatElisionManifest,
  getSessionExperienceCounts,
  recordCompaction,
  recordElision,
} from "./session-experience.js";
import { attemptStallRescue, pushStallToolResult, type StallToolResult } from "./stall-rescue.js";
import {
  createStallWatchdog,
  STALL_ERROR_MESSAGE,
  shouldRepromptStall,
  stallRepromptBackoffMs,
} from "./stall-watchdog.js";
import { wrapToolSetWithCap } from "./sub-agent-cap.js";
import { compactSubAgentMessages, cumulativeMessageChars } from "./subagent-compactor.js";
import { detectTextEmittedToolCall, parseDsmlToolCalls } from "./text-tool-call-detector.js";
import { createToolLoopCapPredicate, type ToolLoopCapAsk } from "./tool-loop-cap.js";
import {
  buildToolRepetitionAbortMessage,
  recordToolError as recordToolRepetitionError,
  recordToolSuccess as recordToolRepetitionSuccess,
} from "./tool-repetition-detector.js";

/**
 * F2 — approximate the char cost of the FIXED prompt envelope (system +
 * tools JSON-Schema) that streamText re-sends on every step. Used to feed
 * the compactor a realistic total-prompt size so it fires when billed input
 * is actually large, not when only `messages[]` is.
 */
function computeEnvelopeChars(system: unknown, tools: unknown): number {
  let n = 0;
  if (typeof system === "string") n += system.length;
  else if (system && typeof system === "object") {
    try {
      n += JSON.stringify(system).length;
    } catch {
      /* ignore — best-effort estimate */
    }
  }
  if (tools && typeof tools === "object") {
    try {
      n += JSON.stringify(tools).length;
    } catch {
      /* ignore */
    }
  }
  return n;
}

import {
  combineAbortSignals,
  getFinishReason,
  getStepNumber,
  getUsage,
  notifyObserver,
  toToolCall,
  toToolResult,
} from "./tool-utils";
import type { TurnRunnerDepsBase } from "./turn-runner-deps.js";

/**
 * Dependency surface the MessageProcessor needs to reach back into Agent
 * state without holding a circular reference. Properties expose array
 * references (mutating push() must affect the same array the Agent reads on
 * subsequent turns). Method callbacks delegate to Agent private methods.
 */
export interface MessageProcessorDeps extends TurnRunnerDepsBase {
  // ---- Read/write state references --------------------------------------
  // (messages, bash, mode, maxToolRounds, schedules, sendTelegramFile inherited)
  /** Live messageSeqs array (mutated by push; parallel to messages). */
  readonly messageSeqs: Array<number | null>;
  /** Session bookkeeping. */
  readonly session: SessionInfo | null;
  readonly sessionStore: SessionStore | null;
  readonly modelId: string;
  readonly providerId: ProviderId;
  readonly batchApi: boolean;
  readonly permissionMode: PermissionMode;
  readonly externalAbortContext: AbortContext | null;
  readonly pendingCalls: PendingCallsLog | null;
  readonly councilManager: CouncilManager;
  readonly crossTurnDedup: CrossTurnDedup | null;
  readonly readBudget: ReadPathBudget | null;
  readonly priorWarningIdsInSession: Set<string>;
  readonly sessionEEGuidance: Map<string, { toolName: string; message: string; why: string; confidence: number }>;
  readonly flowReady: Promise<void> | null;

  // ---- Scalar getters / setters -----------------------------------------
  getAbortController(): AbortController | null;
  setAbortController(ctrl: AbortController | null): void;
  getSessionStartHookFired(): boolean;
  setSessionStartHookFired(v: boolean): void;
  getPlanContext(): string | null;
  setPlanContext(v: string | null): void;
  getResumeDigest(): string | null;
  setResumeDigest(v: string | null): void;
  getActiveRunId(): string | null;
  getPendingCwdNote(): string | null;
  setPendingCwdNote(v: string | null): void;
  setPilActive(v: boolean): void;
  setPilEnrichmentDelta(n: number): void;
  setCurrentCallId(id: string): void;
  setLastPromptBreakdown(
    b: {
      systemChars: number;
      staticPrefixChars: number;
      dynamicSuffixChars: number;
      playwrightGuidanceChars: number;
      messagesChars: number;
      messagesCount: number;
      toolsChars: number;
      toolsCount: number;
    } | null,
  ): void;
  setTurnUserGoalExcerpt(v: string): void;
  setTurnAssistantReasoning(v: string): void;
  appendTurnAssistantReasoning(delta: string): void;
  getTurnAssistantReasoning(): string;
  setPriorWarningIdsInSession(s: Set<string>): void;
  setMessages(messages: ModelMessage[]): void;

  // ---- Behavior delegators ----------------------------------------------
  requireProvider(): LegacyProvider;
  emitSubagentStatus(status: SubagentStatus | null): void;
  fireHook(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{
    blocked: boolean;
    blockingErrors: Array<{ command: string; stderr: string }>;
    preventContinuation: boolean;
    additionalContexts: string[];
    results: import("../hooks/types.js").HookResult[];
    eeMatches: import("../hooks/types.js").EEMatchEntry[];
  }>;
  consumeBackgroundNotifications(): Promise<string[]>;
  initOAuthProvider(): Promise<void>;
  buildRecentTurnsSummary(): string | null;
  estimateProjectSize(): "small" | "medium" | "large" | null;
  countFilesTouched(): number;
  respondToToolApproval(approvalId: string, approved: boolean): void;
  /**
   * Tool-loop cap askcard hook (Claude-Code-style "continue?" prompt).
   *
   * Fires when the streamText loop reaches `maxToolRounds`. Returning
   * `"continue"` raises the cap by `bumpBy` and lets the loop run; `"stop"`
   * halts gracefully (no error). When undefined the loop hard-stops as before
   * — preserves backward compat for batch / headless paths that have no UI to
   * surface the askcard.
   */
  /**
   * Live-queue steering drain (UI-provided). Returns and CLEARS any messages
   * the user typed while this turn is streaming, so prepareStep can inject them
   * mid-turn. Undefined / returns [] → no steering (legacy deferred queue).
   */
  drainSteerMessages?: () => { text: string }[];
  askToolLoopContinue?: ToolLoopCapAsk;
  runCouncilV2(
    userMessage: string,
    opts: { skipClarification: boolean; observer?: ProcessMessageObserver; userModelMessage: ModelMessage },
  ): AsyncGenerator<StreamChunk, void, unknown>;
  processMessage(
    userMessage: string,
    observer?: ProcessMessageObserver,
    images?: Array<{ path: string; mediaType: string; base64: string }>,
  ): AsyncGenerator<StreamChunk, void, unknown>;
  processMessageBatchTurn(args: {
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    provider: LegacyProvider;
    subagents: ReturnType<typeof loadValidSubAgents>;
    system: string;
    runtime: ResolvedModelRuntime;
    modelInfo: ResolvedModelRuntime["modelInfo"];
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown>;
}

/**
 * MessageProcessor — extracted streaming turn loop.
 *
 * Lifecycle:
 *   const processor = new MessageProcessor(deps);
 *   yield* processor.run(userMessage, observer, images);
 *
 * Constructed per call (heap allocation is negligible against the streamText
 * cost), matching the StreamRunner / CouncilManager pattern.
 */

/**
 * Max response-tool (`respond_*`) calls tolerated within a single turn before
 * the orchestrator finalizes early with the best answer buffered so far. A
 * well-behaved turn emits the response tool ONCE; a hedge-then-answer emits 2.
 * Beyond that is degenerate spam (session 8d8f498268ed: 80× identical
 * respond_general in one generation). Set to 3 so the legitimate ≤2 patterns
 * are never cut short.
 */
const RESPONSE_TOOL_SPAM_CAP = 3;

export class MessageProcessor {
  constructor(private deps: MessageProcessorDeps) {}

  async *run(
    userMessage: string,
    observer?: ProcessMessageObserver,
    images?: Array<{ path: string; mediaType: string; base64: string }>,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const deps = this.deps;
    // TUI-04: prefer the external AbortContext (from SIGINT handler) so that
    // Ctrl+C mid-tool-call triggers a single, unified abort across all I/O.
    // If no external context, fall back to creating a local AbortController.
    if (deps.externalAbortContext) {
      // Wrap the external signal in a local controller so existing cleanup
      // paths (setAbortController(null)) still work without side-effects.
      const ctrl = new AbortController();
      deps.setAbortController(ctrl);
      // Forward external abort to the local controller.
      deps.externalAbortContext.signal.addEventListener(
        "abort",
        () => {
          deps.getAbortController()?.abort(deps.externalAbortContext?.reason());
        },
        { once: true },
      );
    } else {
      deps.setAbortController(new AbortController());
    }
    const signal = deps.getAbortController()!.signal;
    deps.emitSubagentStatus(null);

    // Phase 5 Fix 1 — reset the per-session step counter at every user-turn
    // boundary. The original Phase 4 design kept the counter per-SESSION so a
    // wandering agent bursting 50 tools across pseudo-turns would still trip
    // the ceiling. In practice that punishes legitimate multi-turn work: turn
    // 1 fills the counter, turn 2 (even a deliberate continuation) is halted
    // almost immediately because the ceiling row may resolve smaller for the
    // continuation's classified task. A new user message is an explicit
    // human-in-the-loop signal — the user has seen results and chose to
    // continue. Reset the counter so each user turn gets the full budget the
    // matrix specifies for its own (taskType, size). Within-turn wandering
    // is still capped by the per-turn ceiling, which is the real concern.
    if (deps.session?.id) {
      resetSessionStep(deps.session.id);
    }

    // Phase C3: advance the cross-turn dedup turn counter so stubs can point
    // back to the correct prior turn.
    deps.crossTurnDedup?.beginTurn();

    // P0 native observation: turn boundary. Capture the prior batch via
    // resetBatch — file-revert detection (in the hook layer) reads it on
    // the first edit of the new turn. No language-based veto matching.
    try {
      getMistakeDetector().resetBatch();
      if (deps.session?.id) {
        fireTrajectoryEvent({
          ts: new Date().toISOString(),
          sessionId: deps.session.id,
          kind: "user_turn",
          excerpt: userMessage.slice(0, 200),
          vetoDetected: false,
        });
      }
    } catch {
      /* fail-open: detector state must never block the turn */
    }

    // P0 native observation: AbortSignal → fire user-veto for any in-flight
    // batch tools that had warnings. Listener attaches here and self-removes
    // after fire so it can't double-fire on later aborts in the same turn.
    {
      const aborter = () => {
        try {
          // P1 Item 3 wiring: mark current phase aborted so the next setPhase
          // call drains an "abandoned" outcome.
          phaseTracker.markAborted(
            deps.getAbortController()?.signal.reason ? String(deps.getAbortController()!.signal.reason) : undefined,
          );
        } catch {
          /* fail-open */
        }
        try {
          const det = getMistakeDetector();
          const events = det.detectAbort(
            deps.getAbortController()?.signal.reason ? String(deps.getAbortController()!.signal.reason) : undefined,
          );
          if (events.length === 0) return;
          const cwd = deps.bash.getCwd();
          const tenantId = getTenantIdForVeto();
          void buildScopeForVeto({ cwd })
            .then(async (scope) => {
              const { getDefaultEEClient } = await import("../ee/intercept.js");
              for (const ev of events) {
                void getDefaultEEClient()
                  .posttool({
                    toolName: ev.toolName,
                    toolInput: ev.toolInput,
                    outcome: { success: false, mistakeKind: ev.kind, evidence: ev.evidence },
                    cwd,
                    tenantId,
                    scope,
                  })
                  .catch(() => {
                    /* fire-and-forget */
                  });
              }
            })
            .catch(() => {
              /* fire-and-forget */
            });
        } catch {
          /* fail-open */
        }
      };
      signal.addEventListener("abort", aborter, { once: true });
    }

    // Phase 4 Plan 04 (4B) — parse `--budget-rounds N` flag BEFORE PIL so the
    // flag never reaches the model and never biases intent classification.
    // The stashed override is consumed after PIL produces taskType + size.
    const _budgetOverride = parseBudgetOverride(userMessage);
    if (_budgetOverride.override !== undefined) {
      userMessage = _budgetOverride.cleanedPrompt;
    }

    // P0 native observation: cache turn-level intent fields for PreToolUse.
    deps.setTurnUserGoalExcerpt(userMessage.slice(0, 200));
    deps.setTurnAssistantReasoning("");

    // Ensure flow run is ready before processing (fail-open).
    await deps.flowReady?.catch(() => {});

    // Upgrade to OAuth-backed provider on first turn if tokens are available.
    await deps.initOAuthProvider().catch(() => {});

    if (!deps.getSessionStartHookFired()) {
      deps.setSessionStartHookFired(true);
      const isResume = deps.messages.length > 0;
      const sessionStartInput: SessionStartHookInput = {
        hook_event_name: "SessionStart",
        source: isResume ? "resume" : "startup",
        session_id: deps.session?.id,
        cwd: deps.bash.getCwd(),
      };
      await deps.fireHook(sessionStartInput, signal).catch(() => {});
    }

    const promptInput: UserPromptSubmitHookInput = {
      hook_event_name: "UserPromptSubmit",
      user_prompt: userMessage,
      session_id: deps.session?.id,
      cwd: deps.bash.getCwd(),
    };
    await deps.fireHook(promptInput, signal).catch(() => {});

    await deps.consumeBackgroundNotifications();

    const _debugOn = isDebugEnabled();
    const _debugSteps: PipelineStep[] = [];
    const _debugTurnId = deps.messages.filter((m) => m.role === "user").length + 1;

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
      showAcceptance: async (card) => {
        const { buildAcceptanceQuestion } = await import("../pil/layer18-acceptance.js");
        const question = buildAcceptanceQuestion(card, crypto.randomUUID());
        pilChunkQueue.push({
          type: "council_question",
          content: question.question,
          councilQuestion: question,
        } as StreamChunk);
        const text = await pilResponder(question.questionId);
        return text.toLowerCase() as "accept" | "adjust" | "cancel";
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
          llmFallback = createLlmClassifier(deps.requireProvider(), deps.modelId);
        } catch (err) {
          console.error(`[pil] LLM fallback wiring failed: ${(err as Error)?.message}`);
        }

        // Model-driven clarification proposer (for discovery interview).
        // The actual task model (via the same provider + modelId) generates the
        // questions based on raw + CLI enrichment. Then discovery asks user.
        let clarificationProposer: import("../pil/discovery-types.js").ModelClarificationProposer | undefined;
        try {
          const { createModelClarificationProposer } = await import("../pil/discovery.js");
          clarificationProposer = createModelClarificationProposer(deps.requireProvider(), deps.modelId);
        } catch (err) {
          console.error(`[pil] clarification proposer wiring failed: ${(err as Error)?.message}`);
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
    // Track whether forced-finalize is needed (set by stopWhen when the
    // ceiling fires). Read AFTER the streamText fullStream finishes.
    const _ceilingHit = false;

    // Cheap signal forwarded from PIL Layer 1 — true when input is greeting /
    // small-talk (≤10 chars + ≤2 words OR brain-classified "none"). Used to
    // skip the MCP tool catalog, which dominates input tokens (~20K) and is
    // useless for "hi" / "ok" / "thanks".
    const isChitchat = pilCtx.intentKind === "chitchat";
    let enrichedMessage = pilCtx.enriched;
    if (pilCtx.fallbackReason) {
      // Surface PIL degradation to the model so it can calibrate trust in
      // routing, taskType, and any injected directives. Without this the
      // agent has no idea the 200ms fast-path or discovery timeout fired.
      enrichedMessage = `[PIL fallback: ${pilCtx.fallbackReason} — classification/routing may be inaccurate or layers skipped; using raw input.]\n\n${enrichedMessage}`;
    }
    deps.setPilActive(pilCtx.taskType !== null);
    deps.setPilEnrichmentDelta(
      pilCtx.metrics?.suffixInstructionTokens ?? Math.round((enrichedMessage.length - userMessage.length) / 4),
    );
    const _pilEnrichmentDeltaSnapshot =
      pilCtx.metrics?.suffixInstructionTokens ?? Math.round((enrichedMessage.length - userMessage.length) / 4);

    // P1 Item 3 wiring: phase-boundary detection. setPhase returns a snapshot
    // of the prior phase iff the phase NAME just changed. We classify the
    // outcome (pass/fail/abandoned/null) and fire phase-outcome to the EE
    // server when there is a high-SNR verdict. Endpoint is feature-flagged
    // server-side; 404 is silently swallowed by the client wrapper.
    try {
      const drained = phaseTracker.setPhase(pilCtx.gsdPhase ?? null);
      if (drained && drained.principleRefs.length > 0 && deps.session?.id) {
        const outcome = phaseTracker.classifyOutcome(drained);
        if (outcome) {
          fireAndForgetPhaseOutcome(
            {
              sessionId: deps.session.id,
              phaseName: drained.phaseName,
              outcome,
              toolEventIds: drained.principleRefs,
              evidence: {
                durationMs: drained.endedAt - drained.startedAt,
                toolCount: drained.toolCount,
                cwd: deps.bash.getCwd(),
                ...(drained.verifyResult ? { verifyResult: drained.verifyResult } : {}),
                ...(drained.aborted ? { aborted: true } : {}),
                ...(drained.abortReason ? { abortReason: drained.abortReason } : {}),
              },
            },
            {
              ...(getCachedServerBaseUrl() ? { baseUrl: getCachedServerBaseUrl()! } : {}),
              ...(getCachedAuthToken() ? { authToken: getCachedAuthToken()! } : {}),
            },
          );
        }
      }
    } catch {
      /* fail-open: phase-outcome must never block a turn */
    }

    if (_debugOn) {
      const appliedLayers = pilCtx.layers?.filter((l) => l.applied).map((l) => l.name) ?? [];
      _debugSteps.push({
        name: "PIL Pipeline",
        duration_ms: Date.now() - _pilStart,
        input_summary: `"${userMessage.slice(0, 60)}${userMessage.length > 60 ? "..." : ""}"`,
        output_summary: `task=${pilCtx.taskType ?? "none"} domain=${pilCtx.domain ?? "none"} layers=[${appliedLayers.join(",")}]`,
        tokens_saved: _pilEnrichmentDeltaSnapshot > 0 ? _pilEnrichmentDeltaSnapshot : undefined,
      });
    }

    // Interaction log: PIL classification
    try {
      if (deps.session) {
        const pilDurationMs = Date.now() - _pilStart;
        // BUG-B telemetry — hash the raw user message so post-hoc queries can
        // detect Layer 1 classifier drift on identical inputs within a session.
        const { createHash } = await import("node:crypto");
        const _userMsgSha8 = createHash("sha1").update(userMessage).digest("hex").slice(0, 8);
        logInteraction(deps.session.id, "pil", {
          eventSubtype: pilCtx.taskType ?? "none",
          durationMs: pilDurationMs,
          data: {
            userMsgSha8: _userMsgSha8,
            userMsgPreview: userMessage.slice(0, 60),
            layers: pilCtx.layers?.filter((l) => l.applied).map((l) => l.name) ?? [],
            fullLayers: pilCtx.layers?.map((l) => ({ name: l.name, applied: l.applied, delta: l.delta })) ?? [],
            layerCount: pilCtx.layers?.length ?? 0,
            layerTimings: pilCtx.metrics?.layerTimings ?? null,
            domain: pilCtx.domain,
            confidence: pilCtx.confidence,
            outputStyle: pilCtx.outputStyle,
            intentKind: pilCtx.intentKind ?? null,
            mcpSkipped: isChitchat,
            fallbackReason: pilCtx.fallbackReason ?? null,
            eeMode: (await import("../ee/client-mode.js")).getCachedEEClientMode()?.mode ?? "unknown",
          },
        });
        logInteraction(deps.session.id, "user_message", {
          data: {
            raw_length: userMessage.length,
            enriched_length: enrichedMessage.length,
            taskType: pilCtx.taskType,
            intentKind: pilCtx.intentKind ?? null,
            confidence: pilCtx.confidence,
            pilActive: pilCtx.taskType !== null,
          },
        });
      }
    } catch {
      /* fail-open */
    }

    // ROUTE-11: Per-turn model routing via decide() — picks cheapest capable model
    const turnStartMs = Date.now();
    let turnModelId = deps.modelId;
    let taskHash: string | null = null;
    const _routeStart = Date.now();
    try {
      const { decide } = await import("../router/decide.js");
      const routeDecision = await decide(userMessage, {
        tenantId: "local",
        cwd: deps.bash.getCwd(),
        defaultModel: deps.modelId,
        defaultProvider: deps.providerId,
        pil: {
          domain: pilCtx.domain,
          taskType: pilCtx.taskType,
          confidence: pilCtx.confidence,
          gsdPhase: pilCtx.gsdPhase ?? null,
          activeRunId: pilCtx.activeRunId ?? null,
          recentTurnsSummary: deps.buildRecentTurnsSummary(),
          projectSize: deps.estimateProjectSize(),
          filesTouched: deps.countFilesTouched(),
          mode: deps.mode,
        },
      });
      if (routeDecision.model && routeDecision.model !== "HALT") {
        // Respect user's default model when it has a vision proxy and the
        // current turn (or history) has images — the proxy will convert
        // images to text, so there's no need to switch to a vision-capable
        // (and usually pricier / rate-limited) model.
        const defaultHasVisionProxy = needsVisionProxy(deps.modelId);
        const historyHasImages = deps.messages.some(
          (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((p) => p.type === "image"),
        );
        const turnHasImages = (images?.length ?? 0) > 0;
        const skipVisionRoute = defaultHasVisionProxy && (turnHasImages || historyHasImages);
        if (!skipVisionRoute) {
          turnModelId = routeDecision.model;
        }
      }
      taskHash = routeDecision.taskHash ?? null;
      // Update status bar with router switch info. Also reset back to the
      // session default when the router does NOT switch on this turn —
      // otherwise the bar stays "stuck" showing the previously-routed model
      // (e.g. claude-sonnet-4-6) on later turns that actually run on the
      // user's chosen default (e.g. deepseek-v4-flash).
      if (turnModelId !== deps.modelId) {
        statusBarStore.setState({ routed_from: deps.modelId, model: turnModelId });
      } else {
        const prev = statusBarStore.getState();
        if (prev.routed_from || prev.model !== deps.modelId) {
          statusBarStore.setState({ routed_from: null, model: deps.modelId });
        }
      }
      if (_debugOn) {
        _debugSteps.push({
          name: "Router",
          duration_ms: Date.now() - _routeStart,
          input_summary: `default=${deps.modelId}`,
          output_summary: turnModelId !== deps.modelId ? `routed→${turnModelId}` : `kept ${turnModelId}`,
        });
      }
    } catch {
      // Router unavailable — use session default model (skip if provider is disabled)
      if (!isProviderDisabled(deps.providerId as ProviderId)) {
        const eeRoute = await routeModel(userMessage, {}, deps.providerId).catch(() => null);
        taskHash = eeRoute?.taskHash ?? null;
      }
    }

    // Interaction log: model routing
    try {
      if (deps.session) {
        logInteraction(deps.session.id, "routing", {
          model: turnModelId,
          data: {
            defaultModel: deps.modelId,
            routedModel: turnModelId,
            taskHash,
            pilTaskType: pilCtx.taskType ?? null,
            pilIntentKind: pilCtx.intentKind ?? null,
          },
        });
      }
    } catch {
      /* fail-open */
    }

    // Re-detect provider if router picked a model from a different provider
    const turnProviderId = detectProviderForModel(turnModelId);
    let turnProvider: LegacyProvider;
    if (turnProviderId !== deps.providerId) {
      // Even if the key is reachable, skip disabled providers
      const turnKey = !isProviderDisabled(turnProviderId as ProviderId)
        ? await loadKeyForProvider(turnProviderId).catch(() => null)
        : null;
      if (turnKey) {
        const { createProviderFactory } = await import("../providers/runtime.js");
        turnProvider = createProviderFactory(turnProviderId, { apiKey: turnKey }).factory;
      } else {
        // Router's provider unreachable or disabled — fall back to a non-disabled provider
        const fallback = await deps.councilManager.resolveNonDisabledFallback();
        turnModelId = fallback.modelId;
        turnProvider = deps.requireProvider();
      }
    } else if (isProviderDisabled(deps.providerId as ProviderId)) {
      // Session provider is disabled — find a non-disabled alternative
      const fallback = await deps.councilManager.resolveNonDisabledFallback();
      turnModelId = fallback.modelId;
      turnProvider = deps.requireProvider();
    } else {
      turnProvider = deps.requireProvider();
    }

    // E4: prepend one-shot cwd note when setCwd() changed the working directory
    // mid-session. Clears after injection so only the first subsequent turn sees it.
    const cwdNote = deps.getPendingCwdNote();
    deps.setPendingCwdNote(null);
    const messageForModel = cwdNote ? `${cwdNote}\n\n${enrichedMessage}` : enrichedMessage;

    let userModelMessage: ModelMessage;
    if (images?.length) {
      const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> = [
        { type: "text", text: messageForModel },
      ];
      for (const img of images) {
        parts.push({ type: "image", image: img.base64, mediaType: img.mediaType });
      }
      userModelMessage = { role: "user", content: parts };
    } else {
      userModelMessage = { role: "user", content: messageForModel };
    }

    // Vision proxy: convert images to text for models that don't support vision.
    // Process BOTH the current user message and any historical messages that
    // still carry image parts — otherwise sending the conversation back to a
    // text-only provider (e.g. DeepSeek) fails with "unknown variant
    // `image_url`" once history contains an image from a prior turn.
    if (needsVisionProxy(turnModelId)) {
      const historyHasImages = deps.messages.some(
        (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((p) => p.type === "image"),
      );
      const turnHasImages = (images?.length ?? 0) > 0;
      if (turnHasImages || historyHasImages) {
        try {
          if (historyHasImages) {
            const historyResult = await proxyVision(deps.messages, turnModelId, signal);
            if (historyResult.proxied) {
              deps.setMessages(historyResult.messages);
              yield {
                type: "content",
                content: `[Vision proxy: ${historyResult.imageCount} historical image(s) → text]\n`,
              };
            }
          }
          if (turnHasImages) {
            const proxyResult = await proxyVision([userModelMessage], turnModelId, signal);
            if (proxyResult.proxied) {
              userModelMessage = proxyResult.messages[0];
              yield {
                type: "content",
                content: `[Vision proxy: ${proxyResult.imageCount} image(s) → ${turnModelId} via SiliconFlow]\n`,
              };
            }
          }
        } catch {
          yield { type: "content", content: "[Vision proxy: failed, images dropped]\n" };
          if (turnHasImages) {
            userModelMessage = { role: "user", content: enrichedMessage };
          }
          // Strip image parts from history as a last-resort fallback so the
          // request doesn't blow up at the provider serialization layer.
          deps.setMessages(
            deps.messages.map((m) => {
              if (!Array.isArray(m.content)) return m;
              const filtered = (m.content as Array<{ type: string }>).filter((p) => p.type !== "image");
              return { ...m, content: filtered } as typeof m;
            }),
          );
        }
      }
    }

    deps.messages.push(userModelMessage);
    // Phase A5 — write-ahead the user row so `recordUsage` mid-stream can
    // attribute usage to a real `message_seq` instead of falling back to
    // NULL (or to the previous turn's assistant seq for a session that has
    // multi-turn history). The post-stream `appendCompletedTurn(...)` path
    // upserts the same row to `status='completed'` via the
    // `ON CONFLICT(session_id, seq) DO UPDATE` clause in `appendMessages`.
    let userWriteAheadSeq: number | null = null;
    if (deps.session) {
      try {
        userWriteAheadSeq = getNextMessageSequence(deps.session.id);
        persistMessageWriteAhead(deps.session.id, userWriteAheadSeq, "user", JSON.stringify(userModelMessage));
      } catch {
        // Fail-open: if seq lookup throws, fall back to the legacy NULL
        // path. The forensics anomaly returns but the turn proceeds.
        userWriteAheadSeq = null;
      }
    }
    deps.messageSeqs.push(userWriteAheadSeq);

    // Inject accumulated EE session guidance as a system message so the model
    // is informed of past warnings before making tool decisions this turn.
    if (deps.sessionEEGuidance.size > 0) {
      const lines = Array.from(deps.sessionEEGuidance.entries()).map(([, g]) => {
        const pct = Math.round(g.confidence * 100);
        return `- [${g.toolName}] ${g.message} (Why: ${g.why}) [${pct}%]`;
      });
      deps.messages.push({
        role: "system",
        content: `[EE Session Guidance — avoid these patterns when using tools]\n${lines.join("\n")}`,
      });
      deps.messageSeqs.push(null);
    }

    const provider = turnProvider;
    const subagents = loadValidSubAgents();
    const _pilResponseTools = getResponseToolSet(pilCtx, deps.providerId);
    const _hasResponseTools = Object.keys(_pilResponseTools).length > 0;
    const systemParts = buildSystemPromptParts(
      deps.bash.getCwd(),
      deps.mode,
      deps.bash.getSandboxMode(),
      deps.getPlanContext(),
      subagents,
      deps.bash.getSandboxSettings(),
      deps.providerId,
      deps.getResumeDigest(),
      { chitchat: isChitchat },
    );
    if (deps.getResumeDigest()) deps.setResumeDigest(null);
    // Skip vision/playwright guidance unless the user's message has a URL
    // or browser/screenshot vocabulary. ~400 tokens of routing hints
    // the model only needs when it might call a browser MCP.
    const _browserGuidanceNeeded =
      /https?:\/\/\S+|\b(screenshot|browser|playwright|chrome|figma|canva|render|webpage|website|url|hyperlink|navigate|click|scrape)\b/i.test(
        userMessage,
      );
    const playwrightGuidance = isChitchat || !_browserGuidanceNeeded ? "" : getVisionGuidanceForTextOnly(turnModelId);
    const system = applyModelConstraints(
      applyPilSuffix(
        `${systemParts.staticPrefix}${playwrightGuidance}${systemParts.dynamicSuffix}`,
        pilCtx,
        _hasResponseTools,
      ),
      turnModelId,
    );
    let runtime = resolveModelRuntime(provider, turnModelId);
    let modelInfo = runtime.modelInfo;

    // SAMR: Step-Aware Model Routing — downgrade to fast model for tool-execution
    // steps after the initial reasoning step. The premium model decides WHAT to do;
    // a cheaper model handles the mechanical "read results, call more tools" loop.
    const stepRouterCfg = getStepRouterConfig();
    const stepRouterDecision = decideStepRouting(turnModelId, deps.providerId, stepRouterCfg);
    let stepRouterPhase: "phase1" | "phase2" | "done" = stepRouterDecision.phase2ModelId ? "phase1" : "done";
    const phase2Runtime = stepRouterDecision.phase2ModelId
      ? resolveModelRuntime(provider, stepRouterDecision.phase2ModelId)
      : null;
    if (stepRouterDecision.phase2ModelId && _debugOn) {
      _debugSteps.push({
        name: "StepRouter",
        duration_ms: 0,
        input_summary: `phase1=${turnModelId}`,
        output_summary: stepRouterDecision.reason,
      });
    }

    deps.setPlanContext(null);
    let attemptedOverflowRecovery = false;
    // Stream-retry state: track how many transient retries have been attempted
    // for the current turn. Reset to 0 on each new user turn (we're in processMessage).
    let streamRetryCount = 0;
    const MAX_STREAM_RETRIES = 2; // 3 total attempts = 1 first try + 2 retries
    // Re-steer budget for a tool-call emitted as plain text (wrong dialect). One
    // corrective retry: if the model still emits text instead of invoking the
    // tool, we surface the warning and stop rather than loop. Loop-persistent so
    // a model that degrades every step can't burn unbounded re-steers.
    let textToolReSteerCount = 0;
    const MAX_TEXT_TOOL_RESTEER = 1;
    // Silent-hang guard: set true when the stall watchdog aborts a stuck stream.
    // Reset before each streamText attempt; read in the stream catch to surface a
    // clear toast and SKIP the transient-retry (a stalled provider just stalls
    // again, wasting another full timeout of silence).
    let stallTriggered = false;
    // Time-to-first-byte stall RE-PROMPT: some providers (observed:
    // xai/grok-build-0.1) accept the request then never send the first byte —
    // a single wedged socket, not a down backend, so a fresh request usually
    // goes through. When the watchdog fires with ZERO chunks received this
    // attempt, we re-issue the SAME request up to `maxStallRetries` times
    // (loop-persistent counter). Gated on zero-chunks so it can NEVER restart a
    // turn that already ran tools or emitted text — those go to the partial-
    // answer rescue path instead. maxStallRetries = 0 restores legacy behaviour.
    let stallRetryCount = 0;
    const maxStallRetries = getProviderStallRetries();

    // Auto-council: route to multi-model debate when EITHER
    //   (a) PIL classified taskType=plan|analyze with high confidence AND the
    //       prompt is complex enough to justify the debate cost, OR
    //   (b) GSD-native tier === "heavy" (wholesale / multi-step / cross-repo work).
    // After the debate finishes, runCouncilV2 records synthesis on
    // councilManager.lastSynthesis; we then re-enter processMessage with the synthesis
    // as the next user turn so the main loop continues with full debate context.
    // Skip if this is already a council continuation turn (prevent infinite recursion).
    //
    // Phase 5 BUG-I (session f1a2a2a547db) — the gate previously fired on
    // taskType=analyze + conf≥0.85 alone, with no complexity check. Result:
    // "improve test coverage cho src/X.ts" (single-file, scoreComplexity=low,
    // score=2) sank 13 minutes into council debate, then halted on pattern-loop
    // after sprint 1 read 6 files. The complexity gate below bypasses council
    // for low-complexity analyze prompts — they get the hot-path direct exec
    // and stay productive. `plan` keeps the old behaviour (architectural
    // decisions deserve debate regardless of length).
    const autoCouncilTypes = new Set(["plan", "analyze"]);
    const councilRoles = getRoleModels();
    const configuredRoleCount = Object.values(councilRoles).filter(Boolean).length;
    const heavyTier = (pilCtx as { complexityTier?: string | null }).complexityTier === "heavy";
    const autoCouncilConfidence = getAutoCouncilConfidence();
    const autoCouncilMinRoles = getAutoCouncilMinRoles();
    const _complexityFromTrace = (pilCtx as { _intentTrace?: { complexity?: "low" | "medium" | "high" } })._intentTrace
      ?.complexity;
    const _complexityGatePassed =
      pilCtx.taskType === "plan" || _complexityFromTrace === undefined || _complexityFromTrace !== "low";
    const taskTypeMatch =
      pilCtx.taskType &&
      autoCouncilTypes.has(pilCtx.taskType) &&
      pilCtx.confidence >= autoCouncilConfidence &&
      _complexityGatePassed;
    const shouldAutoCouncil =
      !deps.councilManager.isContinuation &&
      isAutoCouncilEnabled() &&
      configuredRoleCount >= autoCouncilMinRoles &&
      (taskTypeMatch || heavyTier);

    // Always log the auto-council decision (taken or skipped) with the gate
    // values that decided it. Lets reports answer "why did this turn cost
    // $0.30?" and "is the confidence floor tuned wrong for my prompts?".
    const autoCouncilSkipReason = (() => {
      if (deps.councilManager.isContinuation) return "continuation-turn";
      if (!isAutoCouncilEnabled()) return "feature-disabled";
      if (configuredRoleCount < autoCouncilMinRoles)
        return `role-count<${autoCouncilMinRoles} (have ${configuredRoleCount})`;
      if (!taskTypeMatch && !heavyTier) {
        if (!pilCtx.taskType || !autoCouncilTypes.has(pilCtx.taskType))
          return `taskType=${pilCtx.taskType ?? "null"} not in plan|analyze`;
        if (pilCtx.confidence < autoCouncilConfidence)
          return `confidence<${autoCouncilConfidence} (got ${pilCtx.confidence.toFixed(2)})`;
        if (!_complexityGatePassed)
          return `complexity=low + taskType=${pilCtx.taskType} (analyze needs medium+; plan bypasses gate)`;
        return "no-trigger";
      }
      return "taken";
    })();
    appendDecisionLog({
      ts: Date.now(),
      sessionId: deps.session?.id ?? null,
      kind: "auto-council",
      taken: shouldAutoCouncil,
      reason: autoCouncilSkipReason,
      meta: {
        taskType: pilCtx.taskType ?? null,
        confidence: pilCtx.confidence,
        complexityTier: (pilCtx as { complexityTier?: string | null }).complexityTier ?? null,
        complexityScore: _complexityFromTrace ?? null,
        complexityGatePassed: _complexityGatePassed,
        configuredRoleCount,
        autoCouncilConfidence,
        autoCouncilMinRoles,
        heavyTier,
        isContinuation: deps.councilManager.isContinuation,
      },
    }).catch(() => undefined);

    if (shouldAutoCouncil) {
      const reason = heavyTier
        ? `complexity=heavy${pilCtx.taskType ? ` task=${pilCtx.taskType}` : ""}`
        : `${pilCtx.taskType} task detected with ${(pilCtx.confidence * 100).toFixed(0)}% confidence`;
      yield { type: "content", content: `\n[Auto-council triggered: ${reason}]\n` };
      yield* deps.runCouncilV2(userMessage, { skipClarification: true, observer, userModelMessage });
      const synthesis = deps.councilManager.lastSynthesis;
      deps.councilManager.setLastSynthesis(null);
      if (synthesis) {
        yield { type: "content", content: "\n[Auto-continuing with council recommendations...]\n" };
        deps.councilManager.setContinuation(true);
        try {
          yield* deps.processMessage(
            `Council debate completed. Synthesis:\n\n${synthesis}\n\nProceed with the recommended action items.`,
            observer,
          );
        } finally {
          deps.councilManager.setContinuation(false);
        }
      }
      return;
    }

    if (deps.batchApi) {
      try {
        yield* deps.processMessageBatchTurn({
          userModelMessage,
          observer,
          provider,
          subagents,
          system,
          runtime,
          modelInfo,
          signal,
        });
      } finally {
        if (deps.getAbortController()?.signal === signal) {
          deps.setAbortController(null);
        }
      }
      return;
    }

    try {
      streamAttempt: while (true) {
        // SAMR Phase 2: switch to fast model for tool-execution steps
        if (stepRouterPhase === "phase2" && phase2Runtime) {
          runtime = phase2Runtime;
          modelInfo = runtime.modelInfo;
        }

        deps.setCompactedThisTurn(false);
        let assistantText = "";
        // Count of stream parts received in THIS attempt. Stays 0 only when the
        // provider never sent a first byte → the safe-to-re-prompt stall case.
        let chunksThisAttempt = 0;
        // Decide whether a fired stall watchdog should re-prompt (re-issue the
        // same request) instead of falling through to rescue/error. Returns the
        // backoff ms to wait before re-issuing, or null to NOT re-prompt. Reads
        // the live per-attempt locals; safe to call only when stallTriggered.
        const planStallReprompt = (): number | null => {
          if (
            !shouldRepromptStall({
              stallTriggered,
              stallRetryCount,
              maxStallRetries,
              chunksThisAttempt,
              assistantTextEmpty: assistantText.trim() === "",
              aborted: signal.aborted,
            })
          ) {
            return null;
          }
          stallRetryCount++;
          const backoffMs = stallRepromptBackoffMs(stallRetryCount);
          try {
            const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
              | { emitEvent: (e: unknown) => void }
              | undefined;
            _ar?.emitEvent({
              t: "event",
              kind: "stream-retry",
              attempt: stallRetryCount,
              maxAttempts: maxStallRetries + 1,
              errorName: "TimeoutError",
              errorMessage: "provider-stall (no first byte) — re-prompting",
              nextDelayMs: backoffMs,
            });
            _ar?.emitEvent({
              t: "event",
              kind: "toast",
              level: "warning",
              text: `Model stalled — re-prompting (attempt ${stallRetryCount}/${maxStallRetries})…`,
            });
          } catch (emitErr) {
            console.error(`[message-processor] stall-reprompt telemetry failed: ${(emitErr as Error)?.message}`);
          }
          try {
            if (deps.session) {
              logInteraction(deps.session.id, "stream_retry", {
                data: {
                  attempt: stallRetryCount,
                  maxAttempts: maxStallRetries + 1,
                  errorName: "provider-stall",
                  errorMessage: "no first byte within stall timeout — re-prompted",
                  nextDelayMs: backoffMs,
                },
              });
            }
          } catch (logErr) {
            console.error(`[message-processor] stall-reprompt log failed: ${(logErr as Error)?.message}`);
          }
          return backoffMs;
        };
        // Tracks where `assistantText` was at the previous step boundary so
        // `onStepFinish` can compute the text emitted within the just-finished
        // step (input to the self-repetition detector).
        let _assistantTextAtLastStep = 0;
        let reasoningPreview = "";
        let encryptedReasoningHidden = false;
        let streamOk = false;
        let closeMcp: (() => Promise<void>) | undefined;
        let stepNumber = -1;
        const activeToolCalls: ToolCall[] = [];
        // Capped digest of tool outputs gathered this attempt — fuels the
        // best-effort answer rescue if the stream stalls mid-turn (see
        // stall-rescue.ts). Reset per attempt; only the most recent results win.
        const turnToolResults: StallToolResult[] = [];
        // SAMR: track whether Phase 1 produced tool calls
        let phase1HadToolCalls = false;

        try {
          const settings = attemptedOverflowRecovery
            ? relaxCompactionSettings(deps.getCompactionSettings(modelInfo?.contextWindow))
            : deps.getCompactionSettings(modelInfo?.contextWindow);
          if (modelInfo?.contextWindow) {
            await deps.compactForContext(
              provider,
              system,
              modelInfo.contextWindow,
              signal,
              settings,
              attemptedOverflowRecovery,
            );
          }

          // Vision-tool gate: for vision-proxy (text-only) models the registry
          // adds 3 image tools (~500-700 tok) on every turn. Drop them when the
          // turn has no plausible image involvement. Bias is KEEP — retained on
          // any image signal, attachment, cached image, or prior-tool turn.
          const includeVisionTools = visionToolsNeeded({
            userMessage,
            messages: deps.messages as unknown[],
            cachedImageCount: listCachedImages().length,
            priorTurnHadTools: (deps.messages as Array<{ role?: string }>).some((m) => m?.role === "tool"),
          });
          const baseToolsRaw = createBuiltinTools(deps.bash, deps.mode, {
            runTask: (request, abortSignal) => deps.runTask(request, combineAbortSignals(signal, abortSignal)),
            runDelegation: (request, abortSignal) =>
              deps.runDelegation(request, combineAbortSignals(signal, abortSignal)),
            readDelegation: (id) => deps.readDelegation(id),
            listDelegations: () => deps.listDelegations(),
            modelId: turnModelId,
            includeVisionTools,
          });
          // Top-level cumulative cap state. We accumulate the raw tool set
          // (base + MCP + PIL response tools) across the assembly below,
          // then apply the cap once. Tier ratios are looser than the
          // sub-agent cap (50%/80%) so casual single-tool turns are not
          // trimmed. See sub-agent-cap.ts.
          // Chitchat: drop builtin tools too (not just MCP). A 1-word greeting
          // never needs bash/read_file/edit_file/grep — those schemas alone
          // cost ~1.5K input tokens on this CLI. Falls back to baseTools for
          // every non-chitchat turn (PIL gates conservatively).
          //
          // BUG-A guard — when prior turns already issued tool_calls (their
          // results still live in the messages history), DROPPING tools on a
          // continuation chitchat ("tiếp tục" / "continue") causes two
          // failures: (1) DeepSeek goes into native DSML markup fallback
          // because it sees tool-call history but no schema (visible in
          // sessions 002df4014cb4 + fc19b4daee20); (2) the agent has no way
          // to actually CONTINUE the prior task — the user's clear intent.
          // Detect prior-tool-context and keep the base tool set in that
          // case. The 1.5K token saving for true greetings (no prior tool
          // history) is preserved.
          const turnCaps = getProviderCapabilities(requireRuntimeProvider(runtime));
          const _priorTurnHadTools = (deps.messages as Array<{ role?: string }>).some((m) => m?.role === "tool");
          let rawToolSet: ToolSet = !turnCaps.supportsClientTools(runtime.modelInfo)
            ? {}
            : isChitchat && !_priorTurnHadTools
              ? {}
              : baseToolsRaw;
          // MCP skip: chitchat / greeting inputs don't need 7 MCP servers'
          // worth of tool schemas (~20K input tokens). PIL Layer 1 already
          // gates this conservatively (≤10 chars + ≤2 words OR brain "none").
          if (
            deps.mode === "agent" &&
            (!isChitchat || _priorTurnHadTools) &&
            turnCaps.supportsClientTools(runtime.modelInfo)
          ) {
            // Smart MCP filter: drop OPTIONAL MCP servers whose category the
            // current message gives no signal for. Browser/vision servers
            // (Playwright/Chrome/Figma/Canva) skip unless the message touches a
            // page; docs/web servers (context7/fetch) skip unless the message
            // looks like an external lookup. Each MCP contributes 8-15 tools at
            // ~150 tok each, so local code work — the majority of turns — saves
            // ~13K input tokens it would otherwise pay every turn. Domain
            // servers (filesystem/tools/harness) always pass through. Logic is
            // a pure helper (src/mcp/smart-filter.ts) so it is unit-tested.
            // Override with MUONROI_DISABLE_SMART_MCP=1.
            const filteredServers = filterMcpServersByMessage(loadMcpServers(), userMessage, {
              disabled: process.env.MUONROI_DISABLE_SMART_MCP === "1",
            });
            // Ecosystem question → muonroi-docs is the authoritative source the
            // agent is nudged to consult FIRST. Wait for it specifically beyond the
            // normal deadline so a cold first-connect lands THIS turn instead of
            // "ready next turn" (session 584ba476c07a: first ecosystem question
            // missed docs while warming → agent guessed from local files).
            const criticalServerIds = mentionsEcosystemScope(userMessage)
              ? filteredServers
                  .filter((s) => /(^|[-_])docs([-_]|$)/.test(s.id) && /muonroi/i.test(s.id))
                  .map((s) => s.id)
              : undefined;
            // MCP non-blocking: acquireMcpTools self-bounds — it connects servers
            // in parallel and returns PARTIAL results at its internal deadline
            // (fast/cached servers included; slow first-connects reported in
            // .errors and available next turn). Clients are POOLED across turns
            // (client-pool.ts), so a server cold-spawns at most once per session
            // instead of every turn. No outer race: the old race discarded the
            // WHOLE bundle on timeout (Phase 1c — session f6f7881a5fae).
            let mcpBundle: any = null;
            try {
              mcpBundle = await acquireMcpTools(filteredServers, {
                onOAuthRequired: (_serverId, url) => {
                  // Server-supplied URL is untrusted — openUrl validates the
                  // scheme and spawns via execFile (no shell), closing the
                  // command-injection vector the old exec() opener had.
                  openUrl(url);
                },
                ...(criticalServerIds && criticalServerIds.length > 0 ? { criticalServerIds } : {}),
              });
            } catch (err) {
              console.error("[MCP] buildMcpToolSet failed, proceeding with builtins only", err);
            }
            if (mcpBundle) {
              closeMcp = mcpBundle.close;
              // Drop filesystem-MCP read/write/edit tools that duplicate the
              // first-class builtin file tools. Without this, models re-read the
              // SAME file via both `read_file` and `mcp_filesystem__read_text_file`
              // (live grok session f5dfab0ce0ca: a 772-line file read 6×), wasting
              // ~150 tok/schema PLUS re-injecting whole files into context. The
              // builtins are strictly better (read-before-write, LSP, CRLF match,
              // dedup/read-budget wrappers). Non-duplicate fs tools are untouched.
              const _builtinToolNames = new Set(Object.keys(rawToolSet));
              const { tools: _dedupedMcpTools, dropped: _droppedFsMcp } = dropRedundantFsMcpTools(
                mcpBundle.tools,
                _builtinToolNames,
              );
              rawToolSet = { ...rawToolSet, ..._dedupedMcpTools };
              // muonroi-tools is THIS CLI: every tool it exposes (ee_query,
              // ee_feedback, ee_health, usage_forensics, lsp_query, setup_guide,
              // selfverify_*) is now a NATIVE in-process builtin (src/tools/
              // native-tools.ts) — strictly better (no subprocess, no cold-start).
              // If an external/legacy config still self-spawns muonroi-tools, drop
              // any MCP twin whose native equivalent is present so the model never
              // sees two interchangeable copies. (The CLI no longer self-spawns it
              // by default — see auto-setup.ts.)
              for (const key of Object.keys(rawToolSet)) {
                const twin = key.match(/^mcp_muonroi-tools__(.+)$/);
                if (twin && rawToolSet[twin[1]!]) delete rawToolSet[key];
              }
              if (_droppedFsMcp.length > 0 && deps.session) {
                try {
                  logInteraction(deps.session.id, "routing", {
                    model: turnModelId,
                    data: { droppedRedundantFsMcp: _droppedFsMcp },
                  });
                } catch {
                  /* telemetry best-effort */
                }
              }
              if (mcpBundle.errors.length > 0) {
                // A pooled server that is still cold-starting is NOT "unavailable"
                // — it's warming up and will be ready next turn. Only surface
                // GENUINE failures as "unavailable"; show warming servers as a
                // soft, non-alarming note (and only the first time, since the
                // pool connects them in the background).
                const warming = mcpBundle.errors.filter((e: string) => /still connecting/.test(e));
                const failed = mcpBundle.errors.filter((e: string) => !/still connecting/.test(e));
                if (failed.length > 0) {
                  yield { type: "content", content: `MCP unavailable: ${failed.join(" | ")}\n\n` };
                }
                if (warming.length > 0) {
                  const names = warming.map((e: string) => e.split(":")[0]).join(", ");
                  yield { type: "content", content: `MCP warming up (${names}) — ready from the next turn.\n\n` };
                }
              }
            }
          }

          // PIL response tools: inject structured output tool when taskType detected
          if (_hasResponseTools && turnCaps.supportsClientTools(runtime.modelInfo)) {
            rawToolSet = { ...rawToolSet, ..._pilResponseTools };
            captureToolSchemas(_pilResponseTools);
          }

          // Apply the top-level cumulative cap once over the fully-assembled
          // raw tool set. State is per-turn; each turn gets a fresh budget.
          const topLevelCap = wrapToolSetWithCap(rawToolSet, {
            maxCumulativeChars: getTopLevelToolBudgetChars(),
            midTierRatio: 0.5,
            highTierRatio: 0.8,
            label: "top-level",
          });
          // Phase C3: layer cross-turn dedup on top of the top-level cap.
          const tools: ToolSet = wrapToolSetWithReadBudget(
            wrapToolSetWithDedup(topLevelCap.tools, deps.crossTurnDedup),
            deps.readBudget,
          );
          captureToolSchemas(tools);
          let responseToolCalled = false;
          // A turn must surface exactly ONE final structured answer. Cheap
          // models sometimes emit the response tool MORE THAN ONCE in a single
          // step (session 9b1b39bf4dc6: grok emitted respond_general twice —
          // a 278-char "I must read the code" hedge, then the 3782-char real
          // answer — both in one step). Yielding each inline appends two
          // stacked structured_response blocks and shows the hedge first.
          // Instead we BUFFER the response-tool payloads and yield only the
          // most complete one (longest serialized data) after the stream
          // drains — robust to either ordering (hedge-then-answer or
          // answer-then-summary).
          let _pendingStructuredResponse: { taskType: string; data: Record<string, unknown> } | null = null;
          let _pendingStructuredResponseLen = -1;
          let _responseToolEmitCount = 0;

          // G3: providerOptions assembly is owned by the capability layer
          // (src/providers/capabilities.ts). buildTurnProviderOptions feeds
          // sessionId in so openai.promptCacheKey is derived per turn.
          // The task-type-driven anthropic.thinking budget override stays
          // here because it depends on PIL task context, not provider quirks.
          // biome-ignore lint/suspicious/noExplicitAny: matches RuntimeResult.providerOptions shape (any) used downstream
          const baseProviderOpts: any = buildTurnProviderOptions(runtime, { sessionId: deps.session?.id }) ?? {};
          const providerOpts = runtime.modelInfo?.reasoning
            ? {
                ...baseProviderOpts,
                anthropic: {
                  ...(baseProviderOpts.anthropic ?? {}),
                  thinking: {
                    type: "enabled" as const,
                    budgetTokens:
                      taskTypeToReasoningEffort(pilCtx.taskType) === "high"
                        ? 32_768
                        : taskTypeToReasoningEffort(pilCtx.taskType) === "medium"
                          ? 8_192
                          : 2_048,
                  },
                },
              }
            : baseProviderOpts;
          // Use catalog's thinkingType field instead of regex matching.
          // providerOpts is loosely typed (Record<string, unknown>) after the
          // g1 capability refactor — narrow with a local typed view.
          const thinkingModelInfo = getModelInfo(runtime.modelId);
          const providerOptsAnyView = providerOpts as {
            anthropic?: { thinking?: { type?: string } };
          };
          if (
            providerOptsAnyView.anthropic?.thinking?.type === "enabled" &&
            thinkingModelInfo?.thinkingType === "adaptive"
          ) {
            providerOptsAnyView.anthropic.thinking = { type: "adaptive" as unknown as "enabled" };
          }

          // OpenAI api-key path: `store: true` is seeded by OpenAIStrategy
          // via factory.defaultProviderOptions (Phase 12.2-G4 migration).
          // OAuth backend (ChatGPT Codex) overrides with `store: false` via
          // the auth registry. Both flow through resolveModelRuntime →
          // runtime.providerOptions → buildTurnProviderOptions and arrive
          // here merged into providerOpts.openai.
          // Top-level dropParam — shared with sub-agent path via shouldDropParam.
          // See src/providers/runtime.ts for the central rule.
          const dropParam = (p: "maxOutputTokens" | "temperature" | "topP"): boolean => shouldDropParam(runtime, p);

          // Tier-aware behavioural suffix. Cheap models (DeepSeek V4 Flash etc.)
          // ignore well-worded tool descriptions but DO adopt instructions when
          // surfaced in the system prompt. Smart models don't need this — gated
          // by `modelInfo.tier === "fast"`. See cheap-model-playbook.ts for
          // motivation + escape hatch (MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK=1).
          // Fast-tier steering, front-loaded for primacy: task convergence
          // workbook (anti-ramble — cuts tool-call count, the dominant
          // cheap-model cost) layered UNDER the tool-use playbook so the
          // CRITICAL tool rules stay at the very front. Both fixed per turn, so
          // they stay inside the cached prefix.
          const systemWithWorkbook = shouldInjectCheapModelWorkbook(runtime.modelInfo)
            ? injectCheapModelWorkbook(system, pilCtx.taskType)
            : system;
          const systemWithPlaybook = shouldInjectCheapModelPlaybook(runtime.modelInfo)
            ? injectCheapModelPlaybook(systemWithWorkbook)
            : systemWithWorkbook;
          // A2: front-load a one-line shell/env directive for fast-tier models.
          // The authoritative ENVIRONMENT block already states OS/shell/cwd in
          // the prompt body, but budget models underweight non-front-loaded
          // rules — so echo the correct-syntax line at the very front. Derived
          // from resolveShell({}) (same source as buildEnvironmentBlock) so it
          // is always accurate to the actual shell the bash tool will spawn.
          // Gated to fast tier, so the claude branch below still sees `system`.
          const systemWithShell = shouldInjectCheapModelPlaybook(runtime.modelInfo)
            ? injectCheapModelShellDirective(
                systemWithPlaybook,
                cheapModelShellLine(resolveShell({}).kind, process.platform),
              )
            : systemWithPlaybook;

          // Append the LIVE MCP tool roster so the agent calls connected MCP
          // tools by their exact mcp_<server>__<tool> name instead of shelling
          // out (session f6f7881a5fae). Built from the FINAL toolset for this
          // iteration (post smart-filter + fs-dedup), so it never names a tool
          // the model can't actually call. Dynamic per turn → must live OUTSIDE
          // the cached staticPrefix; for claude it lands in the second
          // (non-cached) system message via the slice below.
          const mcpCapabilityBlock = buildMcpCapabilityBlock(Object.keys(tools));
          const systemWithCaps = mcpCapabilityBlock ? `${systemWithShell}${mcpCapabilityBlock}` : systemWithShell;

          const systemForModel = runtime.modelId.startsWith("claude")
            ? [
                {
                  role: "system" as const,
                  content: systemParts.staticPrefix,
                  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
                },
                {
                  role: "system" as const,
                  content: systemWithCaps.slice(systemParts.staticPrefix.length),
                },
              ]
            : systemWithCaps;

          // Capture prompt-size breakdown so recordUsage can attach it to the
          // cost-log entry. Without this, "system prompt is huge" is unfalsifiable.
          // chars/4 ≈ tokens for English; reported as chars to keep math obvious.
          const messagesChars = deps.messages.reduce((s, m) => {
            const c = m.content;
            if (typeof c === "string") return s + c.length;
            if (Array.isArray(c)) {
              for (const part of c) {
                if (typeof (part as { text?: unknown }).text === "string") {
                  s += (part as { text: string }).text.length;
                }
              }
            }
            return s;
          }, 0);
          let toolsChars = 0;
          let toolsCount = 0;
          for (const [name, t] of Object.entries(tools)) {
            toolsCount += 1;
            toolsChars += name.length;
            const desc = (t as { description?: string }).description;
            if (typeof desc === "string") toolsChars += desc.length;
            try {
              // Schemas often dominate tool size on non-Anthropic providers
              // (Zod-derived JSON schemas can be 2-5K chars per tool).
              const params =
                (t as { parameters?: unknown; inputSchema?: unknown }).parameters ??
                (t as { inputSchema?: unknown }).inputSchema;
              if (params) toolsChars += JSON.stringify(params).length;
            } catch {
              /* best-effort */
            }
          }
          deps.setLastPromptBreakdown({
            systemChars: system.length,
            staticPrefixChars: systemParts.staticPrefix.length,
            dynamicSuffixChars: systemParts.dynamicSuffix.length,
            playwrightGuidanceChars: playwrightGuidance.length,
            messagesChars,
            messagesCount: deps.messages.length,
            toolsChars,
            toolsCount,
          });

          // Task 2.6a — assign a fresh correlation ID for this top-level streamText call.
          const _topCallId = crypto.randomUUID();
          deps.setCurrentCallId(_topCallId);
          // Capture finishReason so we can surface "round cap hit" as a visible
          // toast — without this, the agent silently stops mid-flight when
          // stepCountIs(maxToolRounds) fires and the user sees the TUI freeze
          // (session 7dcf8fd7d6a4 hit exactly 100 rounds → looked like a crash).
          let _lastFinishReason: string | null = null;
          // Phase B4: compact older tool_result parts before each top-level
          // step once cumulative message chars exceed the configured threshold.
          // The compactor preserves system + first user verbatim and keeps the
          // last N tool turns intact; older results are rewritten into short
          // stubs. Symmetric to the B3 sub-agent path; reuses the same module
          // with `label: "top-level"` so the stub text reflects which loop
          // elided the content.
          const topLevelCompactThreshold = getTopLevelCompactThresholdChars();
          const topLevelCompactKeepLast = getTopLevelCompactKeepLast();
          // Phase O1 — capture providerOptions SHAPE (types only) for forensics.
          deps.setLastProviderOptionsShape(
            Object.keys(providerOpts).length > 0 ? extractProviderOptionsShape(providerOpts) : null,
          );
          if (wireDebug.enabled) {
            wireDebug.logRequest({
              providerId: runtime.modelInfo?.provider ?? "unknown",
              modelId: runtime.modelId,
              messages: deps.messages as readonly unknown[],
              systemChars: (systemForModel as unknown as { length?: number })?.length ?? 0,
              toolNames: tools ? Object.keys(tools as Record<string, unknown>) : undefined,
              providerOptions: providerOpts,
            });
          }
          // sanitizeHistory is identity for every provider (kept as a hook
          // for future provider-specific quirks). Reasoning round-trips
          // natively via @ai-sdk/openai-compatible — see
          // src/providers/__tests__/reasoning-roundtrip.test.ts.
          const _topMessagesForCall = turnCaps.sanitizeHistory(deps.messages) as typeof deps.messages;
          // Closure-mutable cap for the tool-loop askcard rescue.
          // Phase 1 (SAMR) skips the dynamic cap (it's a single-step path).
          // Algorithm extracted to ./tool-loop-cap.ts so it can be unit-tested.
          const _baseDynamicStopWhen = createToolLoopCapPredicate({
            initialCap: deps.maxToolRounds,
            ask: deps.askToolLoopContinue,
            // Phase 5 BUG-H — thread the resolved natural ceiling down so the
            // pattern askcard can pick a context-aware default action (continue
            // early in the run, stop once we're past 50% of the natural budget).
            naturalCeiling: _naturalCeiling,
          });
          // Phase 4 Plan 04 (4B) — compose per-session ceiling alongside the
          // existing cap + pattern guard. Logical OR: any condition true → halt.
          // Counter is per-SESSION and increments once per stopWhen invocation
          // (i.e. once per finished tool step), persisting across user turns
          // so a wandering 3-turn burst still trips at the matrix limit.
          const _ceilingSessionId = deps.session?.id ?? "no-session";
          // Phase 5 Fix 3 — capture the actual step number when the ceiling
          // trips so the halt toast can report the real value, not the
          // ceiling/ceiling literal that always showed e.g. "5/5" regardless
          // of how many steps the turn actually ran.
          const _ceilingHitAtStep = 0;
          // Phase 5 Fix 5 — matrix ceiling is now a SOFT BOUNDARY, never a
          // hard halt. Phase 4's hard halt was a blunt anti-wandering
          // measure that also blocked legitimate multi-step work: every
          // long task (improve coverage, optimize startup, refactor) ran
          // out of budget mid-flight and required the user to manually
          // type "tiếp tục". Wrong philosophy — "done" must be the agent's
          // call, not the counter's.
          //
          // What replaced the hard halt:
          //  - Scope-reminders (4A path, prepareStep above) inject
          //    "[approaching ceiling]" reminder at floor(ceiling*0.7) and
          //    repeat at K cadence. Past the ceiling, every step gets a
          //    re-anchor so the model is repeatedly nudged toward closure.
          //  - The dynamicStopWhen no longer checks the matrix ceiling at
          //    all. The only halt source is `_baseDynamicStopWhen` which
          //    enforces `deps.maxToolRounds` as the ULTIMATE runaway safety
          //    net (default raised; see CLI default).
          //  - 4R bash repeat detector still catches the dominant wandering
          //    pattern (identical command twice in a row).
          //  - F6 synthesis still ensures any natural stream-end without
          //    text gets a final summary.
          //
          // _ceilingHit and _ceilingHitAtStep are kept for telemetry: a
          // crossing event is logged for forensics, but no action is taken.
          const dynamicStopWhen = (async (state: { steps: ReadonlyArray<unknown> }) => {
            // Terminal response tool: a `respond_*` call IS the model's final
            // structured answer (its `execute` is identity — the payload lives
            // in the tool-call args). `shouldHaltOnResponseTool` decides if the
            // emission is terminal vs a premature "blind" announce:
            //  - response tool AFTER real tool work (read/grep/bash) → terminal,
            //    halt now (kills d95113d3be09 seq=27: 7 reads → 87× respond loop
            //    at call #1, no extra round-trip for the common case).
            //  - a single blind response (no prior investigation) → do NOT halt;
            //    give the model the step it announced it would use to read code
            //    (session e4a9d97a90: lone blind respond_general was force-stopped
            //    by the old halt-on-first rule and the agent never investigated).
            //  - a 2nd blind response with still no real work → narration loop,
            //    halt. In-step spam (80× in one generation) is bounded separately
            //    by RESPONSE_TOOL_SPAM_CAP — stopWhen only runs BETWEEN steps.
            // Read from `state.steps` (the SDK's own per-step record) rather than
            // the for-await consumer's `responseToolCalled` flag — stopWhen runs
            // between steps and may evaluate before our consumer processed the
            // tool-result part, so the flag would race.
            const _steps = state.steps as ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: string }> }>;
            if (shouldHaltOnResponseTool(_steps)) return true;
            const base = await _baseDynamicStopWhen(state);
            if (base) return true;
            const next = incSessionStep(_ceilingSessionId);
            // Telemetry-only: record the first time the counter crosses
            // the matrix ceiling, so post-hoc queries can correlate the
            // ceiling crossing with task completion outcomes. No halt.
            if (next === _stepCeiling) {
              try {
                if (deps.session?.id) {
                  logInteraction(deps.session.id, "f6_synthesis", {
                    data: {
                      outcome: "ceiling_crossed_softly",
                      stepAtCrossing: next,
                      naturalCeiling: _naturalCeiling,
                      taskType: _ceilingTaskType,
                      size: _ceilingSize,
                      hardCapMaxToolRounds: deps.maxToolRounds,
                    },
                  });
                }
              } catch {
                /* telemetry only */
              }
            }
            return false;
          }) as unknown as StopCondition<typeof tools>;
          // BUG-A fix — when this turn carries an empty tool set (the
          // chitchat optimization at line ~1107 drops all schemas), AI SDK
          // sends `tools:[], tool_choice:undefined` to the provider. DeepSeek
          // V4 Flash sees prior `tool_call`/`tool_result` parts still in the
          // messages history (the previous turn used 20 tools) and the
          // model stays in agent-mode — but with no schema to call, it
          // falls back to its NATIVE DSML markup syntax and emits that as
          // plain text. AI SDK does not parse the native format, so the
          // markup leaks straight to the TUI as garbage and the turn
          // produces no useful output. Setting `toolChoice:"none"` is the
          // canonical way to tell the model "you cannot call tools this
          // turn" so it emits text-only. Verified by stream_start telemetry
          // on sessions 002df4014cb4 (leak) + fc19b4daee20 (leak): both had
          // toolCount=0 + toolChoice=undefined on chitchat continuation.
          const _toolsAreEmpty = Object.keys(tools as Record<string, unknown>).length === 0;
          const _finalToolChoice: "auto" | "none" | undefined = _toolsAreEmpty
            ? "none"
            : _hasResponseTools && turnCaps.supportsClientTools(runtime.modelInfo)
              ? "auto"
              : undefined;
          // BUG-C telemetry — record tool availability + toolChoice at the
          // call site so future regressions show up in telemetry not in TUI.
          try {
            const _toolNamesAtCall = Object.keys(tools as Record<string, unknown>);
            logInteraction(deps.session?.id ?? "no-session", "stream_start", {
              model: turnModelId,
              data: {
                toolCount: _toolNamesAtCall.length,
                hasBash: _toolNamesAtCall.includes("bash"),
                toolNames: _toolNamesAtCall.slice(0, 25),
                toolChoice: _finalToolChoice ?? "undefined",
                hasResponseTools: _hasResponseTools,
                supportsClientTools: turnCaps.supportsClientTools(runtime.modelInfo),
                priorTurnHadTools: (_topMessagesForCall as Array<{ role?: string }>).some((m) => m?.role === "tool"),
              },
            });
          } catch {
            /* telemetry only */
          }
          // Silent-hang guard: abort the stream (and surface a toast in the
          // catch below) if the provider sends no chunk for too long. Re-armed
          // on every chunk via stall.pet(), so it never kills an actively
          // streaming call. Disposed when the stream ends or errors.
          stallTriggered = false;
          const stall = createStallWatchdog(getProviderStallTimeoutMs(), () => {
            stallTriggered = true;
          });
          const result = streamText({
            model: runtime.model,
            system: systemForModel,
            messages: _topMessagesForCall,
            tools,
            toolChoice: _finalToolChoice,
            stopWhen: stepRouterPhase === "phase1" ? stepCountIs(1) : dynamicStopWhen,
            maxRetries: 0,
            abortSignal: combineAbortSignals(signal, stall.signal),
            // Repair malformed tool-call JSON args before they bubble up as
            // InvalidToolInputError → tool-error → repetition-detector abort.
            // Conservative: only fixes the two observed Qwen-style defects.
            // See src/orchestrator/tool-args-repair.ts for the transforms.
            experimental_repairToolCall: repairToolCallHook,
            prepareStep: ({ stepNumber: sn, messages: stepMessages }) => {
              if (sn < 1) return {};
              const stripped = turnCaps.sanitizeHistory(stepMessages) as typeof stepMessages;

              // Agent-controlled veto (PRESERVE) or lighter selective keep (KEEP_TOOL_IDS) for this turn's B4 compaction.
              // PRESERVE_FULL_CONTEXT skips the compactor entirely (full history).
              // KEEP_TOOL_IDS: id1,id2 (from prior stub " (id=...) ") protects only those specific tool results
              // without the cost of a full veto. Parsed from reasoning or assistant note.
              let keepToolIds: string[] = [];
              const hasPreserve = stripped.some((m: any) => {
                const c = m?.content;
                const texts: string[] = [];
                if (typeof c === "string") texts.push(c);
                if (Array.isArray(c)) {
                  for (const p of c) if (typeof p?.text === "string") texts.push(p.text);
                }
                const joined = texts.join(" ");
                if (joined.includes("PRESERVE_FULL_CONTEXT")) return true;
                // Idea 3: parse lighter token
                const mKeep = joined.match(/KEEP_TOOL_IDS\s*[:=]\s*([a-z0-9_, -]+)/i);
                if (mKeep) {
                  keepToolIds = mKeep[1]
                    .split(/[,\s]+/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                }
                return false;
              });
              if (hasPreserve) {
                return { messages: stripped };
              }

              // F2 — envelope = system prompt + JSON-Schema of every tool
              // re-sent on every step. Without this the threshold check
              // ignored 20-50K of fixed prompt overhead and the compactor
              // sat dormant just below its limit while billed input climbed.
              const envelopeChars = computeEnvelopeChars(systemForModel, tools);
              // G1 + G2 — feed the model's context window so the compactor
              // can pick a token-aware threshold and shrink keepLastTurns
              // when the window is approaching its ceiling.
              const contextWindowTokens = runtime.modelInfo?.contextWindow ?? 0;
              // Idea 4: fire-and-forget persist of elided tool outputs to EE (source=tool-artifact)
              // so later layer3/ee.query "tool-artifact id=xxx" or "full tool result id=..." can re-hydrate.
              // Use process-level fallbacks (prepareStep closure does not directly expose outer cwd/session in this scope).
              const _cwd = process.cwd();
              const _sess: string | undefined = undefined; // best-effort; EE artifact still indexable by content + meta.toolCallId
              const persistArtifact = (toolCallId: string, toolName: string, fullContent: string, reason: string) => {
                // Local-first: record the FULL output in-process so ee_query can
                // rehydrate it even if EE is down (the EE extract below caps at 8k
                // and needs the network; the cache keeps up to 200k, no network).
                recordArtifact(toolCallId, toolName, fullContent);
                // Lived-experience telemetry: count this elision so a later
                // "cảm nhận trong CLI" question answers from data, and so the
                // post-compaction note can list what it just stubbed.
                recordElision(toolCallId, toolName, fullContent.length, sn);
                try {
                  getDefaultEEClient()
                    .extract(
                      {
                        transcript: fullContent.slice(0, 8000),
                        projectPath: _cwd,
                        meta: {
                          source: "tool-artifact",
                          toolCallId,
                          toolName,
                          reason,
                          sessionId: _sess,
                          elidedAtStep: sn,
                        },
                      },
                      AbortSignal.timeout(700),
                    )
                    .catch(() => {});
                } catch {
                  /* fail-open, no silent swallow of the decision */
                }
              };
              const compacted = compactSubAgentMessages(stripped, {
                thresholdChars: topLevelCompactThreshold,
                // Rec #1 (cheap part): on meta/self-eval turns keep a couple more
                // trailing tool turns verbatim — those carry the reasoning the
                // agent is being asked to reflect on, and over-eliding them is
                // exactly what starves a self-evaluation. One boolean, no new
                // detection logic (isMetaAnalysisPrompt already gates layer3/5).
                keepLastTurns: topLevelCompactKeepLast + (isMetaAnalysisPrompt(userMessage) ? 2 : 0),
                label: "top-level",
                envelopeChars,
                contextWindowTokens,
                keepToolIds: keepToolIds.length ? keepToolIds : undefined,
                persistArtifact,
              });
              if (compacted !== stripped) recordCompaction(sn);
              // Pre-compaction visibility: give the agent one step of notice
              // before B4 actually rewrites history into stubs. This is the
              // advance warning that was missing — agent can now decide to
              // summarize, finish, or request preservation. Fires when we did
              // NOT compact this step (compacted === stripped, restored by the
              // compactSubAgentMessages no-op ref contract) AND the prompt is
              // approaching the threshold. Must compare CHARS (messages +
              // envelope), not stripped.length (a message count that never
              // exceeds a char-scaled threshold) — session 2b7a10219499.
              const _preWarnChars = cumulativeMessageChars(stripped) + envelopeChars;
              if (compacted === stripped && shouldPreWarnCompaction(_preWarnChars, topLevelCompactThreshold)) {
                const _cp = buildCheckpointReminder(sn, true);
                const _pre = `[pre-compaction warning at step ${sn} — next step(s) will likely rewrite older tool results to stubs (threshold ${topLevelCompactThreshold}, keepLast=${topLevelCompactKeepLast}). ${_cp} Summarize or finish if possible.]`;
                return { messages: attachReminderToMessages(stripped, _pre) };
              }
              // Phase 4A — scope reminder injection (REQ-005).
              // Cadence K = 3/5/8 for small/medium/large. Soft-warn fires
              // ONCE per session at floor(ceiling*0.7). Reminder lives in
              // the tool_result/system channel so B3/B4 compaction cannot
              // strip it (system-prompt path is unsafe at high step counts).
              // Ceiling reuses the 4B (task_type × size) matrix result
              // resolved above (`_stepCeiling`, `_ceilingTaskType`,
              // `_ceilingSize`, `_ceilingSessionId`) so the reminder and the
              // halt boundary agree on the same number.
              const _scopeSize: ComplexitySize = _ceilingSize;
              const _scopeK = cadenceForSize(_scopeSize);
              const _scopeCeiling = Math.max(1, _stepCeiling ?? deps.maxToolRounds ?? 30);
              const _scopeStep = sn;
              const _shouldRemind = shouldInjectReminder(_scopeStep, _scopeK);
              const _shouldWarn = shouldInjectSoftWarn(_scopeStep, _scopeCeiling, _ceilingSessionId);
              // Phase 5 Fix 5 (revised) — past the natural matrix ceiling the
              // orchestrator emits a STRONG re-anchor reminder, but only when
              //   (a) crossing the ceiling for the first time (one-shot), OR
              //   (b) hitting a normal cadence step (multiple of K).
              // Original Phase 5 Fix 5 fired on EVERY step past ceiling, which
              // on long-running sessions (e.g. step 77 / ceiling 6 in session
              // 1f29e238a816) produced 70+ redundant reminders that bloated
              // the tool_result channel and forced the model into a "YES still
              // on scope" loop on every tool call.
              const _pastNaturalCeiling = _scopeStep > _naturalCeiling;
              const _justCrossedCeiling = shouldInjectCeilingCrossing(_scopeStep, _naturalCeiling, _ceilingSessionId);
              const _pastCeilingAtCadence = _pastNaturalCeiling && _shouldRemind;
              // Fix #8 — self-repetition one-shot. Fires when the assistant
              // has opened the last 3 streamText steps with the same 4-word
              // phrase (e.g. "YES still on scope" — session 1f29e238a816
              // emitted 15 such bursts past ceiling). Reminder is attached
              // alongside (and before) any scope reminder so the model sees
              // the behavioural correction first.
              const _shouldRepeatReminder = shouldInjectRepetitionReminder(_ceilingSessionId);
              if (_shouldRemind || _shouldWarn || _justCrossedCeiling || _shouldRepeatReminder) {
                const _baseReminder = buildScopeReminder({
                  step: _scopeStep,
                  ceiling: _scopeCeiling,
                  taskType: _ceilingTaskType,
                  size: _scopeSize,
                  originalPrompt: userMessage,
                });
                // Strong "past natural budget" prefix only applies when we
                // ACTUALLY want the model to consider wrapping up — i.e. on
                // the crossing event or at a cadence step past ceiling, not
                // on every silent step in between.
                const _useStrong = _justCrossedCeiling || _pastCeilingAtCadence;
                const _scopePart =
                  _shouldRemind || _shouldWarn || _justCrossedCeiling
                    ? _useStrong
                      ? `[past natural budget — step ${_scopeStep}/${_naturalCeiling}] If task is COMPLETE, emit final answer NOW. If wandering, simplify the next step. ${_baseReminder}`
                      : _shouldWarn
                        ? `[approaching ceiling] ${_baseReminder}`
                        : _baseReminder
                    : null;
                const _reminder = _shouldRepeatReminder
                  ? _scopePart
                    ? `${buildRepetitionReminder(_ceilingSessionId)}\n${_scopePart}`
                    : buildRepetitionReminder(_ceilingSessionId)
                  : _scopePart!;
                const withReminder = attachReminderToMessages(compacted, _reminder);
                return { messages: withReminder };
              }
              if (compacted === stripped && stripped === stepMessages) return {};
              // Self-awareness note: tell the model compaction happened so it
              // knows earlier context was elided and can adjust its behavior.
              // Enhanced per EE anti-mù plan (docs/ee-anti-mu-compaction-plan.md Phase 2): include proactive
              // "task finished?", "compacted yet?", "EE checkpoint" so agent can self-assess and avoid mù
              // even when the top-level summary is not in its immediate focus (sub-agents, long loops).
              const _compactNote =
                compacted !== stripped
                  ? (() => {
                      // Rec #2: turn the generic "high-value elided? use ee_query"
                      // prose into a concrete, actionable manifest of what was just
                      // stubbed (id/tool/size) — sourced from the elisions recorded
                      // by persistArtifact above — so the rehydrate round-trip is
                      // informed, not blind.
                      const _m = formatElisionManifest();
                      return `[context compacted at step ${sn} — older or low-value tool results rewritten to stubs to fit budget. High-value evidence (file reads, bash, your previous responses) is kept verbatim. ${buildCheckpointReminder(sn, true)}${_m ? ` ${_m}` : ""}]`;
                    })()
                  : null;
              if (_compactNote) {
                return { messages: attachReminderToMessages(compacted, _compactNote) };
              }
              return { messages: compacted };
            },
            ...(dropParam("temperature") ? {} : { temperature: 0.7 }),
            ...(dropParam("maxOutputTokens") ? {} : { maxOutputTokens: taskTypeToMaxTokens(pilCtx.taskType) }),
            ...(Object.keys(providerOpts).length > 0 ? { providerOptions: providerOpts } : {}),
            experimental_onStepStart: (event: unknown) => {
              stepNumber = getStepNumber(event, stepNumber + 1);
              notifyObserver(observer?.onStepStart, {
                stepNumber,
                timestamp: Date.now(),
              });
            },
            onStepFinish: (event: unknown) => {
              const currentStep = getStepNumber(event, Math.max(stepNumber, 0));
              stepNumber = Math.max(stepNumber, currentStep);
              const stepUsage = getUsage(event);
              notifyObserver(observer?.onStepFinish, {
                stepNumber: currentStep,
                timestamp: Date.now(),
                finishReason: getFinishReason(event),
                usage: stepUsage,
              });
              // Realtime status bar update per step
              if (stepUsage.inputTokens || stepUsage.outputTokens) {
                // O1 — thread THIS turn's providerOptions shape per step so every
                // step event records it (not just step 1) and an interleaved task
                // can't overwrite it. Mirrors the gate used for the call itself.
                deps.recordUsage(
                  stepUsage,
                  "message",
                  runtime.modelId,
                  Object.keys(providerOpts).length > 0 ? extractProviderOptionsShape(providerOpts) : null,
                );
              }
              // Fix #8 — feed the assistant text emitted in this step into
              // the self-repetition detector. The slice covers everything
              // appended to `assistantText` since the previous step boundary;
              // a step with no text (pure tool call) records as empty, which
              // recordAssistantBurst treats as a no-op so the current run is
              // preserved across tool interludes.
              const _stepText = assistantText.slice(_assistantTextAtLastStep);
              _assistantTextAtLastStep = assistantText.length;
              recordAssistantBurst(_ceilingSessionId, _stepText);
            },
            onFinish: ({ finishReason }) => {
              _lastFinishReason = finishReason ?? null;
              // Task 2.6b — emit llm-done (agent-mode only).
              try {
                const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
                  | { emitEvent: (e: unknown) => void }
                  | undefined;
                _ar?.emitEvent({
                  t: "event",
                  kind: "llm-done",
                  correlationId: _topCallId,
                  totalChars: assistantText.length,
                  finishReason: finishReason ?? "stop",
                });
              } catch (err) {
                console.error("[Agent:onFinish] failed to emit llm-done", err);
              }
              deps.setCurrentCallId("");
              // Rec #1 persisted forensics: onFinish fires once per top-level turn,
              // so flush this session's cumulative experience counts here. Readers
              // take the latest row per session, so the last turn's row is the
              // session total. No-ops on missing id / all-zero. Fail-open.
              try {
                persistSessionExperience(deps.session?.id ?? null, getSessionExperienceCounts());
              } catch (err) {
                console.error("[Agent:onFinish] persistSessionExperience failed", err);
              }
            },
          });

          let _topTokenIndex = 0;
          const _wireProviderIdTop = runtime.modelInfo?.provider ?? "unknown";
          for await (const part of result.fullStream) {
            stall.pet(); // chunk arrived — reset the stall watchdog
            // Count only real content parts. The watchdog abort itself surfaces
            // as an "abort" part — counting it would defeat the TTFB-stall gate
            // (a frozen-before-first-byte stall yields ONLY the abort part).
            if (part.type !== "abort") chunksThisAttempt++;
            if (signal.aborted) {
              yield { type: "content", content: "\n\n[Cancelled]" };
              break;
            }

            if (wireDebug.enabled) {
              wireDebug.logChunk(_wireProviderIdTop, String(part.type ?? "unknown"), {
                hasText:
                  typeof (part as { text?: string }).text === "string"
                    ? (part as { text: string }).text.length
                    : undefined,
                hasReasoning:
                  typeof (part as unknown as { reasoning?: string }).reasoning === "string"
                    ? (part as unknown as { reasoning: string }).reasoning.length
                    : undefined,
              });
              if (part.type === "error") {
                wireDebug.logError(_wireProviderIdTop, (part as { error?: unknown }).error);
              }
            }

            switch (part.type) {
              case "text-delta":
                assistantText += part.text;
                // Task 2.6b — emit llm-token (agent-mode only; high-volume, default-off per Phase 4).
                try {
                  const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
                    | { emitEvent: (e: unknown) => void }
                    | undefined;
                  _ar?.emitEvent({
                    t: "event",
                    kind: "llm-token",
                    correlationId: _topCallId,
                    delta: part.text,
                    tokenIndex: _topTokenIndex++,
                  });
                } catch {
                  /* best-effort */
                }
                yield { type: "content", content: part.text };
                break;

              case "reasoning-delta":
                reasoningPreview = `${reasoningPreview}${part.text}`.slice(-256);
                if (containsEncryptedReasoning(reasoningPreview)) {
                  if (!encryptedReasoningHidden) {
                    encryptedReasoningHidden = true;
                    yield { type: "reasoning", content: "[Encrypted reasoning hidden]" };
                  }
                  break;
                }
                // P0 native observation: accumulate reasoning for intent context.
                deps.appendTurnAssistantReasoning(part.text);
                yield { type: "reasoning", content: part.text };
                break;

              case "tool-call": {
                const tc = toToolCall(part);
                activeToolCalls.push(tc);
                // SAMR: track that Phase 1 produced tool calls → transition to Phase 2
                if (stepRouterPhase === "phase1") phase1HadToolCalls = true;

                // Response tool = the terminal final answer (identity execute;
                // the payload lives in the call args). Buffer it (longest-wins)
                // straight from the args and gate UI/DB/exec spam: cheap models
                // sometimes emit the response tool MANY times in ONE generation
                // (session 8d8f498268ed: 80× identical respond_general hedge in
                // one step). stopWhen only halts BETWEEN steps, so it can't stop
                // an in-step spam — this does. Surface only the first indicator;
                // if the model spams past the cap, finalize NOW with the
                // buffered answer instead of streaming out the degenerate step.
                if (isResponseTool(tc.function.name)) {
                  _responseToolEmitCount += 1;
                  try {
                    const _payload = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
                    const _len = JSON.stringify(_payload).length;
                    if (_len > _pendingStructuredResponseLen) {
                      _pendingStructuredResponseLen = _len;
                      _pendingStructuredResponse = {
                        taskType: getResponseTaskType(tc.function.name) ?? tc.function.name,
                        data: _payload,
                      };
                    }
                  } catch {
                    /* keep the prior buffered payload */
                  }
                  responseToolCalled = true;
                  // Only the first response-tool call gets a UI indicator.
                  if (_responseToolEmitCount === 1) {
                    yield { type: "tool_calls", toolCalls: [tc] };
                  }
                  if (_responseToolEmitCount >= RESPONSE_TOOL_SPAM_CAP && _pendingStructuredResponse) {
                    if (deps.session) {
                      try {
                        logInteraction(deps.session.id, "f6_synthesis", {
                          eventSubtype: "response_tool_spam_abort",
                          data: { emitted: _responseToolEmitCount, keptChars: _pendingStructuredResponseLen },
                        });
                      } catch {
                        /* telemetry best-effort */
                      }
                    }
                    // Persist a clean turn (user + the single buffered answer)
                    // so history stays usable; the spam is dropped. Mirrors the
                    // tool-repetition abort: yield + done + return (do NOT await
                    // result.response — the stream is still spewing calls).
                    const _data = _pendingStructuredResponse.data as { response?: unknown };
                    const _answerText =
                      typeof _data.response === "string"
                        ? _data.response
                        : JSON.stringify(_pendingStructuredResponse.data);
                    try {
                      deps.appendCompletedTurn(userModelMessage, [
                        { role: "assistant", content: _answerText } as ModelMessage,
                      ]);
                    } catch (persistErr) {
                      console.error(
                        `[message-processor] response-tool-spam persist failed: ${(persistErr as Error)?.message}`,
                      );
                    }
                    yield {
                      type: "structured_response" as StreamChunk["type"],
                      structuredResponse: _pendingStructuredResponse,
                    };
                    yield { type: "done" };
                    return;
                  }
                  break; // response tools skip write-ahead/hooks/normal tool_calls yield
                }

                // EE PreToolUse hook: fire intercept before tool execution.
                {
                  const turnAssistantReasoning = deps.getTurnAssistantReasoning();
                  const intentContext: import("../hooks/types.js").PreToolIntentContext = {
                    ...(turnAssistantReasoning
                      ? { assistantReasoningExcerpt: turnAssistantReasoning.slice(-200) }
                      : {}),
                    ...(deps.priorWarningIdsInSession.size > 0
                      ? {
                          priorWarningIdsInSession: Array.from(deps.priorWarningIdsInSession).slice(-20),
                        }
                      : {}),
                    ...(pilCtx.gsdPhase ? { gsdPhase: pilCtx.gsdPhase } : {}),
                    ...(userMessage.slice(0, 200) ? { userGoalExcerpt: userMessage.slice(0, 200) } : {}),
                  };
                  const preInput: PreToolUseHookInput = {
                    hook_event_name: "PreToolUse",
                    tool_name: tc.function.name,
                    tool_input: JSON.parse(tc.function.arguments || "{}"),
                    session_id: deps.session?.id,
                    cwd: deps.bash.getCwd(),
                    ...(Object.keys(intentContext).length > 0 ? { intent_context: intentContext } : {}),
                  };
                  const preResult = await deps.fireHook(preInput, signal).catch(() => ({
                    blocked: false,
                    blockingErrors: [] as Array<{ command: string; stderr: string }>,
                    preventContinuation: false,
                    additionalContexts: [] as string[],
                    results: [] as import("../hooks/types.js").HookResult[],
                    eeMatches: [] as import("../hooks/types.js").EEMatchEntry[],
                  }));
                  for (const ctx of preResult.additionalContexts ?? []) {
                    yield { type: "content", content: `${ctx}\n` };
                  }
                  // Store structured EE matches for session guidance injection on next turn.
                  for (const m of preResult.eeMatches ?? []) {
                    deps.sessionEEGuidance.set(m.id, {
                      toolName: m.toolName,
                      message: m.message,
                      why: m.why,
                      confidence: m.confidence,
                    });
                    // Cap at 30 entries — oldest first, trim when exceeded.
                    if (deps.sessionEEGuidance.size > 30) {
                      const firstKey = deps.sessionEEGuidance.keys().next().value;
                      if (firstKey !== undefined) deps.sessionEEGuidance.delete(firstKey);
                    }
                  }
                  // P0 native observation: track which principle IDs surfaced
                  // this turn so the next intercept can dedup server-side.
                  try {
                    const { getLastSurfacedState } = await import("../ee/intercept.js");
                    const { surfacedIds } = getLastSurfacedState();
                    for (const id of surfacedIds) deps.priorWarningIdsInSession.add(id);
                    // Cap memory: keep only most-recent 100 IDs.
                    if (deps.priorWarningIdsInSession.size > 100) {
                      const arr = Array.from(deps.priorWarningIdsInSession);
                      deps.setPriorWarningIdsInSession(new Set(arr.slice(-100)));
                    }
                  } catch {
                    /* fail-open */
                  }
                }

                // Pitfall 9: log the pending call so reconcile() can recover any
                // staged .tmp files if the process is killed before tool-result.
                if (deps.pendingCalls) {
                  const turnId = deps.session?.id ?? "anon";
                  const callId = stableCallId(turnId, tc.function.name, tc.function.arguments);
                  // Phase 0: predictStagedPaths = [] for all tools (refined in Phase 1).
                  void deps.pendingCalls.begin({ call_id: callId, tool_name: tc.function.name }).catch(() => {});
                  // Attach callId to the ToolCall so tool-result can end it.
                  (tc as ToolCall & { _pendingCallId?: string })._pendingCallId = callId;
                }

                // Phase A4: write-ahead persistence — insert a pending row into
                // tool_calls BEFORE executing the tool. If the stream throws
                // mid-call (e.g. provider 5xx, abort, network drop), this row
                // remains as `pending` so `usage forensics` can show the args
                // the model passed. The post-stream appendMessages() path
                // (INSERT OR IGNORE + UPDATE) will finalize this row to
                // `completed` once the turn settles normally.
                if (deps.sessionStore && deps.session) {
                  // Predicted assistant seq: user message + assistant message
                  // are appended atomically by appendCompletedTurn().
                  // getNextMessageSequence() returns the seq the user message
                  // will get; the assistant message is the next one after.
                  let predictedSeq = -1;
                  try {
                    predictedSeq = getNextMessageSequence(deps.session.id) + 1;
                  } catch {
                    /* fail-open — leave predictedSeq=-1; post-stream UPDATE corrects it */
                  }
                  persistToolCallWriteAhead(
                    deps.session.id,
                    predictedSeq,
                    tc.id,
                    tc.function.name,
                    tc.function.arguments || "{}",
                  );
                }
                notifyObserver(observer?.onToolStart, {
                  toolCall: tc,
                  timestamp: Date.now(),
                });
                // Interaction log: tool call start
                try {
                  if (deps.session) {
                    logInteraction(deps.session.id, "tool_call", {
                      eventSubtype: tc.function.name,
                      data: {
                        toolCallId: tc.id,
                        argsPreview: tc.function.arguments.slice(0, 200),
                      },
                    });
                  }
                } catch {
                  /* fail-open */
                }
                yield { type: "tool_calls", toolCalls: [tc] };
                break;
              }

              case "tool-result": {
                const tc: ToolCall = {
                  id: part.toolCallId,
                  type: "function",
                  function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
                };
                let tr = toToolResult(part.output);

                // Vision Bridge: proxy image-bearing tool results for text-only models (any tool, not just MCP)
                try {
                  const bridgeResult = await bridgeMcpToolResult(
                    part.toolName,
                    tr.output,
                    turnModelId,
                    signal,
                    part.toolCallId,
                  );
                  if (bridgeResult.proxied) {
                    tr = {
                      ...tr,
                      output:
                        typeof bridgeResult.output === "string"
                          ? bridgeResult.output
                          : JSON.stringify(bridgeResult.output),
                    };
                    yield { type: "content", content: `[Vision Bridge: image → text for ${turnModelId}]\n` };
                  }
                } catch (err) {
                  console.error("[Agent:visionBridge] failed to process image for tool result", err);
                }

                // Capture into the stall-rescue digest before any further
                // processing — if the stream stalls after this, these outputs
                // are all we have to synthesize a final answer from.
                pushStallToolResult(
                  turnToolResults,
                  part.toolName,
                  typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output),
                );

                // Pitfall 9: settle the pending call log entry.
                if (deps.pendingCalls) {
                  const pending = activeToolCalls.find((t) => t.id === part.toolCallId);
                  const callId = (pending as ToolCall & { _pendingCallId?: string })?._pendingCallId;
                  if (callId) {
                    const endStatus = signal.aborted ? "aborted" : "settled";
                    void deps.pendingCalls.end(callId, endStatus).catch(() => {});
                  }
                }
                // EE PostToolUse hook: fire-and-forget after tool execution.
                {
                  const postInput: PostToolUseHookInput = {
                    hook_event_name: "PostToolUse",
                    tool_name: part.toolName,
                    tool_input: (part.input as Record<string, unknown>) ?? {},
                    tool_output:
                      typeof tr.output === "string"
                        ? { text: tr.output }
                        : ((tr.output as unknown as Record<string, unknown>) ?? {}),
                    session_id: deps.session?.id,
                    cwd: deps.bash.getCwd(),
                  };
                  await deps.fireHook(postInput, signal).catch((err) => {
                    console.error("[Agent:PostToolUse hook] failed", err);
                  });
                }

                // Response tool: yield as structured_response instead of tool_result.
                // AI SDK v5 wraps tool outputs as `{type:"json", value:{...}}`; unwrap
                // to expose the schema-shaped payload to the UI renderer.
                if (isResponseTool(part.toolName)) {
                  responseToolCalled = true;
                  // Payload was already buffered (longest-wins) from the
                  // tool-CALL args above; re-buffer from the executed result as
                  // a fallback (unwraps the AI-SDK `{type:"json",value}` shape).
                  // Counting + the spam cap live in the tool-call branch.
                  const taskType = getResponseTaskType(part.toolName);
                  const rawOutput = part.output as unknown;
                  const unwrapped =
                    rawOutput && typeof rawOutput === "object" && (rawOutput as { type?: string }).type === "json"
                      ? ((rawOutput as { value?: unknown }).value ?? {})
                      : (rawOutput ?? {});
                  const _len = JSON.stringify(unwrapped ?? {}).length;
                  if (_len > _pendingStructuredResponseLen) {
                    _pendingStructuredResponseLen = _len;
                    _pendingStructuredResponse = {
                      taskType: taskType ?? part.toolName,
                      data: unwrapped as Record<string, unknown>,
                    };
                  }
                  notifyObserver(observer?.onToolFinish, { toolCall: tc, toolResult: tr, timestamp: Date.now() });
                  break;
                }

                notifyObserver(observer?.onToolFinish, {
                  toolCall: tc,
                  toolResult: tr,
                  timestamp: Date.now(),
                });
                // Interaction log: tool result.
                // Phase 5 BUG-J — for edit/write/update tools, persist the
                // structured diff (file_path, +N/-M counts, isNew flag, and
                // a bounded patch preview) so forensics queries can audit
                // what actually changed in each turn without re-reading
                // git history. Earlier the log only had the summary string
                // ("Edited X (+1 -1)") — the patch text was lost.
                try {
                  if (deps.session) {
                    const outputPreview =
                      typeof tr.output === "string" ? tr.output.slice(0, 200) : JSON.stringify(tr.output).slice(0, 200);
                    const _trWithDiff = tr as {
                      diff?: { filePath: string; additions: number; removals: number; patch: string; isNew: boolean };
                    };
                    const diffMeta =
                      _trWithDiff.diff &&
                      (tc.function.name === "edit_file" ||
                        tc.function.name === "write_file" ||
                        tc.function.name === "update_file")
                        ? {
                            filePath: _trWithDiff.diff.filePath,
                            additions: _trWithDiff.diff.additions,
                            removals: _trWithDiff.diff.removals,
                            isNew: _trWithDiff.diff.isNew,
                            // Cap at 4000 chars — enough to inspect small/medium
                            // edits without ballooning the SQLite row. Large
                            // refactors get truncated with a tail marker so
                            // readers know the patch is partial.
                            patchPreview:
                              _trWithDiff.diff.patch.length > 4000
                                ? _trWithDiff.diff.patch.slice(0, 4000) + "\n…[truncated]"
                                : _trWithDiff.diff.patch,
                          }
                        : undefined;
                    logInteraction(deps.session.id, "tool_result", {
                      eventSubtype: tc.function.name,
                      data: { success: tr.success, outputPreview, ...(diffMeta ? { diff: diffMeta } : {}) },
                    });
                  }
                } catch {
                  /* fail-open */
                }
                yield { type: "tool_result", toolCall: tc, toolResult: tr };
                // Reset tool-repetition counter on any non-error result. A
                // successful call between two failures of the same shape is
                // progress and should not accumulate toward the abort gate.
                if (tr.success) {
                  recordToolRepetitionSuccess(deps.session?.id ?? null);
                }
                // todo_write side-effect: surface the task list to the UI via a
                // dedicated chunk so the sticky checklist panel can re-render
                // without parsing tool args itself. Skipped when the snapshot
                // doesn't parse (malformed args) so the UI is never poisoned.
                if (tc.function.name === "todo_write" && tr.success) {
                  const snap = snapshotFromTodoWriteArgs(tc.function.arguments);
                  if (snap) yield { type: "task_list_update", taskListSnapshot: snap };
                }
                break;
              }

              case "tool-error": {
                // AI SDK emits this when tool execution throws/aborts before
                // producing a tool-result. Without this branch, the tool_call
                // log row has no matching tool_result and the EE judge never
                // sees the failure → silent ~1.6% pairing leak in prod DB.
                const errPart = part as {
                  type: "tool-error";
                  toolCallId: string;
                  toolName: string;
                  input?: unknown;
                  error: unknown;
                };
                const tc: ToolCall = {
                  id: errPart.toolCallId,
                  type: "function",
                  function: { name: errPart.toolName, arguments: JSON.stringify(errPart.input ?? {}) },
                };
                const errMsg =
                  errPart.error instanceof Error
                    ? errPart.error.message
                    : typeof errPart.error === "string"
                      ? errPart.error
                      : JSON.stringify(errPart.error);
                const tr = { success: false, output: `[tool-error] ${errMsg}` };

                // Settle pending-call ledger so we don't leak stale .tmp files.
                if (deps.pendingCalls) {
                  const pending = activeToolCalls.find((t) => t.id === errPart.toolCallId);
                  const callId = (pending as ToolCall & { _pendingCallId?: string })?._pendingCallId;
                  if (callId) void deps.pendingCalls.end(callId, "settled").catch(() => {});
                }

                // Phase A4: mark the write-ahead tool_calls row as `errored`.
                // The post-stream appendMessages() path does NOT see tool-error
                // parts in the assistant message content (the SDK doesn't emit
                // them there), so without this explicit update the row would
                // remain `pending` after a clean tool failure.
                if (deps.session) {
                  markToolCallErrored(deps.session.id, errPart.toolCallId, errMsg);
                }

                // Fire PostToolUseFailure so EE judge can record IGNORED outcome.
                {
                  const failInput: PostToolUseFailureHookInput = {
                    hook_event_name: "PostToolUseFailure",
                    tool_name: errPart.toolName,
                    tool_input: (errPart.input as Record<string, unknown>) ?? {},
                    error: errMsg,
                    session_id: deps.session?.id,
                    cwd: deps.bash.getCwd(),
                  };
                  await deps.fireHook(failInput, signal).catch(() => {});
                }

                try {
                  if (deps.session) {
                    logInteraction(deps.session.id, "tool_result", {
                      eventSubtype: errPart.toolName,
                      data: { success: false, error: errMsg.slice(0, 500), reason: "tool-error" },
                    });
                  }
                } catch (logErr) {
                  console.error(
                    `[message-processor] interaction-log tool_result failed: ${(logErr as Error)?.message}`,
                  );
                }

                notifyObserver(observer?.onToolFinish, { toolCall: tc, toolResult: tr, timestamp: Date.now() });
                yield { type: "tool_result", toolCall: tc, toolResult: tr };

                // Tool-call perseveration guard. After N consecutive identical
                // (toolName, args, error) triples, abort the streaming loop
                // before TPM rate limits do (session 080fe2fcbf24).
                const repetition = recordToolRepetitionError(
                  deps.session?.id ?? null,
                  errPart.toolName,
                  errPart.input,
                  errMsg,
                );
                if (repetition.shouldAbort) {
                  const abortMsg = buildToolRepetitionAbortMessage(errPart.toolName, repetition.runLength, errMsg);
                  try {
                    if (deps.session) {
                      logInteraction(deps.session.id, "error", {
                        eventSubtype: "tool_repetition_abort",
                        data: {
                          toolName: errPart.toolName,
                          runLength: repetition.runLength,
                          errorPreview: errMsg.slice(0, 200),
                        },
                      });
                    }
                  } catch (logErr) {
                    console.error(
                      `[message-processor] interaction-log tool_repetition_abort failed: ${(logErr as Error)?.message}`,
                    );
                  }
                  notifyObserver(observer?.onError, { message: abortMsg, timestamp: Date.now() });
                  yield { type: "error", content: abortMsg, isAuthError: false };
                  yield { type: "done" };
                  return;
                }
                break;
              }

              case "tool-approval-request": {
                const approvalPart = part as unknown as {
                  approvalId: string;
                  toolCall: { toolCallId: string; toolName: string; input: unknown };
                };
                const toolCallId = approvalPart.toolCall?.toolCallId ?? "";
                const pendingTc = activeToolCalls.find((tc) => tc.id === toolCallId);
                const tcForChunk = pendingTc ?? {
                  id: toolCallId,
                  type: "function" as const,
                  function: {
                    name: approvalPart.toolCall?.toolName ?? "paid_request",
                    arguments: JSON.stringify(approvalPart.toolCall?.input ?? {}),
                  },
                };

                // Payment pre-check disabled — Stripe billing pending.
                const paymentPrecheck: import("../types/index").PaymentPrecheck | undefined = undefined;

                // Plan 03-01: check permission mode before yielding approval request to UI.
                // auto-edit auto-approves file ops; yolo auto-approves everything.
                const toolName = approvalPart.toolCall?.toolName ?? "";
                const input = approvalPart.toolCall?.input ?? {};
                const context =
                  toolName === "bash"
                    ? { command: String((input as any).command ?? "") }
                    : toolName === "write_file" ||
                        toolName === "edit_file" ||
                        toolName === "read_file" ||
                        toolName === "grep"
                      ? { path: String((input as any).path ?? (input as any).file_path ?? "") }
                      : undefined;
                if (!toolNeedsApproval(toolName, deps.permissionMode, context)) {
                  // Auto-approve: respond directly without surfacing to UI.
                  deps.respondToToolApproval(approvalPart.approvalId, true);
                  appendAudit({
                    kind: deps.permissionMode === "yolo" ? "yolo-override" : "permission-override",
                    tool: toolName,
                    mode: deps.permissionMode,
                    context,
                    ts: Date.now(),
                  });
                  break;
                }

                yield {
                  type: "tool_approval_request",
                  approvalId: approvalPart.approvalId,
                  toolCall: tcForChunk,
                  paymentPrecheck,
                };
                break;
              }

              case "error": {
                const authError = isAuthenticationError(part.error);
                const friendly = humanizeApiError(part.error, {
                  modelId: runtime.modelId,
                  providerId: runtime.modelInfo?.provider,
                });
                const forensics = summarizeApiErrorForLog(part.error);
                notifyObserver(observer?.onError, {
                  message: friendly,
                  timestamp: Date.now(),
                });
                // Interaction log: error + forensics envelope so opaque
                // provider 4xx ("parameter is invalid" / unknown 400s) leave
                // an actionable wire-level trace without needing a repro.
                try {
                  if (deps.session) {
                    logInteraction(deps.session.id, "error", {
                      eventSubtype: authError ? "auth" : "api",
                      data: {
                        message: friendly.slice(0, 200),
                        ...(forensics ? { forensics } : {}),
                      },
                    });
                  }
                } catch (logErr) {
                  console.error(`[message-processor] interaction-log error failed: ${(logErr as Error)?.message}`);
                }
                yield {
                  type: "error",
                  content: friendly,
                  isAuthError: authError,
                };
                break;
              }

              case "abort":
                // A stall-watchdog abort arrives here as an "abort" stream part
                // (the SDK surfaces it as a part, not a throw). Distinguish it
                // from a genuine user cancel — which is caught at the top of the
                // loop via `signal.aborted` — and surface it as a visible error
                // instead of a benign "[Cancelled]" so a hung provider no longer
                // looks like a silent freeze.
                if (stallTriggered) {
                  // Time-to-first-byte stall (no real chunk this attempt): the
                  // socket wedged before any output — re-issue the SAME request
                  // rather than giving up. Bounded by maxStallRetries; never
                  // fires once tools ran or text flowed (planStallReprompt gate).
                  const _stallBackoff = planStallReprompt();
                  if (_stallBackoff != null) {
                    stall.dispose();
                    await new Promise<void>((r) => setTimeout(r, _stallBackoff));
                    if (!signal.aborted) {
                      stallTriggered = false;
                      continue streamAttempt;
                    }
                  }
                  stall.dispose();
                  // A response tool already produced the terminal structured
                  // answer (buffered from its call args) before the provider
                  // stalled on a LATER step. Surface it and finish cleanly —
                  // never bury the model's actual answer behind a "not
                  // responding" error. Root cause of the "respond_* indicator
                  // shows but no answer block renders" report: this stall-abort
                  // path returned before the post-loop structured_response yield,
                  // dropping the captured answer. A response tool is terminal,
                  // so there is nothing to rescue — just emit what we have.
                  if (_pendingStructuredResponse) {
                    if (!streamOk) {
                      try {
                        const _d = _pendingStructuredResponse.data as { response?: unknown };
                        const _ans =
                          typeof _d.response === "string"
                            ? _d.response
                            : JSON.stringify(_pendingStructuredResponse.data);
                        deps.appendCompletedTurn(userModelMessage, [
                          { role: "assistant", content: _ans } as ModelMessage,
                        ]);
                        streamOk = true;
                      } catch (persistErr) {
                        console.error(
                          `[message-processor] stall+response-tool persist failed: ${(persistErr as Error)?.message}`,
                        );
                      }
                    }
                    yield {
                      type: "structured_response" as StreamChunk["type"],
                      structuredResponse: _pendingStructuredResponse,
                    };
                    yield { type: "done" };
                    return;
                  }
                  // Best-effort answer rescue: a turn that already ran tools but
                  // stalled before the final synthesis would otherwise return
                  // ONLY "Model not responding", discarding all that work (live
                  // obs 2026-06-04, deepseek session 734e65cffdf6: 67 tool calls
                  // → user got nothing). Make ONE guarded forced-finalize call
                  // over the gathered tool outputs. forcedFinalize has its own
                  // stall timeout, so a still-dead provider just falls through.
                  let _rescued: string | null = null;
                  if (turnToolResults.length > 0) {
                    try {
                      const _userText =
                        typeof userModelMessage?.content === "string"
                          ? userModelMessage.content
                          : JSON.stringify(userModelMessage?.content ?? "");
                      _rescued = await attemptStallRescue({
                        baseMessages: _topMessagesForCall as unknown[],
                        userText: _userText.slice(0, 4000),
                        toolResults: turnToolResults,
                        system: typeof systemForModel === "string" ? systemForModel : undefined,
                        finalize: (a) =>
                          forcedFinalize({ model: runtime.model, messages: a.messages, system: a.system }),
                      });
                    } catch {
                      _rescued = null;
                    }
                    try {
                      if (deps.session) {
                        logInteraction(deps.session.id, "stall_rescue", {
                          data: {
                            outcome: _rescued ? "rescued" : "no_text",
                            toolResultCount: turnToolResults.length,
                            chars: _rescued?.length ?? 0,
                          },
                        });
                      }
                    } catch {
                      /* telemetry is best-effort */
                    }
                  }
                  if (_rescued) {
                    assistantText += (assistantText ? "\n\n" : "") + _rescued;
                    yield { type: "content", content: _rescued };
                  }
                  // Persist a record of the interrupted turn BEFORE returning so
                  // the next turn is not amnesiac. Previously this returned with
                  // nothing persisted → the next turn saw "no previous turn" and
                  // redid the work, orphaning any edits the stalled turn applied
                  // (live obs 2026-06-04, deepseek-v4-flash). When rescued, the
                  // note now carries the synthesized answer too (assistantText).
                  // Best-effort: never let persistence failure block surfacing.
                  if (!streamOk) {
                    try {
                      const _stallNote = buildInterruptedTurnNote(
                        assistantText,
                        activeToolCalls.map((c) => c.function.name),
                      );
                      deps.appendCompletedTurn(userModelMessage, [
                        { role: "assistant", content: _stallNote } as ModelMessage,
                      ]);
                      streamOk = true;
                    } catch {
                      /* best-effort — surface the stall regardless */
                    }
                  }
                  if (_rescued) {
                    // Recovered a best-effort answer from partial data — surface
                    // a soft notice instead of the scary "not responding" error.
                    yield {
                      type: "content",
                      content:
                        "\n\n[Note: the model connection stalled; the answer above is a best-effort synthesis " +
                        "from the tool results gathered before the stall and may be incomplete.]",
                    };
                    yield { type: "done" };
                    return;
                  }
                  notifyObserver(observer?.onError, { message: STALL_ERROR_MESSAGE, timestamp: Date.now() });
                  yield { type: "error", content: STALL_ERROR_MESSAGE, isAuthError: false };
                  yield { type: "done" };
                  return;
                }
                yield { type: "content", content: "\n\n[Cancelled]" };
                break;
            }
          }
          stall.dispose(); // stream drained normally — stop the stall watchdog

          // ─── SAMR Phase 1 → Phase 2 transition ─────────────────────────
          // Phase 1 (premium model) produced tool calls but the SDK stopped
          // before executing them (stopWhen: stepCountIs(1)). Append the
          // assistant message to deps.messages and restart the loop with
          // the fast execution model. Phase 2's streamText call will see
          // the pending tool calls and execute them automatically.
          //
          // EXCEPT when Phase 1 emitted a response tool: a `respond_*` call IS
          // the terminal structured answer (identity execute), not work to hand
          // to Phase 2. Transitioning here would (a) skip the structured_response
          // yield below — the answer never reaches the TUI — and (b) append a
          // dangling assistant tool-call WITHOUT its tool-result (only assistant
          // msgs are pushed), corrupting Phase 2's history. Fall through instead
          // so the buffered answer is yielded + persisted on this turn.
          if (stepRouterPhase === "phase1" && phase1HadToolCalls && !responseToolCalled) {
            try {
              const phase1Response = await result.response;
              // Append only new messages (assistant message with tool calls)
              const newMsgs = phase1Response.messages.slice(deps.messages.length);
              for (const msg of newMsgs) {
                if (msg.role === "assistant") {
                  deps.messages.push(msg);
                }
              }
            } catch {
              // If response extraction fails, fall through to normal completion
            }
            stepRouterPhase = "phase2";
            continue; // Re-enter while loop with Phase 2 (fast) model
          }

          // Surface the single most-complete response-tool answer buffered
          // during the stream (see _pendingStructuredResponse). Yielding here —
          // once, after the stream drained and after the Phase 1 transition —
          // collapses any duplicate response-tool emissions in the turn into a
          // single structured_response block for the UI.
          if (_pendingStructuredResponse) {
            yield {
              type: "structured_response" as StreamChunk["type"],
              structuredResponse: _pendingStructuredResponse,
            };
            if (_responseToolEmitCount > 1 && deps.session) {
              try {
                logInteraction(deps.session.id, "f6_synthesis", {
                  eventSubtype: "response_tool_deduped",
                  data: { emitted: _responseToolEmitCount, keptChars: _pendingStructuredResponseLen },
                });
              } catch {
                /* telemetry best-effort */
              }
            }
          }

          if (signal.aborted) {
            deps.discardAbortedTurn(userModelMessage);
            yield { type: "done" };
            return;
          }

          try {
            const response = await result.response;
            if (!signal.aborted) {
              // Scrub oversized base64 image payloads from tool-result parts
              // BEFORE persisting. The vision bridge above only modified the
              // transient `tr` shown to the user — `response.messages` from
              // the AI SDK still carries the full base64 (e.g. Playwright
              // screenshot, ~1.5MB). Persisting that lets it accumulate and
              // overflow the model's context on subsequent turns.
              const scrubbed = scrubImagePayloadsInMessages(response.messages);

              // Phase 5 F6 — synthesis step when stream ended without a final
              // text response. Cheap models (DeepSeek V4 Flash) frequently
              // emit only tool-calls in their last step and stop, leaving the
              // user staring at "Here's the summary:..." truncation that
              // required a manual "tiếp tục" turn-2 to coax out. Detect that
              // shape and inject ONE forcedFinalize call (same path as 4B
              // ceiling-hit) so the answer arrives on turn 1.
              //
              // Skip when 4B ceiling already triggered its own forcedFinalize
              // below — running both would double-bill and duplicate text.
              let _f6SynthesisText: string | null = null;
              const _f6LastMsg = scrubbed[scrubbed.length - 1] as { role?: string; content?: unknown } | undefined;
              const _f6LastRole = _f6LastMsg?.role ?? "none";
              let _f6Outcome:
                | "skip_ceiling"
                | "skip_has_text"
                | "skip_response_tool"
                | "fired_empty"
                | "fired_text"
                | "error" = "skip_ceiling";
              let _f6Elapsed = 0;
              let _f6ChunkChars = 0;
              let _f6Error: string | null = null;
              // A response tool already produced the final structured answer —
              // F6 synthesis would duplicate it as prose. Skip entirely. With
              // the stopWhen terminal-halt above, the turn now ends right after
              // the response tool (last scrubbed message is the response
              // tool-result, role "tool"), which would otherwise trip the
              // _needsSynthesis "ended on a tool" branch and double-respond.
              if (responseToolCalled) {
                _f6Outcome = "skip_response_tool";
              } else if (!_ceilingHit) {
                const _needsSynthesis = (() => {
                  if (!_f6LastMsg) return false;
                  if (_f6LastMsg.role === "tool") return true;
                  if (_f6LastMsg.role !== "assistant") return false;
                  const _c = _f6LastMsg.content;
                  if (typeof _c === "string") return !_c.trim();
                  if (!Array.isArray(_c)) return false;
                  return !(_c as Array<Record<string, unknown>>).some(
                    (p) => p && p.type === "text" && typeof p.text === "string" && (p.text as string).trim().length > 0,
                  );
                })();
                if (!_needsSynthesis) {
                  _f6Outcome = "skip_has_text";
                } else {
                  const _f6Start = Date.now();
                  try {
                    const _ff = await forcedFinalize({
                      model: runtime.model,
                      messages: _topMessagesForCall as unknown[],
                      system: typeof systemForModel === "string" ? systemForModel : undefined,
                    });
                    _f6Elapsed = Date.now() - _f6Start;
                    _f6ChunkChars = (_ff.text ?? "").length;
                    if (_ff.text.trim()) {
                      _f6SynthesisText = _ff.text;
                      assistantText += _ff.text;
                      yield { type: "content", content: _ff.text };
                      _f6Outcome = "fired_text";
                    } else {
                      _f6Outcome = "fired_empty";
                    }
                  } catch (_err) {
                    _f6Elapsed = Date.now() - _f6Start;
                    _f6Outcome = "error";
                    _f6Error = (_err as Error)?.message?.slice(0, 200) ?? String(_err).slice(0, 200);
                  }
                }
              }
              try {
                if (deps.session) {
                  logInteraction(deps.session.id, "f6_synthesis", {
                    data: {
                      outcome: _f6Outcome,
                      lastMsgRole: _f6LastRole,
                      elapsedMs: _f6Elapsed,
                      chars: _f6ChunkChars,
                      error: _f6Error,
                      ceilingHit: _ceilingHit,
                      scrubbedLen: scrubbed.length,
                    },
                  });
                }
              } catch {
                /* telemetry is best-effort */
              }

              // Summary-phase grounding check (Agent Operating Contract, runtime
              // half). Soft-flag counts / file:line refs in the final synthesis
              // that don't appear in this turn's tool outputs — possible
              // hallucination. Never blocks: emits a grounding-flag event + a
              // warn toast + an inline advisory footnote. Only runs when the
              // turn actually produced tool output (a corpus to ground against)
              // and is not chitchat. See grounding-check.ts.
              if (
                process.env.MUONROI_DISABLE_GROUNDING_CHECK !== "1" &&
                !isChitchat &&
                assistantText.trim().length > 0
              ) {
                try {
                  const _gParts: string[] = [];
                  let _gHadTool = false;
                  for (const _gm of scrubbed as Array<{ role?: string; content?: unknown }>) {
                    if (!_gm || _gm.role === "assistant") continue;
                    if (_gm.role === "tool") _gHadTool = true;
                    const _gc = _gm.content;
                    _gParts.push(typeof _gc === "string" ? _gc : JSON.stringify(_gc));
                  }
                  if (_gHadTool) {
                    const _claims = findUnverifiedClaims(assistantText, _gParts.join("\n"));
                    if (_claims.length > 0) {
                      const _footnote = buildGroundingFootnote(_claims);
                      assistantText += _footnote;
                      yield { type: "content", content: _footnote };
                      const _gar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
                        | { emitEvent: (e: unknown) => void }
                        | undefined;
                      const _claimTexts = _claims.map((c) => c.text);
                      _gar?.emitEvent({
                        t: "event",
                        kind: "grounding-flag",
                        claims: _claimTexts,
                        count: _claims.length,
                        ts: Date.now(),
                      });
                      _gar?.emitEvent({
                        t: "event",
                        kind: "toast",
                        level: "warn",
                        text: `grounding: ${_claims.length} unverified claim(s) — ${_claimTexts.join(", ")}`,
                      });
                      if (deps.session) {
                        try {
                          logInteraction(deps.session.id, "grounding_flag", {
                            data: { claims: _claimTexts, count: _claims.length },
                          });
                        } catch {
                          /* telemetry is best-effort */
                        }
                      }
                    }
                  }
                } catch {
                  /* grounding check is best-effort — never break finalize */
                }
              }

              const _finalMessages = sanitizeModelMessages(scrubbed) as ModelMessage[];
              if (_f6SynthesisText !== null) {
                _finalMessages.push({
                  role: "assistant",
                  content: _f6SynthesisText,
                } as ModelMessage);
              }
              deps.appendCompletedTurn(userModelMessage, _finalMessages);
              streamOk = true;
            }
          } catch (responseError: unknown) {
            if (
              !attemptedOverflowRecovery &&
              !assistantText.trim() &&
              modelInfo &&
              isContextLimitError(responseError)
            ) {
              attemptedOverflowRecovery = true;
              continue;
            }
          }

          if (signal.aborted) {
            deps.discardAbortedTurn(userModelMessage);
            yield { type: "done" };
            return;
          }

          // Phase 5 Fix 5 — the Phase 4 4B forced-finalize-on-ceiling-hit
          // block lived here. With the matrix ceiling no longer halting the
          // stream (it's pure telemetry now), _ceilingHit can never be true
          // and this branch is dead. F6 synthesis above already covers the
          // "stream ended with no final text" case for both natural model
          // termination AND maxToolRounds halt. Keeping the comment as a
          // breadcrumb for future archaeology.

          if (!streamOk && assistantText.trim()) {
            deps.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
          }

          // Fallback: model responded in text despite tool_choice=required
          // Attempt JSON extraction from assistant text → yield as structured_response
          if (_hasResponseTools && !responseToolCalled && pilCtx.taskType && assistantText.trim()) {
            try {
              const jsonMatch = assistantText.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
                if (Object.keys(parsed).length > 0) {
                  responseToolCalled = true;
                  yield {
                    type: "structured_response" as StreamChunk["type"],
                    structuredResponse: {
                      taskType: pilCtx.taskType,
                      data: parsed,
                    },
                  };
                }
              }
            } catch {
              // JSON parse failed — leave as text-fallback
            }
          }

          // Track PIL output mode for /optimize metrics
          {
            const { setLastOutputMode } = await import("../pil/store.js");
            if (!_hasResponseTools) setLastOutputMode("conversational");
            else if (responseToolCalled) setLastOutputMode("structured");
            else setLastOutputMode("text-fallback");
          }

          // ROUTE-11: Fire routeFeedback after turn completes (success path).
          // Must come AFTER posttool calls (posttool fires during tool-result processing above).
          // Fire-and-forget — no await. Skipped when taskHash is null (bridge absent).
          {
            const turnDuration = Date.now() - turnStartMs;
            if (taskHash) {
              const tier = taskTypeToTier(pilCtx.taskType);
              void routeFeedback(
                taskHash,
                tier,
                runtime.modelId,
                "success", // Phase 6: all normal completions = 'success'
                0, // retryCount: 0 for first attempt
                turnDuration,
              );
            }
            // HTTP path: also report via router store taskHash (covers warm/cold EE routes)
            const storeHash = routerStore.getState().taskHash;
            if (storeHash) {
              reportRouteOutcome(storeHash, "success", turnDuration);
            }
          }

          // Detect a tool call emitted as plain TEXT (wrong dialect) in the final
          // assistant answer — the action never ran, so the turn would otherwise
          // end silently with broken/half-done work (live: deepseek session
          // 905d564dbde4 emitted `<read_file>` as text after a destructive edit).
          // Detect regardless of how many real tool calls already succeeded: the
          // common failure is the model doing a few real tools, then emitting the
          // NEXT call as text and stopping (live deepseek-native, full-fix CLI: 2
          // real read_file calls, then `<read_file><path>` as text → silent stop).
          // An earlier `activeToolCalls.length === 0` guard suppressed exactly
          // that case. Detector precision (structural invocation shape, not a bare
          // mention) guards against false-firing on a normal final answer.
          const _textToolCall = detectTextEmittedToolCall(assistantText);

          // Interaction log: agent response complete
          try {
            if (deps.session) {
              const sb = statusBarStore.getState();
              const turnDurationMs = Date.now() - turnStartMs;
              // BUG-A telemetry — detect raw DeepSeek native tool-call markup
              // leaking into assistant text. Signature is `<｜｜DSML｜｜` (the
              // fullwidth vertical bars are NOT pipes, they're U+FF5C).
              const _dsmlSig = "｜｜DSML｜｜";
              const _dsmlMatches = assistantText.includes(_dsmlSig);
              const _codeBlockBash = /```\s*bash\b/i.test(assistantText);
              logInteraction(deps.session.id, "agent_response", {
                model: turnModelId,
                inputTokens: sb.in_tokens,
                outputTokens: sb.out_tokens,
                durationMs: turnDurationMs,
                data: {
                  textLength: assistantText.length,
                  toolCallCount: activeToolCalls.length,
                  compacted: deps.getCompactedThisTurn(),
                  dsmlLeak: _dsmlMatches,
                  bashCodeBlock: _codeBlockBash,
                  textToolXmlLeak: _textToolCall.detected,
                  textToolXmlTool: _textToolCall.tool,
                },
              });
            }
          } catch {
            /* fail-open */
          }

          // Surface the round-cap stop so the user knows why the agent halted
          // (session 7dcf8fd7d6a4 hit stepCountIs(100) silently, looked like a
          // crash). AI SDK reports finishReason='tool-calls' when the step cap
          // fires with tool calls still pending — distinct from 'stop' (model
          // chose to end). We only warn when stepNumber ≥ cap so a model that
          // legitimately terminates mid-tool-call (rare) doesn't get a false
          // warning.
          if (_lastFinishReason === "tool-calls" && stepNumber >= deps.maxToolRounds - 1) {
            yield {
              type: "content",
              content:
                `\n\n[Stopped: hit max-tool-rounds=${deps.maxToolRounds}. ` +
                `Re-run with \`--max-tool-rounds ${deps.maxToolRounds * 2}\` to continue, ` +
                "or accept the partial result above.]\n",
            };
          }

          // Tool-call-as-text leak: the model wrote a tool invocation as plain
          // text (wrong dialect) and made NO real tool call, so the action never
          // ran. Auto-recover ONCE: append a corrective message and re-run the
          // turn so the model can invoke the tool properly. The just-finished
          // (text-only) turn is already persisted above — the model sees its own
          // mistake plus the correction. Mirrors the proven phase-switch re-entry
          // (it also pushes to deps.messages then `continue`s); bounded by
          // MAX_TEXT_TOOL_RESTEER so a persistently-degrading model can't loop.
          if (_textToolCall.detected && streamOk && textToolReSteerCount < MAX_TEXT_TOOL_RESTEER) {
            textToolReSteerCount++;
            // Recover the model's INTENT from the leaked markup (DeepSeek-native
            // DSML carries the tool + args) so the corrective restates the exact
            // call — far more effective than a generic "use the tool" nudge.
            const _parsedCalls = parseDsmlToolCalls(assistantText);
            const _intent =
              _parsedCalls.length > 0
                ? ` You appear to have intended: ${_parsedCalls
                    .map(
                      (c) =>
                        `${c.name}(${Object.entries(c.args)
                          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                          .join(", ")})`,
                    )
                    .join("; ")}. Make those exact call(s) via the tool interface now.`
                : "";
            deps.messages.push({
              role: "user",
              content:
                `Your previous reply wrote a \`${_textToolCall.tool}\` tool call as XML/text. That is NOT how tools are invoked here — ` +
                "writing tool calls as text does nothing, so the action did not run. " +
                "Use the actual tool-calling interface (function/tool calls) to perform the action now. " +
                "Do NOT output XML tags like <read_file>, <write_to_file>, <execute_command>, or <tool_call> (or DSML markup) as text." +
                _intent,
            });
            if (deps.session) {
              try {
                logInteraction(deps.session.id, "text_tool_resteer", {
                  model: turnModelId,
                  data: { tool: _textToolCall.tool, attempt: textToolReSteerCount },
                });
              } catch {
                /* telemetry best-effort */
              }
            }
            {
              const _gar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
                | { emitEvent: (e: unknown) => void }
                | undefined;
              _gar?.emitEvent({
                t: "event",
                kind: "toast",
                level: "info",
                text: `model wrote a ${_textToolCall.tool} tool call as text — re-steering to use the tool interface`,
              });
            }
            await closeMcp?.().catch(() => {});
            continue;
          }

          // Re-steer budget exhausted (or no clean finish): surface the leak so
          // the turn is not SILENTLY wasted. The "answer" above is unexecuted XML.
          if (_textToolCall.detected) {
            yield {
              type: "content",
              content:
                `\n\n[⚠ The model wrote a \`${_textToolCall.tool}\` tool call as TEXT instead of invoking the tool, ` +
                "so that action did NOT run and this turn made no real progress. " +
                "Re-run the request (optionally with a more capable model) — the tool interface was not used.]\n",
            };
            const _gar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
              | { emitEvent: (e: unknown) => void }
              | undefined;
            _gar?.emitEvent({
              t: "event",
              kind: "toast",
              level: "warn",
              text: `model emitted a ${_textToolCall.tool} tool call as text — action not executed`,
            });
          }

          const stopInput: StopHookInput = {
            hook_event_name: "Stop",
            session_id: deps.session?.id,
            cwd: deps.bash.getCwd(),
          };
          await deps.fireHook(stopInput, signal).catch(() => {});

          // Debug trace: emit pipeline summary
          if (_debugOn) {
            const sb = statusBarStore.getState();
            const defaultInfo = getModelInfo(deps.modelId);
            const usedInfo = getModelInfo(turnModelId);
            const routerSaved =
              defaultInfo && usedInfo && defaultInfo.outputPrice > usedInfo.outputPrice
                ? (sb.out_tokens * (defaultInfo.outputPrice - usedInfo.outputPrice)) / 1_000_000
                : 0;
            const cacheSaved =
              sb.cache_read_tokens > 0 && defaultInfo
                ? (sb.cache_read_tokens *
                    (defaultInfo.inputPrice - (defaultInfo.cachedInputPrice ?? defaultInfo.inputPrice * 0.1))) /
                  1_000_000
                : 0;
            const trace: TurnTrace = {
              turn_id: _debugTurnId,
              timestamp: turnStartMs,
              raw_prompt: userMessage,
              steps: _debugSteps,
              model_requested: deps.modelId,
              model_used: turnModelId,
              routed: turnModelId !== deps.modelId,
              input_tokens: sb.in_tokens,
              output_tokens: sb.out_tokens,
              cache_read_tokens: sb.cache_read_tokens,
              cost_usd: sb.session_usd,
              estimated_savings: {
                pil_tokens_saved: _pilEnrichmentDeltaSnapshot > 0 ? _pilEnrichmentDeltaSnapshot : 0,
                cache_tokens_saved: sb.cache_read_tokens,
                router_cost_saved_usd: routerSaved,
                total_tokens_saved:
                  (_pilEnrichmentDeltaSnapshot > 0 ? _pilEnrichmentDeltaSnapshot : 0) + sb.cache_read_tokens,
                total_cost_saved_usd: routerSaved + cacheSaved,
              },
            };
            recordTurnTrace(trace);

            const traceLines: string[] = [];
            traceLines.push("\n┌─ Pipeline Trace ─────────────────────────");
            for (const step of _debugSteps) {
              const dur = step.duration_ms < 1 ? "<1ms" : `${step.duration_ms}ms`;
              const saved = step.tokens_saved ? ` (saved ~${step.tokens_saved} tok)` : "";
              traceLines.push(`│ ▸ ${step.name} [${dur}]${saved}`);
              traceLines.push(`│   ${step.output_summary}`);
            }
            const routeLabel = trace.routed ? `${trace.model_requested}→${trace.model_used}` : trace.model_used;
            traceLines.push(
              `│ Model: ${routeLabel} | ↑${sb.in_tokens} ↓${sb.out_tokens} | $${sb.session_usd.toFixed(4)}`,
            );
            if (trace.estimated_savings.total_cost_saved_usd > 0) {
              traceLines.push(
                `│ Savings: ~${trace.estimated_savings.total_tokens_saved} tok, ~$${trace.estimated_savings.total_cost_saved_usd.toFixed(4)}`,
              );
            }
            traceLines.push("└──────────────────────────────────────────\n");
            yield { type: "content", content: traceLines.join("\n") };
          }

          if (modelInfo?.contextWindow) {
            await deps.postTurnCompact(provider, system, modelInfo.contextWindow, signal);
          }
          yield { type: "done" };
          return;
        } catch (err: unknown) {
          if (signal.aborted) {
            deps.discardAbortedTurn(userModelMessage);
            // ROUTE-11: Fire routeFeedback for cancelled turns (abort path).
            // Fire-and-forget — no await. Skipped when taskHash is null.
            {
              const turnDuration = Date.now() - turnStartMs;
              if (taskHash) {
                const tier = taskTypeToTier(pilCtx.taskType);
                void routeFeedback(taskHash, tier, runtime.modelId, "cancelled", 0, turnDuration);
              }
              const storeHash = routerStore.getState().taskHash;
              if (storeHash) {
                reportRouteOutcome(storeHash, "cancelled", turnDuration);
              }
            }
            yield { type: "content", content: "\n\n[Cancelled]" };
            yield { type: "done" };
            return;
          }

          if (!attemptedOverflowRecovery && !assistantText.trim() && modelInfo && isContextLimitError(err)) {
            attemptedOverflowRecovery = true;
            continue;
          }

          // Stall surfaced as a throw (rather than an "abort" stream part):
          // apply the SAME time-to-first-byte re-prompt as the abort-part path.
          // The watchdog already fired (stallTriggered) so its timer is spent —
          // no dispose needed; the next attempt arms a fresh watchdog.
          if (stallTriggered) {
            const _stallBackoff = planStallReprompt();
            if (_stallBackoff != null) {
              await new Promise<void>((r) => setTimeout(r, _stallBackoff));
              if (!signal.aborted) {
                stallTriggered = false;
                continue;
              }
            }
          }

          // Transient network/server error retry — up to MAX_STREAM_RETRIES extra attempts.
          // Only retry when no content has flowed yet (assistantText empty) to avoid
          // partial-output corruption. Honour the abort signal between retries.
          // Skip retry on a stall abort: the provider is unresponsive, so a retry
          // just burns another full stall timeout of silence — surface it instead.
          if (!assistantText.trim() && streamRetryCount < MAX_STREAM_RETRIES && !signal.aborted && !stallTriggered) {
            const { transient } = classifyStreamError(err);
            if (transient) {
              streamRetryCount++;
              // Exponential backoff: 500 → 2000 ms with ±25% jitter
              const baseMs = 500;
              const expMs = Math.min(baseMs * 4 ** (streamRetryCount - 1), 8_000);
              const spread = expMs * 0.25;
              const nextDelayMs = Math.round(expMs + (Math.random() * 2 - 1) * spread);
              const errorName = err instanceof Error ? err.name : "Error";
              const errorMessage = err instanceof Error ? err.message : String(err);
              // Emit harness telemetry event
              try {
                const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
                  | { emitEvent: (e: unknown) => void }
                  | undefined;
                _ar?.emitEvent({
                  t: "event",
                  kind: "stream-retry",
                  attempt: streamRetryCount,
                  maxAttempts: MAX_STREAM_RETRIES + 1,
                  errorName,
                  errorMessage,
                  nextDelayMs,
                });
              } catch {
                /* best-effort */
              }
              try {
                if (deps.session) {
                  logInteraction(deps.session.id, "stream_retry", {
                    data: {
                      attempt: streamRetryCount,
                      maxAttempts: MAX_STREAM_RETRIES + 1,
                      errorName,
                      errorMessage: errorMessage.slice(0, 200),
                      nextDelayMs,
                    },
                  });
                }
              } catch {
                /* fail-open */
              }
              await new Promise<void>((resolve) => setTimeout(resolve, nextDelayMs));
              if (!signal.aborted) {
                continue;
              }
            }
          }

          const authError = isAuthenticationError(err);
          // Stall aborts carry an opaque DOMException; show the clear stall
          // message instead of the raw abort reason.
          const friendly = stallTriggered
            ? STALL_ERROR_MESSAGE
            : humanizeApiError(err, { modelId: runtime.modelId, providerId: runtime.modelInfo?.provider });
          notifyObserver(observer?.onError, {
            message: friendly,
            timestamp: Date.now(),
          });
          yield {
            type: "error",
            content: friendly,
            isAuthError: authError,
          };
          if (assistantText.trim()) {
            deps.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
          } else if (deps.session && userWriteAheadSeq != null) {
            // Phase A5 — Stream threw before producing assistant text. The
            // write-ahead user row is stuck at `status='pending'`. Mark it
            // errored so forensics + recovery can distinguish "in-flight"
            // from "crashed mid-flight".
            markMessageErrored(deps.session.id, userWriteAheadSeq);
          }

          // ROUTE-11: Fire routeFeedback for failed turns (error path).
          // Must come AFTER posttool calls. Fire-and-forget — no await.
          {
            const turnDuration = Date.now() - turnStartMs;
            if (taskHash) {
              const tier = taskTypeToTier(pilCtx.taskType);
              void routeFeedback(taskHash, tier, runtime.modelId, "fail", 0, turnDuration);
            }
            const storeHash = routerStore.getState().taskHash;
            if (storeHash) {
              reportRouteOutcome(storeHash, "fail", turnDuration);
            }
          }

          const stopFailureInput: StopFailureHookInput = {
            hook_event_name: "StopFailure",
            error: friendly,
            session_id: deps.session?.id,
            cwd: deps.bash.getCwd(),
          };
          await deps.fireHook(stopFailureInput, signal).catch(() => {});

          if (modelInfo?.contextWindow) {
            await deps.postTurnCompact(provider, system, modelInfo.contextWindow, signal);
          }
          yield { type: "done" };
          return;
        } finally {
          await closeMcp?.().catch(() => {});
        }
      }
    } finally {
      if (deps.getAbortController()?.signal === signal) {
        deps.setAbortController(null);
      }
    }
  }
}
