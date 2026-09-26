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
//   - reasoning-strip (provider quirk)       — turnCaps.sanitizeHistory

import { generateText, type ModelMessage, type StopCondition, stepCountIs, streamText, type ToolSet } from "ai";
import { breadcrumb } from "../council/crash-breadcrumb.js";
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
import { assessComplexity } from "../gsd/complexity-assessor.js";
import { isComplexityAssessorEnabled, isGsdNativeEnabled, isPilGateEnrichEnabled } from "../gsd/flags.js";
import { getGsdLoopHost } from "../gsd/loop-host.js";
import { readState, syncWorkflowContext } from "../gsd/workflow-engine.js";
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
import type { getModelInfo } from "../models/registry.js";
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
  normalizeStructuredResponseTaskType,
  runPipeline,
  shouldHaltOnResponseTool,
} from "../pil/index.js";
import { isContinuationPhrase } from "../pil/layer1-intent.js";
import { isMetaAnalysisPrompt } from "../pil/layer6-output.js";
import { taskTypeToMaxTokens, taskTypeToReasoningEffort, taskTypeToTier } from "../pil/task-tier-map.js";
import { mentionsEcosystemScope } from "../playbook/directives.js";
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
import {
  canHandleImagesForTextOnlyModel,
  needsVisionProxy,
  planImageHandlingForTextOnlyModel,
  proxyVision,
} from "../providers/vision-proxy.js";
import { wireDebug } from "../providers/wire-debug.js";
import { reportRouteOutcome } from "../router/decide.js";
import { decideStepRouting, eeSamrGuidance, getStepRouterConfig } from "../router/step-router.js";
import { routerStore } from "../router/store.js";
import { statusBarStore } from "../state/status-bar-store.js";
import { isDebugEnabled, type PipelineStep, recordTurnTrace, type TurnTrace } from "../state/turn-trace.js";
import {
  getLastApprovedPlan,
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
import { appendDecisionLog } from "../usage/decision-log.js";
import { logger } from "../utils/logger.js";
import { openUrl } from "../utils/open-url.js";
import { appendAudit, type PermissionMode, toolNeedsApproval } from "../utils/permission-mode.js";
import {
  getAutoCouncilConfidence,
  getAutoCouncilMinRoles,
  getProviderStallRetries,
  getProviderStallTimeoutMs,
  getRoleModels,
  getSteerInjectionEnabled,
  getTopLevelCompactKeepLast,
  getTopLevelCompactThresholdChars,
  getTopLevelToolBudgetChars,
  isAutoCouncilEnabled,
  isModelPinnedByProject,
  isProviderDisabled,
  loadMcpServers,
  loadValidSubAgents,
} from "../utils/settings";
import { resolveShell } from "../utils/shell.js";
import type { AbortContext } from "./abort.js";
import type { LegacyProvider, ProcessMessageObserver } from "./agent-options";
import type { AskUserAskInfo } from "./ask-user.js";
import { beginCompactionTurn } from "./compact-request.js";
import { relaxCompactionSettings } from "./compaction";
import type { CouncilManager } from "./council-manager.js";
import type { CrossTurnDedup } from "./cross-turn-dedup.js";
import { wrapToolSetWithDedup } from "./cross-turn-dedup.js";
import { humanizeApiError, isAuthenticationError, isContextLimitError, summarizeApiErrorForLog } from "./error-utils";
import { buildInterruptedTurnNote } from "./interrupted-turn.js";
import type { PendingCallsLog } from "./pending-calls.js";
import { stableCallId } from "./pending-calls.js";
import { prepareTurnContext } from "./preprocessor.js";
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
import type { SafetyBlockKind, SafetyOverrideAskInfo, SafetyOverrideVerdict } from "./safety-askcard.js";
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
import { shouldRunGate } from "./should-run-gate.js";
import { attemptStallRescue, pushStallToolResult, type StallToolResult } from "./stall-rescue.js";
import {
  createStallWatchdog,
  STALL_ERROR_MESSAGE,
  shouldContinueAfterMidLoopStall,
  shouldRepromptStall,
  stallRepromptBackoffMs,
} from "./stall-watchdog.js";
import { planSteerInjection } from "./steer-inbox.js";
import { wrapToolSetWithCap } from "./sub-agent-cap.js";
import { applyAnthropicPromptCaching, compactSubAgentMessages, cumulativeMessageChars } from "./subagent-compactor.js";
import { detectTextEmittedToolCall, parseDsmlToolCalls } from "./text-tool-call-detector.js";
import { executeToolEngine } from "./tool-engine.js";
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
 * Session-scoped cache for [EE Session Guidance] dedup. Maps sessionId to the
 * sha256 prefix of the last-injected guidance content. Prevents the same block
 * from being re-injected on every turn — once the model has seen a set of
 * guidance entries it stays informed until new entries arrive.
 */
const _injectedGuidanceSha = new Map<string, string>();

/**
 * Stable marker prefix for the SessionStart-hook system message (round 2,
 * G1 HIGH). `--resume` rehydrates `deps.messages` from the session's
 * persisted transcript BEFORE this function ever runs, but
 * `getSessionStartHookFired()` is a per-PROCESS flag — it resets on every
 * new process, including a resumed one. Firing the hook again on resume is
 * correct (the `SessionStartHookInput.source: "resume"` already reflects
 * this), but appending ANOTHER copy of this system message on top of the
 * one already sitting in the rehydrated history is not — the model would
 * see the same briefing twice. Tagged so the injection site can find and
 * REPLACE a prior copy instead of appending a second one.
 *
 * Exported (round 3, MEDIUM) so orchestrator.ts's compaction step can carry
 * this ONE message verbatim across a summarization pass — see its own
 * comment at the compaction call site: compaction's kept-tail window has no
 * reason to know about this tag, so a tagged message that fell outside the
 * kept window used to be summarized away like any other old message,
 * leaving nothing for a later --resume to find and replace.
 */
export const SESSION_START_SYSTEM_TAG = "[SessionStart hook output]";

function isTaggedSessionStartMessage(m: ModelMessage): boolean {
  return m.role === "system" && typeof m.content === "string" && m.content.startsWith(SESSION_START_SYSTEM_TAG);
}

/**
 * Round 3 (MEDIUM, G1-adjacent): whether orchestrator.ts's compaction
 * rebuild needs to explicitly carry the tagged SessionStart system message
 * across a summarization pass, and the exact message to carry if so.
 *
 * Extracted as a pure function — exported for the test — because the real
 * compaction path (`Agent.compactForContext`) is a private method on a
 * large class that makes real LLM calls, not directly unit-testable.
 *
 * Returns `null` when the kept tail already has one (a short/fresh
 * session's compaction can legitimately keep it naturally — re-adding it
 * would duplicate it), otherwise the tagged message found anywhere in the
 * PRE-compaction history (`null` if there never was one).
 */
export function reinjectTaggedSessionStartAcrossCompaction(
  allMessagesBeforeCompaction: readonly ModelMessage[],
  keptMessages: readonly ModelMessage[],
): ModelMessage | null {
  if (keptMessages.some(isTaggedSessionStartMessage)) return null;
  return allMessagesBeforeCompaction.find(isTaggedSessionStartMessage) ?? null;
}

/**
 * Durable phase breadcrumb for the pre-stream path (everything in `run()`
 * before the first provider request — see `turn-progress.ts`'s
 * `pingTurnProgress`, which only fires once `executeToolEngine` is about to
 * call `streamText`). Nothing in this window emits a chunk, so the top-level
 * turn watchdog's 120s idle budget covers it as one opaque block: session
 * 1e9db4d68da0 hit exactly this — a watchdog kill with ZERO interaction_logs
 * / call_accounting rows anywhere in the window, so no evidence said WHICH
 * pre-stream await hung.
 *
 * Writes a `pre-stream.<name>.start` / `pre-stream.<name>.end` pair via the
 * existing crash-breadcrumb trail (`~/.muonroi-cli/council-breadcrumbs.jsonl`,
 * sync `fs.appendFileSync` — survives a watchdog abort because it is written
 * BEFORE `fn()` settles, not after). If a phase hangs, its `.start` has no
 * matching `.end` — the orchestrator's watchdog catch reads exactly that (see
 * `getLastOpenPhase(this.session?.id)` in orchestrator.ts) to attribute the
 * hang to a phase name in the `error` interaction_log row.
 *
 * `sessionId` is what makes that attribution safe under nesting: it is stamped
 * on every line, and the tracker keeps one open-phase set PER SESSION, so a
 * forked sub-session running its own phases concurrently cannot shadow the
 * parent's. Always pass the session that OWNS the phase, never a child's.
 */
export function preStreamPhase<T>(name: string, sessionId: string | undefined, fn: () => Promise<T>): Promise<T> {
  breadcrumb(`pre-stream.${name}.start`, { sessionId });
  return fn().then(
    (v) => {
      breadcrumb(`pre-stream.${name}.end`, { sessionId });
      return v;
    },
    (err) => {
      breadcrumb(`pre-stream.${name}.end`, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    },
  );
}

/**
 * Dependency surface the MessageProcessor needs to reach back into Agent
 * state without holding a circular reference. Properties expose array
 * references (mutating push() must affect the same array the Agent reads on
 * subsequent turns). Method callbacks delegate to Agent private methods.
 */
export interface MessageProcessorDeps extends TurnRunnerDepsBase {
  readonly isSubSession?: boolean;
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
  consultParentSession?: (question: string) => Promise<string>;
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
  appendMidTurnMessages?: (msgs: ModelMessage[]) => void;
  askToolLoopContinue?: ToolLoopCapAsk;
  /** Safety override handler — invoked when a tool call is blocked by the safety filter. */
  askSafetyOverride?: (info: SafetyOverrideAskInfo) => Promise<SafetyOverrideVerdict>;
  /** ask_user handler — invoked when the model calls the `ask_user` tool; resolves the human's answer. */
  askUser?: (info: AskUserAskInfo) => Promise<string>;
  /** Feature B2 — enter_ideal handler; records a pending product-loop request on the orchestrator. */
  enterIdeal?: (idea: string) => void;
  runCouncilV2(
    userMessage: string,
    opts: {
      skipClarification: boolean;
      observer?: ProcessMessageObserver;
      userModelMessage: ModelMessage;
      // Agent-driven post-council: suppress the hardcoded post-debate card so the
      // synthesis returns to the agent, which decides the follow-up. Threaded from
      // the auto-council + runDebate call sites in tool-engine.
      suppressPreDebateCards?: boolean;
      suppressPostDebate?: boolean;
      /** Gate A — thread the main turn's already-classified scopeKind so runCouncil skips a redundant self-classify round-trip. */
      externalTopic?: boolean;
    },
  ): AsyncGenerator<StreamChunk, void, unknown>;
  processMessage(
    userMessage: string,
    observer?: ProcessMessageObserver,
    images?: Array<{ path: string; mediaType: string; base64: string }>,
  ): AsyncGenerator<StreamChunk, void, unknown>;
  processMessageBatchTurn(args: {
    userModelMessage: ModelMessage;
    userEnrichedMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    provider: LegacyProvider;
    subagents: unknown[];
    system: string;
    runtime: ReturnType<typeof resolveModelRuntime>;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown>;
}

/**
 * Single-shot leader-tier LLM runner for the GSD complexity assessor
 * (Task 4 `assessComplexity`). Mirrors the orchestrator's own council LLM
 * construction (`createCouncilLLM` — see `runCouncil` / `runProductLoop` in
 * orchestrator.ts) so the assessor call auto-records usage as
 * `source=council` (no cost-leak) instead of a bespoke unaccounted call.
 * Leader model resolution goes ONLY through `resolvePlanCouncilLeader` —
 * Zero Hardcode Rule, no literal model/provider IDs here.
 */
function buildLeaderAssessorRunner(
  deps: MessageProcessorDeps,
  sessionModel: string,
): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const { createCouncilLLM } = await import("../council/llm.js");
    const { resolvePlanCouncilLeader } = await import("../council/leader.js");
    const leader = await resolvePlanCouncilLeader(sessionModel);
    const stats = { calls: 0, startMs: Date.now(), phases: [] as Array<{ name: string; durationMs: number }> };
    const llm = createCouncilLLM(deps.bash, deps.mode, deps.session?.id, stats);
    // Small budget — this is a single classification, not a synthesis.
    return llm.generate(
      leader.modelId,
      "You are a task complexity assessor.",
      prompt,
      512,
      undefined,
      AbortSignal.timeout(PIL_GATE_DEADLINE_MS),
    );
  };
}

/**
 * Turn-start PIL gate budget: the assessor + heavy-tier critics run BEFORE the
 * model message is assembled, so they must be short — a slow gate call would
 * delay every turn, not just heavy ones. `createCouncilLLM.generate` has no
 * per-call timeout of its own (`llm.ts:331` defaults to 5 minutes), so this
 * deadline is threaded explicitly as the `signal` arg on every gate call.
 */
const PIL_GATE_DEADLINE_MS = 2500;

/**
 * Heavy-tier gate critic runner (Task 4 `runGateCritics`). Reuses the council
 * LLM (billed `source=council`, no cost leak) with the same tight deadline as
 * the assessor — three critics run in parallel via `Promise.all` inside
 * `runGateCritics`, each individually bounded by this signal.
 */
function buildGateCriticRunner(
  deps: MessageProcessorDeps,
  sessionModel: string,
): import("../gsd/pil-gate-critic.js").RunCriticFn {
  return async (prompt: string): Promise<string> => {
    const { createCouncilLLM } = await import("../council/llm.js");
    const { resolvePlanCouncilLeader } = await import("../council/leader.js");
    const leader = await resolvePlanCouncilLeader(sessionModel);
    const stats = { calls: 0, startMs: Date.now(), phases: [] as Array<{ name: string; durationMs: number }> };
    const llm = createCouncilLLM(deps.bash, deps.mode, deps.session?.id, stats);
    return llm.generate(
      leader.modelId,
      "You are a prompt-enrichment critic.",
      prompt,
      512,
      undefined,
      AbortSignal.timeout(PIL_GATE_DEADLINE_MS),
    );
  };
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

/**
 * Rewrites tool-result parts in the AI SDK's final response history if the
 * user manually approved a safety-blocked command. This ensures the model sees
 * its own retry context accurately (as a success) rather than a repeated block
 * message, avoiding infinite retry loops or hallucinated failures.
 */
export function rewriteSafetyApprovedToolResults<T extends { role: string; content?: any }>(messages: T[]): T[] {
  const _globalSafety = globalThis as typeof globalThis & {
    __muonroiSafetyApproved?: Map<string, { kind: "once" | "session"; command: string }>;
  };
  const approvedMap = _globalSafety.__muonroiSafetyApproved;
  if (!approvedMap || approvedMap.size === 0) {
    return messages;
  }
  return messages.map((m) => {
    if (m.role !== "tool" || !Array.isArray(m.content)) return m;
    let changed = false;
    const newContent = m.content.map((part: any) => {
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        const approved = approvedMap.get(part.toolCallId);
        if (approved) {
          changed = true;
          return {
            ...part,
            isError: false,
            result: `Approved (${approved.kind}): blocked command was allowed by user`,
          };
        }
      }
      return part;
    });
    return changed ? ({ ...m, content: newContent } as T) : m;
  });
}

export class MessageProcessor {
  constructor(private deps: MessageProcessorDeps) {}

  async *run(
    userMessage: string,
    observer?: ProcessMessageObserver,
    images?: Array<{ path: string; mediaType: string; base64: string }>,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const deps = this.deps;
    // A1 fix: mirror the existing `ownsController` pattern (orchestrator.ts
    // runCouncilV2 ~2353, runProductLoopV1 ~2627). If `deps.getAbortController()`
    // already holds a controller, this `run()` call is NESTED inside an
    // already-owned run — e.g. sprint-runner Step 4b's completeness re-check
    // calling `ctx.processMessageFn`, which resolves to `Agent.processMessage`
    // → `new MessageProcessor(...).run()`. Pre-fix, this branch unconditionally
    // created a brand-new AbortController and overwrote the owner's, then the
    // `finally` below nulled it out on completion regardless of ownership —
    // orphaning the owner's captured signal so a later `abort()` (Esc) became
    // a permanent no-op for the rest of the run. Reusing the owner's controller
    // verbatim means aborting the owner also aborts this nested call (same
    // signal object, no extra wiring needed), and this call's own completion
    // never touches the owner's controller.
    const existingController = deps.getAbortController();
    const ownsController = !existingController;
    if (ownsController) {
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

    // Compaction-consult turn boundary: the preservation focus the agent stated
    // via the `compact` tool is scoped to ONE user turn. Without this a focus
    // from an early turn would keep steering compactions many turns later.
    try {
      beginCompactionTurn();
    } catch (err) {
      logger.warn("orchestrator", "[message-processor] beginCompactionTurn failed", {
        error: (err as Error)?.message,
      });
    }

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
    // batch tools that had warnings. Listener self-removes after fire so it
    // can't double-fire on later aborts in the same turn. A1: `aborter` is
    // declared at function scope (not block-scoped) and explicitly removed in
    // the `finally` below — needed because `signal` may now be the OWNER's
    // long-lived controller (nested-call reuse, see above), and without this
    // cleanup every nested `processMessage` call would leak one more listener
    // onto that shared, long-lived signal instead of onto its own short-lived,
    // GC'd controller.
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

    const _sessionIdForBreadcrumbs = deps.session?.id;

    // Ensure flow run is ready before processing (fail-open).
    await preStreamPhase(
      "flowReady",
      _sessionIdForBreadcrumbs,
      () => deps.flowReady?.catch(() => {}) ?? Promise.resolve(),
    );

    // Upgrade to OAuth-backed provider on first turn if tokens are available.
    await preStreamPhase("initOAuthProvider", _sessionIdForBreadcrumbs, () => deps.initOAuthProvider().catch(() => {}));

    if (!deps.getSessionStartHookFired()) {
      deps.setSessionStartHookFired(true);
      const isResume = deps.messages.length > 0;
      const sessionStartInput: SessionStartHookInput = {
        hook_event_name: "SessionStart",
        source: isResume ? "resume" : "startup",
        session_id: deps.session?.id,
        cwd: deps.bash.getCwd(),
      };
      const sessionStartResult = await preStreamPhase("sessionStartHook", _sessionIdForBreadcrumbs, () =>
        deps.fireHook(sessionStartInput, signal).catch(() => ({
          blocked: false,
          blockingErrors: [] as Array<{ command: string; stderr: string }>,
          preventContinuation: false,
          additionalContexts: [] as string[],
          results: [] as import("../hooks/types.js").HookResult[],
        })),
      );
      // Inject the hook's stdout/additionalContext into THIS turn's stream
      // immediately — before PIL/routing decides DIRECT_ANSWER vs a tool
      // turn. A no-tool DIRECT_ANSWER turn never reaches the PreToolUse
      // content-yield path (tool-engine.ts), so without this the very first
      // reply of a session could never show a SessionStart hook's output
      // (e.g. a project's own onboarding briefing script).
      const _sessionStartContexts = (sessionStartResult?.additionalContexts ?? []).filter((ctx) => !!ctx?.trim());
      for (const ctx of _sessionStartContexts) {
        yield { type: "content", content: `${ctx}\n` };
      }
      // Parity fix: the yield-loop above is UI-only — same gap as the
      // EE-guidance/recall-nudge system-message injections elsewhere in this
      // function (search "the model can actually see" in this file). Without
      // also pushing this into `deps.messages`, the MODEL never learns the
      // hook already ran: measured live, the model's own reasoning noted "a
      // system note about session start" and then tried to re-run the hook's
      // command itself on a turn that had no tools, leaking raw tool-call
      // markup as its answer. Claude Code's own SessionStart hooks give the
      // model `additionalContext` worded so it knows the content was already
      // shown — mirrored here as a `system` message, once per session (same
      // guard as the display loop above), ordered before this turn's own
      // user message so it reads as prior context, not a reply to ask about.
      if (_sessionStartContexts.length > 0) {
        // Round 2 (G1 HIGH): REPLACE, don't append — a `--resume` process
        // rehydrates the persisted transcript first, so a tagged message
        // from a PRIOR process may already be sitting in `deps.messages`.
        // Remove it before pushing the fresh one, keeping `deps.messages`/
        // `deps.messageSeqs` in lockstep (parallel arrays, same index).
        const _priorTaggedIdx = deps.messages.findIndex(
          (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith(SESSION_START_SYSTEM_TAG),
        );
        if (_priorTaggedIdx !== -1) {
          deps.messages.splice(_priorTaggedIdx, 1);
          deps.messageSeqs.splice(_priorTaggedIdx, 1);
        }
        deps.messages.push({
          role: "system",
          content: `${SESSION_START_SYSTEM_TAG} — already shown to the user verbatim above; do not re-run it or repeat it\n${_sessionStartContexts.join("\n")}`,
        });
        deps.messageSeqs.push(null);
      }
    }

    const promptInput: UserPromptSubmitHookInput = {
      hook_event_name: "UserPromptSubmit",
      user_prompt: userMessage,
      session_id: deps.session?.id,
      cwd: deps.bash.getCwd(),
    };
    await preStreamPhase("userPromptSubmitHook", _sessionIdForBreadcrumbs, () =>
      deps.fireHook(promptInput, signal).catch(() => {}),
    );

    await preStreamPhase("consumeBackgroundNotifications", _sessionIdForBreadcrumbs, () =>
      deps.consumeBackgroundNotifications(),
    );

    const _debugOn = isDebugEnabled();
    const _debugSteps: PipelineStep[] = [];
    const _debugTurnId = deps.messages.filter((m) => m.role === "user").length + 1;

    // PIL: enrich prompt before pushing to messages (D-01, D-03, D-04)
    // Promise.race timeout of 200ms is inside runPipeline — fail-open guaranteed
    // NOTE this guarantee is NOT unconditional: runPipeline() takes the
    // Promise.race path only when discovery is off or non-interactive; the
    // live interactive-discovery path (the default) awaits runLayers()
    // directly with no outer race — see pil/pipeline.ts runPipeline(). This
    // phase's own breadcrumb pair is the backstop for that gap.
    breadcrumb("pre-stream.pilPrep.start", { sessionId: _sessionIdForBreadcrumbs });
    const prepGen = prepareTurnContext(deps, userMessage, _budgetOverride);
    let prepResult: import("./preprocessor.js").PreprocessorResult | undefined;
    while (true) {
      const res = await prepGen.next();
      if (res.done) {
        prepResult = res.value;
        break;
      }
      yield res.value as StreamChunk;
    }
    breadcrumb("pre-stream.pilPrep.end", { sessionId: _sessionIdForBreadcrumbs });
    const { pilCtx, _stepCeiling, _pilStart, _naturalCeiling, _ceilingTaskType, _ceilingSize } = prepResult!;

    const cwd = deps.bash.getCwd();
    if (
      isGsdNativeEnabled() &&
      shouldRunGate(pilCtx, () => {
        try {
          return readState(cwd).phase;
        } catch (err) {
          // Missing/corrupt .planning state is the normal "no active run" case, not an error.
          console.error(
            `[pil-gate] readState failed while checking resume phase (treating as no active run): ${(err as Error).message}`,
          );
          return null;
        }
      })
    ) {
      breadcrumb("pre-stream.gsdGate.start", { sessionId: _sessionIdForBreadcrumbs });
      try {
        const sessionModel = deps.session?.model ?? "unknown";
        let depth: "quick" | "standard" | "heavy" = pilCtx.modelDepthTier ?? pilCtx.complexityTier ?? "standard";

        // Leader-tier assessor enrichment: OVERRIDES the fast-classifier depth
        // before it's written to SDK STATE.md. `assessComplexity` itself never
        // throws (every internal step is caught, degrading to `priorDepth`),
        // but this inner try/catch is defensive fail-open insurance so even an
        // unexpected throw here keeps `depth` at its fast-classifier value —
        // syncWorkflowContext below is never skipped because of the assessor.
        let brief = "";
        if (isComplexityAssessorEnabled()) {
          try {
            const { buildGateContextBundle } = await import("../gsd/pil-gate-context.js");
            const bundle = buildGateContextBundle({
              cwd,
              conversationDigest: deps.buildRecentTurnsSummary(),
              brainData: pilCtx._brainData,
            });
            const assessed = await assessComplexity({
              cwd,
              raw: pilCtx.raw,
              priorDepth: depth,
              confidence: pilCtx.confidence,
              bundle,
              sessionModelId: sessionModel,
              runAssessor: buildLeaderAssessorRunner(deps, sessionModel), // single-shot leader call
            });
            depth = assessed.depth;
            // Keep the native depth slot authoritative: write the assessed depth
            // back to pilCtx.modelDepthTier so every downstream consumer that reads
            // it (tool-engine depthTier -> gsd tool registration + gsd_verify depth
            // + layer-derived tiering) sees the SAME value the mutation gate reads
            // from STATE.md. Without this, the gate (readState().depth) and gsd_verify
            // (pilCtx.modelDepthTier) diverge on any assessor override. Same pilCtx
            // ref, and this block runs before executeToolEngine in the same turn.
            pilCtx.modelDepthTier = depth;
            if (assessed.assessed) pilCtx.gsdAutoCouncil = assessed.autoCouncil;

            if (isPilGateEnrichEnabled() && assessed.enrichedPrompt) {
              let verdict = assessed.quality?.verdict ?? "enriched";
              brief = assessed.enrichedPrompt;
              if (depth === "heavy") {
                const { runGateCritics } = await import("../gsd/pil-gate-critic.js");
                const critiqued = await runGateCritics({
                  draftBrief: brief,
                  draftVerdict: verdict,
                  bundle,
                  runCritic: buildGateCriticRunner(deps, sessionModel),
                });
                verdict = critiqued.verdict;
                brief = critiqued.brief;
              }
              if (verdict === "adequate") brief = "";
            }
          } catch (assessErr) {
            brief = "";
            console.error(`[pil-gate] enrichment failed, using raw prompt: ${(assessErr as Error).message}`);
          }
        }

        if (brief) {
          pilCtx.enriched = `[PIL Gate brief]\n${brief.slice(0, 1500)}\n\n${pilCtx.enriched}`;
        }
        getGsdLoopHost().ensureHost(cwd, sessionModel);
        syncWorkflowContext(cwd, sessionModel, depth);
      } catch (err) {
        console.error(`[gsd-loop-host] turn sync failed: ${(err as Error).message}`);
      }
      breadcrumb("pre-stream.gsdGate.end", { sessionId: _sessionIdForBreadcrumbs });
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
      pilCtx.metrics?.suffixInstructionTokens ?? Math.round(((enrichedMessage ?? "").length - userMessage.length) / 4),
    );
    const _pilEnrichmentDeltaSnapshot =
      pilCtx.metrics?.suffixInstructionTokens ?? Math.round(((enrichedMessage ?? "").length - userMessage.length) / 4);

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
    breadcrumb("pre-stream.pilInteractionLog.start", { sessionId: _sessionIdForBreadcrumbs });
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
    breadcrumb("pre-stream.pilInteractionLog.end", { sessionId: _sessionIdForBreadcrumbs });

    // ROUTE-11: Per-turn model routing via decide() — picks cheapest capable model
    const turnStartMs = Date.now();
    let turnModelId = deps.modelId;
    let taskHash: string | null = null;
    let routeReason: string | null = null;
    const historyHasImages = deps.messages.some(
      (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((p) => p.type === "image"),
    );
    const turnHasImages = (images?.length ?? 0) > 0;
    let visionUnavailableNotice: string | null = null;
    const _routeStart = Date.now();
    breadcrumb("pre-stream.routerDecide.start", { sessionId: _sessionIdForBreadcrumbs });
    // Gap (d) / round-2 fix: a project-level `.muonroi-cli/settings.json`
    // `{"model": "..."}` pin is an explicit instruction, not a mere default
    // the per-turn router may second-guess for the MAIN conversation turn
    // (see `isModelPinnedByProject`'s doc comment) — but the cap/budget
    // reservation + downgrade-chain/halt check must still run against
    // whatever model actually ends up executing. Passing `forcedModel` makes
    // decide() skip ONLY the free model-choice classifier ladder
    // (role/PIL/hot/warm/cold) while still routing the pinned model through
    // the SAME capCheck any other decision goes through — see
    // `DecideOpts.forcedModel`'s doc comment in router/decide.ts. A prior
    // version of this fix skipped decide() entirely for a pinned turn, which
    // also skipped that cap check (round-2 refuter finding, HIGH). Cheap
    // sub-tasks (tool-loop rounds in tool-engine.ts, council sub-tasks) call
    // decide()/routeModel() through their own, separate paths and are
    // unaffected — they may still downgrade independently of the pin.
    {
      const pinnedModel = isModelPinnedByProject() ? deps.modelId : undefined;
      try {
        const { decide } = await import("../router/decide.js");
        const compactionMsg = deps.messages.find(
          (m) => typeof m.content === "string" && m.content.startsWith("[Context checkpoint summary]"),
        );
        const compactionSummary =
          compactionMsg && typeof compactionMsg.content === "string"
            ? compactionMsg.content.slice("[Context checkpoint summary]".length).trim()
            : null;

        const routeDecision = await decide(userMessage, {
          tenantId: "local",
          cwd: deps.bash.getCwd(),
          defaultModel: deps.modelId,
          defaultProvider: deps.providerId,
          ...(pinnedModel ? { forcedModel: pinnedModel } : {}),
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
            turnIndex: deps.messages.filter((m) => m.role === "user").length,
            messageCount: deps.messages.length,
            compactionCount: deps.getCompactionStats().count,
            totalSavedTokens: deps.getCompactionStats().totalSaved,
            compactionSummary,
          },
        });
        if (routeDecision.model && routeDecision.model !== "HALT") {
          // Respect user's default model when it has a vision proxy and the
          // current turn (or history) has images — the proxy will convert
          // images to text, so there's no need to switch to a vision-capable
          // (and usually pricier / rate-limited) model.
          const defaultHasVisionProxy = needsVisionProxy(deps.modelId);
          const imagesOnTurn = turnHasImages || historyHasImages;
          const canHandleImages =
            !defaultHasVisionProxy || !imagesOnTurn || (await canHandleImagesForTextOnlyModel(deps.modelId));
          const skipVisionRoute = defaultHasVisionProxy && imagesOnTurn && canHandleImages;
          if (!skipVisionRoute) {
            turnModelId = routeDecision.model;
          }
        }
        taskHash = routeDecision.taskHash ?? null;
        routeReason = routeDecision.reason ?? null;
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
      breadcrumb("pre-stream.routerDecide.end", { sessionId: _sessionIdForBreadcrumbs });
    }

    if (needsVisionProxy(turnModelId) && (turnHasImages || historyHasImages)) {
      breadcrumb("pre-stream.visionPlan.start", { sessionId: _sessionIdForBreadcrumbs });
      const imageCount = turnHasImages ? images!.length : 1;
      const plan = await planImageHandlingForTextOnlyModel({
        primaryModelId: turnModelId,
        imageCount,
      });
      if (plan.strategy === "native_model") {
        turnModelId = plan.fallback.modelId;
        routeReason = routeReason ? `${routeReason}; vision-native-fallback` : "vision-native-fallback";
        yield {
          type: "content",
          content: `[Vision: routed to ${plan.fallback.modelId} — no proxy backend; using native image support]\n`,
        };
      } else if (plan.strategy === "unavailable") {
        visionUnavailableNotice = plan.notice;
      }
      breadcrumb("pre-stream.visionPlan.end", { sessionId: _sessionIdForBreadcrumbs });
    }

    // Interaction log: model routing
    try {
      if (deps.session) {
        const promoted = turnModelId !== deps.modelId;
        logInteraction(deps.session.id, "routing", {
          model: turnModelId,
          eventSubtype: promoted ? "promoted" : "default",
          data: {
            defaultModel: deps.modelId,
            routedModel: turnModelId,
            promoted,
            // promo-cap(...) tag appears here when the promotion ceiling clamped
            // an EE premium pick down to balanced — queryable via event_subtype +
            // data.reason to audit cost-leak prevention (session 89b34ce9a4e8 class).
            reason: routeReason,
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
    breadcrumb("pre-stream.providerRedetect.start", { sessionId: _sessionIdForBreadcrumbs });
    const turnProviderId = detectProviderForModel(turnModelId);
    let turnProvider: LegacyProvider;
    if (turnProviderId !== deps.providerId) {
      const disabled = isProviderDisabled(turnProviderId as ProviderId);
      // Even if the key is reachable, skip disabled providers
      const turnKey = !disabled ? await loadKeyForProvider(turnProviderId).catch(() => null) : null;
      // An OAuth-capable provider may be authenticated by subscription tokens
      // (no env API key). Detect that so the turn can still run over OAuth.
      let hasOAuth = false;
      if (!disabled) {
        try {
          const { getOAuthProviderConfig } = await import("../providers/auth/registry.js");
          const cfg = await getOAuthProviderConfig(turnProviderId as ProviderId);
          const tokens = cfg ? await cfg.loadTokensWithRefresh().catch(() => null) : null;
          hasOAuth = !!tokens?.accessToken;
        } catch {
          hasOAuth = false;
        }
      }
      if (turnKey || hasOAuth) {
        // OAuth XOR API key: the ASYNC factory injects OAuth (codex baseURL +
        // Bearer headers) when tokens exist for this provider, otherwise it
        // uses the env key. Using the sync factory here was the cross-provider
        // shadowing bug (it shipped a stale sk-proj key to api.openai.com).
        const { createProviderFactoryAsync } = await import("../providers/runtime.js");
        const built = await createProviderFactoryAsync(turnProviderId, turnKey ? { apiKey: turnKey } : {});
        turnProvider = built.factory;
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
    breadcrumb("pre-stream.providerRedetect.end", { sessionId: _sessionIdForBreadcrumbs });

    // E4: prepend one-shot cwd note when setCwd() changed the working directory
    // mid-session. Clears after injection so only the first subsequent turn sees it.
    const cwdNote = deps.getPendingCwdNote();
    deps.setPendingCwdNote(null);
    const messageForDb = cwdNote ? `${cwdNote}\n\n${userMessage}` : userMessage;
    // Append raw input so the model can distinguish system enrichment from user's original text.
    const rawSuffix = pilCtx.raw && pilCtx.raw !== enrichedMessage ? `\n\n[Raw user input]\n${pilCtx.raw}` : "";
    const messageForModel = (cwdNote ? `${cwdNote}\n\n${enrichedMessage}` : enrichedMessage) + rawSuffix;

    let userModelMessage: ModelMessage;
    let userEnrichedMessage: ModelMessage;
    if (images?.length) {
      const partsDb: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> = [
        { type: "text", text: messageForDb },
      ];
      const partsModel: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> = [
        { type: "text", text: messageForModel },
      ];
      for (const img of images) {
        partsDb.push({ type: "image", image: img.base64, mediaType: img.mediaType });
        partsModel.push({ type: "image", image: img.base64, mediaType: img.mediaType });
      }
      userModelMessage = { role: "user", content: partsDb };
      userEnrichedMessage = { role: "user", content: partsModel };
    } else {
      userModelMessage = { role: "user", content: messageForDb };
      userEnrichedMessage = { role: "user", content: messageForModel };
    }

    // Vision proxy: convert images to text for models that don't support vision.
    // Process BOTH the current user message and any historical messages that
    // still carry image parts — otherwise sending the conversation back to a
    // text-only provider (e.g. DeepSeek) fails with "unknown variant
    // `image_url`" once history contains an image from a prior turn.
    if (needsVisionProxy(turnModelId) && (turnHasImages || historyHasImages)) {
      breadcrumb("pre-stream.visionProxy.start", { sessionId: _sessionIdForBreadcrumbs });
      const stripImagesFromMessages = (msgs: ModelMessage[]): ModelMessage[] =>
        msgs.map((m) => {
          if (!Array.isArray(m.content)) return m;
          const textParts = (m.content as Array<{ type: string; text?: string }>).filter((p) => p.type === "text");
          const joined = textParts.map((p) => p.text ?? "").join("\n");
          return { ...m, content: joined || "[image removed — vision unavailable]" } as typeof m;
        });

      if (visionUnavailableNotice) {
        yield {
          type: "content",
          content: "[Vision: cannot analyze images — no vision API key or vision model available]\n",
        };
        if (historyHasImages) {
          deps.setMessages(
            stripImagesFromMessages(deps.messages).map((m) => {
              if (m.role !== "user" || typeof m.content !== "string") return m;
              return { ...m, content: `${m.content}\n\n${visionUnavailableNotice}` };
            }),
          );
        }
        if (turnHasImages) {
          userModelMessage = {
            role: "user",
            content: `${messageForDb}\n\n${visionUnavailableNotice}`,
          };
          userEnrichedMessage = {
            role: "user",
            content: `${messageForModel}\n\n${visionUnavailableNotice}`,
          };
        }
      } else {
        try {
          if (historyHasImages) {
            const historyResult = await proxyVision(deps.messages, turnModelId, signal, deps.session?.id);
            if (historyResult.proxied) {
              deps.setMessages(historyResult.messages);
              yield {
                type: "content",
                content: `[Vision proxy: ${historyResult.imageCount} historical image(s) → text]\n`,
              };
            }
          }
          if (turnHasImages) {
            const proxyResult = await proxyVision(
              [userModelMessage, userEnrichedMessage],
              turnModelId,
              signal,
              deps.session?.id,
            );
            if (proxyResult.proxied) {
              userModelMessage = proxyResult.messages[0];
              userEnrichedMessage = proxyResult.messages[1];
              yield {
                type: "content",
                content: `[Vision proxy: ${proxyResult.imageCount} image(s) analyzed for ${turnModelId}]\n`,
              };
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[vision-proxy] message path failed: ${errMsg}`);
          const notice = visionUnavailableNotice ?? `[vision unavailable: ${errMsg}]`;
          yield { type: "content", content: "[Vision proxy: failed — images not sent to model]\n" };
          if (historyHasImages) {
            deps.setMessages(stripImagesFromMessages(deps.messages));
          }
          if (turnHasImages) {
            userModelMessage = { role: "user", content: `${messageForDb}\n\n${notice}` };
            userEnrichedMessage = { role: "user", content: `${messageForModel}\n\n${notice}` };
          }
        }
      }
      breadcrumb("pre-stream.visionProxy.end", { sessionId: _sessionIdForBreadcrumbs });
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
    // Cross-turn dedup: compute sha of the rendered guidance; skip if identical
    // to the previous turn (same guidance, same ~200-800 tokens saved per turn).
    if (deps.sessionEEGuidance.size > 0) {
      const lines = Array.from(deps.sessionEEGuidance.entries()).map(([, g]) => {
        const pct = Math.round(g.confidence * 100);
        return `- [${g.toolName}] ${g.message} (Why: ${g.why}) [${pct}%]`;
      });
      const content = `[EE Session Guidance — avoid these patterns when using tools]\n${lines.join("\n")}`;
      const sid = deps.session?.id ?? "_anon";
      const { createHash: _guidanceHash } = await import("node:crypto");
      const sha = _guidanceHash("sha256").update(content).digest("hex").slice(0, 16);
      if (_injectedGuidanceSha.get(sid) === sha) {
        // Identical guidance already injected — skip.
      } else {
        _injectedGuidanceSha.set(sid, sha);
        deps.messages.push({ role: "system", content });
        deps.messageSeqs.push(null);
      }
    }

    // Fix 3: inject pending recall-feedback nudge as a system message the
    // model can actually see. Previously recall reminders were yield-content
    // (UI-only) — the model never read them. Inject at turn start so the
    // agent can batch-rate hints at the beginning of its next response,
    // before diving into the user's new task. Deduped by sha like guidance.
    try {
      const { sessionRecallLedger, isRecallLedgerEnabled, isRecallNagSuppressed } = await import(
        "../ee/recall-ledger.js"
      );
      // Suppressed when the caller declared this turn MACHINE-READ (see
      // recall-ledger.ts). The nag would otherwise instruct a sub-agent whose
      // only job is to emit a verdict marker to go do EE bookkeeping first.
      if (isRecallLedgerEnabled() && !isRecallNagSuppressed()) {
        const pending = sessionRecallLedger.pending();
        if (pending.length > 0) {
          const hintLines = pending
            .slice(0, 10)
            .map(
              (p) =>
                `  - ee_feedback(id="${p.id}", collection="${p.collection ?? "?"}", verdict=followed|ignored|noise)`,
            );
          const more = pending.length > 10 ? `\n  ...and ${pending.length - 10} more` : "";
          const recallContent =
            `↳ ${pending.length} earlier EE hint(s) still unrated. Rate the one(s) you actually ` +
            `acted on so the brain keeps what helped — this does NOT block the task; batch the ` +
            `ee_feedback call(s) alongside your work, don't stall the user's request on it.\n` +
            `Verdict: followed (you used it) | ignored (topical, didn't apply) | noise (wrong — needs reason).\n` +
            `${hintLines.join("\n")}${more}\n` +
            `Rate once and move on — a hint you can't judge yet, leave for later; re-rating the same ` +
            `id does not help. If the brain is unreachable the verdict is queued, so never retry-loop on it.`;

          const sid = deps.session?.id ?? "_anon";
          const { createHash: _recallHash } = await import("node:crypto");
          const recallSha = _recallHash("sha256").update(recallContent).digest("hex").slice(0, 16);
          const recallKey = `recall_${sid}`;
          if (_injectedGuidanceSha.get(recallKey) !== recallSha) {
            _injectedGuidanceSha.set(recallKey, recallSha);
            deps.messages.push({ role: "system", content: recallContent });
            deps.messageSeqs.push(null);
          }
        }
      }
    } catch {
      /* fail-open — EE unreachable is never a blocker */
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
    // F3c — tool-turn system prompt: same context, but skips native-capabilities
    // and skills sections (~4K tokens) that the model already saw on the first
    // call.  The orchestrator switches to this on the 2nd+ streamText invocation.
    const toolTurnParts = buildSystemPromptParts(
      deps.bash.getCwd(),
      deps.mode,
      deps.bash.getSandboxMode(),
      deps.getPlanContext(),
      subagents,
      deps.bash.getSandboxSettings(),
      deps.providerId,
      deps.getResumeDigest(),
      { chitchat: isChitchat, toolTurn: true },
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
    // Tool-turn system: same template as system but with toolTurn-prefix
    const toolTurnSystem = applyModelConstraints(
      applyPilSuffix(
        `${toolTurnParts.staticPrefix}${playwrightGuidance}${toolTurnParts.dynamicSuffix}`,
        pilCtx,
        _hasResponseTools,
      ),
      turnModelId,
    );
    const runtime = resolveModelRuntime(turnModelId, { stage: "main", sessionId: deps.session?.id });
    const modelInfo = runtime.modelInfo;

    // SAMR: Step-Aware Model Routing — downgrade to fast model for tool-execution
    // steps after the initial reasoning step. The premium model decides WHAT to do;
    // a cheaper model handles the mechanical "read results, call more tools" loop.
    //
    // EE-guided override: when SAMR is disabled in user config, ask the EE brain
    // whether this task benefits from a reasoning/execution split. The EE may
    // enable SAMR on-the-fly for complex tasks, then the static config takes
    // over on the next turn. Falls back to static config on timeout/error.
    let stepRouterCfg = getStepRouterConfig();
    if (!stepRouterCfg.enabled) {
      const pilCtxForSamr = pilCtx; // captured at line 649
      const eeGuidance = await preStreamPhase("samrGuidance", _sessionIdForBreadcrumbs, () =>
        eeSamrGuidance({
          userMessage,
          taskType: pilCtxForSamr.taskType,
          taskConfidence: pilCtxForSamr.confidence,
          complexitySize: pilCtxForSamr.complexitySize?.size,
          taskComplexity: (pilCtxForSamr as { _intentTrace?: { complexity?: string } })._intentTrace?.complexity,
        }),
      );
      if (eeGuidance.overrideConfig) {
        stepRouterCfg = eeGuidance.overrideConfig;
        _debugSteps.push({
          name: "EESamrGuidance",
          duration_ms: 0,
          input_summary: "",
          output_summary: eeGuidance.reason,
        });
      }
    }
    // Parity fix (G3): same pin the earlier decide()/forcedModel gate uses
    // (see "Gap (d) / round-2 fix" above) — SAMR must not downgrade a
    // pinned orchestrator turn's tool-continuation steps. See
    // decideStepRouting's `opts.pinned` doc comment in router/step-router.ts.
    const stepRouterDecision = decideStepRouting(turnModelId, deps.providerId, stepRouterCfg, {
      pinned: isModelPinnedByProject(),
    });
    const stepRouterPhase: "phase1" | "phase2" | "done" = stepRouterDecision.phase2ModelId ? "phase1" : "done";
    const phase2Runtime = stepRouterDecision.phase2ModelId
      ? resolveModelRuntime(stepRouterDecision.phase2ModelId, { stage: "main", sessionId: deps.session?.id })
      : null;
    if (stepRouterDecision.phase2ModelId && _debugOn) {
      _debugSteps.push({
        name: "StepRouter",
        duration_ms: 0,
        input_summary: `phase1=${turnModelId}`,
        output_summary: stepRouterDecision.reason,
      });
    }

    // Phase 5 continuation fix: do not clear planContext on bare "tiếp tục"/"continue".
    // Re-hydrate from persisted approved plan if needed (cross-process or after abort).
    const _isCont = isContinuationPhrase(userMessage);
    if (!_isCont) {
      deps.setPlanContext(null);
    } else if (!deps.getPlanContext()) {
      const _p = getLastApprovedPlan(deps.session?.id ?? "");
      if (_p) deps.setPlanContext(_p);
    }
    const attemptedOverflowRecovery = false;
    // Stream-retry state: track how many transient retries have been attempted
    // for the current turn. Reset to 0 on each new user turn (we're in processMessage).
    const streamRetryCount = 0;
    const MAX_STREAM_RETRIES = 2; // 3 total attempts = 1 first try + 2 retries
    // Re-steer budget for a tool-call emitted as plain text (wrong dialect). One
    // corrective retry: if the model still emits text instead of invoking the
    // tool, we surface the warning and stop rather than loop. Loop-persistent so
    // a model that degrades every step can't burn unbounded re-steers.
    const textToolReSteerCount = 0;
    const MAX_TEXT_TOOL_RESTEER = 2; // DeepSeek often needs 2 re-steers (DSML text → real tool call)
    const patternLoopInjectCount = 0;
    const patternLoopForceHalt = false;
    const agentLoopDecisionCount = 0;
    const MAX_AGENT_LOOP_DECISIONS = 2;
    // Silent-hang guard: set true when the stall watchdog aborts a stuck stream.
    // Reset before each streamText attempt; read in the stream catch to surface a
    // clear toast and SKIP the transient-retry (a stalled provider just stalls
    // again, wasting another full timeout of silence).
    try {
      yield* executeToolEngine({
        deps,
        ownsController,
        stepRouterPhase,
        phase2Runtime,
        runtime,
        modelInfo,
        _debugSteps,
        _ceilingHit,
        userMessage,
        pilCtx,
        turnModelId,
        turnProvider,
        _stepCeiling,
        userModelMessage,
        userEnrichedMessage,
        signal,
        observer,
        taskHash,
        provider,
        system,
        toolTurnSystem,
        routerStore,
        attemptedOverflowRecovery,
        patternLoopForceHalt,
        userWriteAheadSeq,
        streamRetryCount,
        MAX_STREAM_RETRIES,
        subagents,
        systemParts,
        playwrightGuidance,
        _hasResponseTools,
        _pilResponseTools,
        patternLoopInjectCount,
        agentLoopDecisionCount,
        MAX_AGENT_LOOP_DECISIONS,
        _naturalCeiling,
        _ceilingTaskType,
        _ceilingSize,
        textToolReSteerCount,
        MAX_TEXT_TOOL_RESTEER,
        turnStartMs,
        _debugOn,
        _debugTurnId,
        _pilEnrichmentDeltaSnapshot,
        isChitchat,
      });
    } finally {
      // A1: always detach the P0 aborter — see the declaration site above for
      // why this is mandatory now that `signal` can be a long-lived, reused
      // owner signal rather than always a fresh, GC-eligible one.
      signal.removeEventListener("abort", aborter);
      // A1: only the call that OWNS the controller may clear it. A nested
      // call (ownsController === false) reused the owner's controller and
      // must never null it out from under the still-running owner.
      if (ownsController && deps.getAbortController()?.signal === signal) {
        deps.setAbortController(null);
      }
      // Meter the C3 same-turn re-serve cost — the dedup deliberately re-bills
      // full content on same-turn re-reads (avoiding a worse single-read
      // fallback), and that cost was invisible. Emit cumulative per session so
      // cost-leak analysis can attribute it and a future policy fix is
      // falsifiable. Only when there is something to report.
      const dstats = deps.crossTurnDedup?.getStats();
      if (deps.session?.id && dstats && (dstats.sameTurnReservedChars > 0 || dstats.staleReserves > 0)) {
        logInteraction(deps.session.id, "dedup", {
          data: {
            hits: dstats.hits,
            sameTurnReserves: dstats.sameTurnReserves,
            sameTurnReservedChars: dstats.sameTurnReservedChars,
            approxTokens: Math.round(dstats.sameTurnReservedChars / 4),
            // Pointer-reachability repairs. Each staleReserve is a re-serve that
            // replaced a pointer at a payload compaction had already removed —
            // i.e. a nine-call dead-pointer loop that did not happen. Logged so
            // the dedup↔compaction fix stays falsifiable from the DB alone.
            staleReserves: dstats.staleReserves,
            staleReservedChars: dstats.staleReservedChars,
            invalidated: dstats.invalidated,
          },
        });
      }
    }
  }
}

export function stripDsmlMarkup(text: string): string {
  if (!text) return "";
  // Strip entire <｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls> block including content
  let cleaned = text.replace(/<[^>]*｜｜DSML｜｜tool_calls[^>]*>[\s\S]*?<\/?[^>]*｜｜DSML｜｜tool_calls[^>]*>/gi, "");
  // Also strip any individual invoke/parameter tags with U+FF5C bars
  cleaned = cleaned.replace(/<[^>]*｜｜DSML｜｜[^>]*>/gi, "");
  return cleaned.trim();
}
