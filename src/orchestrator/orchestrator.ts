// Multi-provider wired — runtime dispatch via providers/runtime.ts.

import { APICallError } from "@ai-sdk/provider";
import { convertToBase64 } from "@ai-sdk/provider-utils";
import { generateText, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { getCachedAuthToken, getCachedServerBaseUrl } from "../ee/auth.js";
import { routeFeedback, routeModel } from "../ee/bridge.js";
import { extractSession } from "../ee/extract-session.js";
import {
  bootstrapEEClient,
  getDefaultEEClient,
  getDefaultEEClient as getEEClientForVeto,
  getLastSurfacedState,
} from "../ee/intercept.js";
import { getMistakeDetector } from "../ee/mistake-detector.js";
import { fireAndForgetPhaseOutcome } from "../ee/phase-outcome.js";
import * as phaseTracker from "../ee/phase-tracker.js";
import { buildScope as buildScopeForVeto } from "../ee/scope.js";
import { fireTrajectoryEvent } from "../ee/session-trajectory.js";
import { getTenantId, getTenantId as getTenantIdForVeto } from "../ee/tenant.js";
import { createRun, getActiveRunId, setActiveRunId } from "../flow/run-manager.js";
import { ensureFlowDir } from "../flow/scaffold.js";
import { executeEventHooks } from "../hooks/index";
import type {
  NotificationHookInput,
  PostCompactHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TaskCompletedHookInput,
  TaskCreatedHookInput,
  UserPromptSubmitHookInput,
} from "../hooks/types";
import { shutdownWorkspaceLspManager } from "../lsp/runtime";
import { ensureDefaultMcpServers } from "../mcp/auto-setup.js";
import { buildMcpToolSet } from "../mcp/runtime";
import { getModelByTier, getModelInfo, getModelsForProvider, normalizeModelId } from "../models/registry.js";
import { applyPilSuffix, getResponseTaskType, getResponseToolSet, isResponseTool, runPipeline } from "../pil/index.js";
import { taskTypeToMaxTokens, taskTypeToReasoningEffort, taskTypeToTier } from "../pil/task-tier-map.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { apiBaseFor } from "../providers/endpoints.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import {
  bridgeMcpToolResult,
  getVisionGuidanceForTextOnly,
  scrubImagePayloadsInMessages,
} from "../providers/mcp-vision-bridge.js";
import { captureToolSchemas } from "../providers/patch-zod-schema.js";
import {
  buildTurnProviderOptions,
  createProviderFactory,
  createProviderFactoryAsync,
  detectProviderForModel,
  type ProviderFactory,
  type ResolvedModelRuntime as RuntimeResult,
  resolveModelRuntime as resolveRuntime,
  shouldDropParam,
} from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { needsVisionProxy, proxyVision } from "../providers/vision-proxy.js";
import { wireDebug } from "../providers/wire-debug.js";
import { reportRouteOutcome } from "../router/decide.js";
import { decideStepRouting, getStepRouterConfig } from "../router/step-router.js";
import { routerStore } from "../router/store.js";
import {
  appendCompaction,
  appendMessages,
  appendSystemMessage,
  buildChatEntries,
  getNextMessageSequence,
  getSessionTotalTokens,
  loadTranscript,
  loadTranscriptState,
  logInteraction,
  markMessageCompleted,
  markMessageErrored,
  markToolCallErrored,
  persistMessageWriteAhead,
  persistToolCallWriteAhead,
  recordUsageEvent,
  SessionStore,
} from "../storage/index";
import { BashTool } from "../tools/bash";
import { createBuiltinTools } from "../tools/registry.js";
import { type ScheduleDaemonStatus, ScheduleManager, type StoredSchedule } from "../tools/schedule";
import type {
  AgentMode,
  ChatEntry,
  ModelInfo,
  Plan,
  SessionInfo,
  SessionSnapshot,
  StreamChunk,
  SubagentStatus,
  TaskRequest,
  ToolCall,
  ToolResult,
  UsageSource,
  VerifyRecipe,
  WorkspaceInfo,
} from "../types/index";
import { isDebugEnabled, type PipelineStep, recordTurnTrace, type TurnTrace } from "../ui/slash/debug.js";
import { statusBarStore } from "../ui/status-bar/store.js";
import { appendCostLog } from "../usage/cost-log.js";
import { appendDecisionLog } from "../usage/decision-log.js";
import { projectCostUSD } from "../usage/estimator.js";
import { loadCustomInstructions } from "../utils/instructions";
import { type PermissionMode, toolNeedsApproval } from "../utils/permission-mode.js";
import {
  type CustomSubagentConfig,
  getAutoCompactThresholdPct,
  getAutoCouncilConfidence,
  getAutoCouncilMinRoles,
  getCouncilRounds,
  getCurrentModel,
  getCurrentShellSettings,
  getModeSpecificModel,
  getRoleModel,
  getRoleModels,
  getSubAgentBudgetChars,
  getSubAgentCompactKeepLast,
  getSubAgentCompactThresholdChars,
  getTopLevelCompactKeepLast,
  getTopLevelCompactThresholdChars,
  getTopLevelToolBudgetChars,
  isAutoCompactAfterTurnEnabled,
  isAutoCouncilEnabled,
  isCouncilMultiProviderPreferred,
  isProviderDisabled,
  loadMcpServers,
  loadValidSubAgents,
  type ModelRole,
  type SandboxMode,
  type SandboxSettings,
} from "../utils/settings";
import { runSideQuestion, type SideQuestionResult } from "../utils/side-question";
import { discoverSkills, formatSkillsForPrompt } from "../utils/skills";
import { buildVerifyDetectPrompt, normalizeVerifyRecipe, prepareVerifySandbox } from "../verify/entrypoint";
import { runVerifyOrchestration } from "../verify/orchestrator";
import {
  type AgentOptions,
  type BatchChatCompletionRequest,
  type BatchChatCompletionResponse,
  type BatchChatMessage,
  type BatchClientOptions,
  type BatchFunctionTool,
  type BatchToolCall,
  COUNCIL_COLOR_BG,
  COUNCIL_COLOR_RESET,
  COUNCIL_ROLE_COLORS,
  type LegacyProvider,
  type ModelInfoStub,
  type ProcessMessageError,
  type ProcessMessageFinishReason,
  type ProcessMessageObserver,
  type ProcessMessageStepFinish,
  type ProcessMessageStepStart,
  type ProcessMessageToolFinish,
  type ProcessMessageToolStart,
  type ProcessMessageUsage,
  type ResolvedModelRuntime,
} from "./agent-options";
import {
  accumulateUsage,
  asNumber,
  buildAssistantBatchMessage,
  buildBatchChatCompletionRequest,
  buildBatchName,
  buildToolBatchMessage,
  type ExecutedBatchTool,
  extractJsonObject,
  getBatchFinishReason,
  getBatchUsage,
  hasUsage,
  parseToolArgumentsOrRaw,
  sumDefined,
  toBase64DataContent,
  toBatchChatMessages,
  toLocalToolCall,
  toolOutputToText,
  toSerializableValue,
} from "./batch-utils";
import {
  type CompactionSettings,
  createCompactionSummaryMessage,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  estimateConversationTokens,
  extractUserContent,
  generateCompactionSummary,
  POST_TURN_MIN_TOKENS,
  prepareCompaction,
  relaxCompactionSettings,
  shouldCompactContext,
} from "./compaction";
import { CouncilManager } from "./council-manager.js";
import { CrossTurnDedup, isCrossTurnDedupEnabled, wrapToolSetWithDedup } from "./cross-turn-dedup.js";
import { DelegationManager } from "./delegations";
import { humanizeApiError, isAuthenticationError, isContextLimitError } from "./error-utils";
import { loadFlowResumeDigest } from "./flow-resume.js";
import { lastPersistedSeq } from "./message-seq.js";
import { stableCallId } from "./pending-calls.js";
import {
  applyModelConstraints,
  buildSubagentPrompt,
  buildSystemPrompt,
  buildSystemPromptParts,
  COMPUTER_MODEL,
  findCustomSubagent,
  formatCustomSubagentsPromptSection,
  MAX_TOOL_ROUNDS,
  type SystemPromptParts,
  VISION_MODEL,
} from "./prompts";
import { extractProviderOptionsShape } from "./provider-options-shape.js";
import { getReadPathBudgetCap, ReadPathBudget, wrapToolSetWithReadBudget } from "./read-path-budget.js";
import { containsEncryptedReasoning, sanitizeModelMessages } from "./reasoning";
import { classifyStreamError } from "./retry-classifier.js";
import { withStreamRetry } from "./retry-stream.js";
import { StreamRunner, type StreamRunnerDeps } from "./stream-runner.js";
import { wrapToolSetWithCap } from "./sub-agent-cap.js";
import { compactSubAgentMessages } from "./subagent-compactor.js";
import { setProviderHint } from "./token-counter.js";
import {
  combineAbortSignals,
  firstLine,
  formatSubagentActivity,
  getFinishReason,
  getStepNumber,
  getUsage,
  notifyObserver,
  parseToolArgs,
  toToolCall,
  toToolResult,
  truncate,
} from "./tool-utils";

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

/**
 * Create a provider factory for the given provider ID using the shared runtime module.
 */
function createProvider(providerId: ProviderId, apiKey: string, baseURL?: string): LegacyProvider {
  return createProviderFactory(providerId, { apiKey, baseURL }).factory;
}

/**
 * Generate a session title using the Anthropic provider.
 * Kept as a lightweight stub for Phase 0 — title generation ships in Phase 1.
 */
function genTitle(
  _provider: LegacyProvider,
  userMessage: string,
): Promise<{ title: string; modelId: string; usage?: { totalTokens?: number } }> {
  // Phase 0 stub: return a truncated version of the first user message as title.
  // Phase 1 will replace this with a real LLM-based title generation call.
  const title = userMessage.slice(0, 60).trim() || "New session";
  return Promise.resolve({ title, modelId: DEFAULT_MODEL });
}

/**
 * Resolve a model ID to a runnable AI SDK LanguageModel.
 * Uses the Anthropic provider factory created by createProvider().
 */
function resolveModelRuntime(provider: LegacyProvider, modelId: string): ResolvedModelRuntime {
  return resolveRuntime(provider, modelId);
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

async function toolSetToBatchTools(_tools: ToolSet): Promise<BatchFunctionTool[]> {
  // Batch API not supported with Anthropic in Phase 0. Phase 1 may add this.
  throw new Error("Batch API not available in Phase 0. Use standard streaming mode.");
}

async function createBatch(_opts: BatchClientOptions & { name?: string }): Promise<{ batch_id: string }> {
  throw new Error("Batch API not available in Phase 0. Use standard streaming mode.");
}

async function addBatchRequests(
  _opts: BatchClientOptions & { batchId: string; batchRequests: unknown[] },
): Promise<void> {
  throw new Error("Batch API not available in Phase 0. Use standard streaming mode.");
}

async function pollBatchRequestResult(
  _opts: BatchClientOptions & { batchId: string; batchRequestId: string },
): Promise<unknown> {
  throw new Error("Batch API not available in Phase 0. Use standard streaming mode.");
}

function getBatchChatCompletion(_result: unknown): BatchChatCompletionResponse {
  throw new Error("Batch API not available in Phase 0. Use standard streaming mode.");
}

function createTools(
  _bash: unknown,
  _provider: LegacyProvider,
  _mode: unknown,
  _opts?: {
    runTask?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
    runDelegation?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
    readDelegation?: (id: string) => Promise<ToolResult>;
    listDelegations?: () => Promise<ToolResult>;
    scheduleManager?: unknown;
    subagents?: unknown[];
    sendTelegramFile?: (filePath: string) => Promise<ToolResult>;
    sessionId?: string;
    modelId?: string;
  },
): ToolSet {
  return createBuiltinTools(_bash as BashTool, (_mode ?? "agent") as AgentMode, {
    runTask: _opts?.runTask,
    runDelegation: _opts?.runDelegation,
    readDelegation: _opts?.readDelegation,
    listDelegations: _opts?.listDelegations,
    modelId: _opts?.modelId,
  });
}

async function buildVisionUserMessages(_prompt: string, _cwd: string, _signal?: AbortSignal): Promise<ModelMessage[]> {
  // Vision input is an anti-feature per PROJECT.md Out-of-Scope. Always throws.
  throw new Error("Vision input is not supported in muonroi-cli (anti-feature per PROJECT.md).");
}

// ---------------------------------------------------------------------------
// END Plan 00-05 provider implementations
// ---------------------------------------------------------------------------

// ============================================================================
// Agent class — fields, constructor, session management, core processing loop
// ============================================================================

export class Agent {
  private provider: LegacyProvider | null = null;
  private providerId: ProviderId = "anthropic";
  private apiKey: string | null = null;
  private baseURL: string | null = null;
  private bash: BashTool;
  private delegations: DelegationManager;
  private schedules: ScheduleManager;
  private sessionStore: SessionStore | null = null;
  private workspace: WorkspaceInfo | null = null;
  private session: SessionInfo | null = null;
  private messages: ModelMessage[] = [];
  private messageSeqs: Array<number | null> = [];
  private abortController: AbortController | null = null;
  private maxToolRounds: number;
  private mode: AgentMode = "agent";
  private modelId: string;
  private maxTokens: number;
  private planContext: string | null = null;
  private subagentStatusListeners = new Set<(status: SubagentStatus | null) => void>();
  private sendTelegramFile: ((filePath: string) => Promise<ToolResult>) | null = null;
  private batchApi = false;
  private sessionStartHookFired = false;
  /** PIL context for current turn — set after runPipeline, cleared after recordUsage. */
  private _pilActive = false;
  private _pilEnrichmentDelta = 0;
  /**
   * Breakdown of the system prompt + messages + tools sent on the last call.
   * Captured immediately before streamText and consumed by recordUsage to
   * attach to the cost-log entry. Cleared after recordUsage so subsequent
   * non-message calls don't reuse stale data.
   */
  private _lastPromptBreakdown: Record<string, number> | null = null;
  /**
   * Task 2.6a — Per-streamText-call correlation ID for llm-token / llm-done harness events.
   * Set to crypto.randomUUID() at the start of each streamText call; cleared to "" after llm-done.
   * Empty string means no active call.
   */
  private _currentCallId = "";
  /**
   * Phase O1 — JSON-shape of the providerOptions object on the most
   * recent streamText call. Captured immediately before streamText and
   * consumed by recordUsage; cleared after. Cost-leak forensics surfaces
   * this so we can answer "did this billed call carry store=true?" etc.
   */
  private _lastProviderOptionsShape: string | null = null;
  /** External abort context from src/index.ts SIGINT handler (TUI-04). */
  private externalAbortContext: import("./abort.js").AbortContext | null = null;
  /** Pending calls log for Pitfall 9 staged-write tracking. */
  private pendingCalls: import("./pending-calls.js").PendingCallsLog | null = null;
  /** Active permission mode — controls which tool calls auto-approve vs require user confirmation. */
  private permissionMode: PermissionMode = "safe";
  /** Flow run init promise — awaited before first message turn. */
  private _flowReady: Promise<void> | null = null;
  /** Active .muonroi-flow/ run ID for this session. */
  private _activeRunId: string | null = null;
  /** Resume digest loaded from active flow run state.md. */
  private _resumeDigest: string | null = null;
  /**
   * Phase 12.1-02: All council state (synthesis/continuation flags, resolver
   * + buffer maps, stats) lives inside CouncilManager. Agent holds one ref.
   */
  private councilManager: CouncilManager;
  /** Whether compaction already ran during the current turn (prevents double-compact). */
  private _compactedThisTurn = false;
  /** Guard: OAuth provider init runs at most once per Agent instance. */
  private _oauthInitDone = false;
  /** P0 native observation: warning IDs surfaced earlier in this session — sent as intent_context.priorWarningIdsInSession. */
  private _priorWarningIdsInSession = new Set<string>();
  /** EE session guidance: structured warnings accumulated across turns — injected into model context at turn start. Keyed by principle_uuid to deduplicate. */
  private _sessionEEGuidance = new Map<
    string,
    { toolName: string; message: string; why: string; confidence: number }
  >();
  /** P0 native observation: rolling buffer of assistant reasoning text in current turn — last 200 chars sent as intent_context.assistantReasoningExcerpt. */
  private _turnAssistantReasoning = "";
  /** P0 native observation: cached user goal for current turn — first 200 chars of userMessage. */
  private _turnUserGoalExcerpt = "";
  /** Compaction statistics tracking count and total tokens saved. */
  private _compactionStats: { count: number; totalSaved: number } = { count: 0, totalSaved: 0 };
  /**
   * Pinned message sequences. A pinned user message is preserved verbatim across
   * compaction — it is re-injected as a system note immediately after the
   * compaction summary, so the model still sees the original wording.
   * V1 only supports user messages (avoids splitting tool-call/result pairs).
   */
  private _pinnedSeqs = new Set<number>();
  /** One-shot cwd note injected at the start of the next processMessage turn after setCwd(). Cleared after injection. */
  private _pendingCwdNote: string | null = null;

  // Phase C3: cross-turn tool-output dedup. One instance per session; bumped
  // on each user turn. Lazily initialized so disabled-via-env path stays cheap.
  private _crossTurnDedup: CrossTurnDedup | null = isCrossTurnDedupEnabled() ? new CrossTurnDedup() : null;
  // Phase C4 — input-keyed read-path budget. Complements C3 (output hash) by
  // catching re-reads of files the agent edited between rounds. Disabled
  // when MUONROI_MAX_READS_PER_PATH=0.
  private _readBudget: ReadPathBudget | null = (() => {
    const cap = getReadPathBudgetCap();
    return cap > 0 ? new ReadPathBudget(cap) : null;
  })();

  constructor(
    apiKey: string | undefined,
    baseURL?: string,
    model?: string,
    maxToolRounds?: number,
    options: AgentOptions = {},
  ) {
    this.baseURL = baseURL || null;
    this.bash = new BashTool(process.cwd(), {
      sandboxMode: options.sandboxMode ?? "off",
      sandboxSettings: options.sandboxSettings,
      shellSettings: options.shellSettings ?? getCurrentShellSettings(),
    });
    this.delegations = new DelegationManager(() => this.bash.getCwd());
    // Phase 12.1-02: council state + helpers live in CouncilManager. DI via
    // getter callbacks so the manager reads live Agent state without holding
    // a circular reference to the Agent instance.
    this.councilManager = new CouncilManager({
      getModelId: () => this.modelId,
      getSessionId: () => this.session?.id ?? null,
      hasSessionStore: () => this.sessionStore !== null,
      getMessages: () => this.messages,
      getBash: () => this.bash,
      getMode: () => this.mode,
    });

    const initialMode: AgentMode = "agent";
    this.modelId = normalizeModelId(model || getCurrentModel(initialMode));
    this.providerId = detectProviderForModel(this.modelId);
    setProviderHint(this.providerId);
    if (apiKey) {
      this.setApiKey(apiKey, baseURL);
    }
    this.schedules = new ScheduleManager(
      () => this.bash.getCwd(),
      () => this.modelId,
    );
    this.maxToolRounds = maxToolRounds || MAX_TOOL_ROUNDS;
    const envMax = Number(process.env.MUONROI_MAX_TOKENS);
    this.maxTokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 16_384;
    this.batchApi = options.batchApi ?? false;
    // TUI-04: wire external abort context and pending calls log if provided.
    this.externalAbortContext = options.abortContext ?? null;
    this.pendingCalls = options.pendingCalls ?? null;
    this.permissionMode = options.permissionMode ?? "safe";
    ensureDefaultMcpServers();

    if (options.persistSession !== false) {
      this.sessionStore = new SessionStore(this.bash.getCwd());
      this.workspace = this.sessionStore.getWorkspace();
      this.session = this.sessionStore.openSession(options.session, this.modelId, this.mode, this.bash.getCwd());
      this.mode = this.session.mode;
      const transcript = loadTranscriptState(this.session.id);
      this.messages = transcript.messages;
      this.messageSeqs = transcript.seqs;
      this.sessionStore.setModel(this.session.id, this.modelId);

      // Flow run setup — fire-and-forget, awaited before first message turn.
      this._flowReady = this._initFlow();
    }
  }

  /**
   * Initialize .muonroi-flow/ run for this session.
   * Fail-open: any error sets _activeRunId = null silently.
   */
  private async _initFlow(): Promise<void> {
    await bootstrapEEClient().catch(() => {});
    try {
      const flowDir = await ensureFlowDir(this.bash.getCwd());
      const existing = await getActiveRunId(flowDir);
      if (existing) {
        this._activeRunId = existing;
        return;
      }
      const run = await createRun(flowDir);
      await setActiveRunId(flowDir, run.id);
      this._activeRunId = run.id;
    } catch {
      this._activeRunId = null;
    }

    // Load resume digest for PIL context injection (fail-open).
    try {
      this._resumeDigest = await loadFlowResumeDigest(this.bash.getCwd());
    } catch {
      this._resumeDigest = null;
    }
  }

  getModel(): string {
    return this.modelId;
  }

  getActiveRunId(): string | null {
    return this._activeRunId;
  }

  setModel(model: string): void {
    this.modelId = normalizeModelId(model);
    const newProviderId = detectProviderForModel(this.modelId);
    if (newProviderId !== this.providerId && this.apiKey) {
      this.providerId = newProviderId;
      setProviderHint(this.providerId);
      const effectiveBaseURL =
        this.providerId !== "anthropic" && this.baseURL === apiBaseFor("anthropic")
          ? undefined
          : (this.baseURL ?? undefined);
      this.provider = createProvider(this.providerId, this.apiKey, effectiveBaseURL);
    }
    if (this.sessionStore && this.session) {
      this.sessionStore.setModel(this.session.id, this.modelId);
      this.session = this.sessionStore.getRequiredSession(this.session.id);
    }
  }

  getMode(): AgentMode {
    return this.mode;
  }

  getSandboxMode(): SandboxMode {
    return this.bash.getSandboxMode();
  }

  setSandboxMode(mode: SandboxMode): void {
    this.bash.setSandboxMode(mode);
  }

  getSandboxSettings(): SandboxSettings {
    return this.bash.getSandboxSettings();
  }

  setSandboxSettings(settings: SandboxSettings): void {
    this.bash.setSandboxSettings(settings);
  }

  setMode(mode: AgentMode): void {
    if (mode !== this.mode) {
      this.mode = mode;
      const modeModel = getModeSpecificModel(mode);
      if (modeModel) {
        this.modelId = normalizeModelId(modeModel);
      }
      if (this.sessionStore && this.session) {
        this.sessionStore.setMode(this.session.id, mode);
        this.sessionStore.setModel(this.session.id, this.modelId);
        this.session = this.sessionStore.getRequiredSession(this.session.id);
      }
    }
  }

  setPlanContext(ctx: string | null): void {
    this.planContext = ctx;
  }

  setSendTelegramFile(fn: ((filePath: string) => Promise<ToolResult>) | null): void {
    this.sendTelegramFile = fn;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  setApiKey(apiKey: string, baseURL?: string): void {
    this.apiKey = apiKey;
    this.baseURL = baseURL || null;
    // Only pass baseURL to provider factory if it's an explicit override,
    // not the default Anthropic URL (which would break non-Anthropic providers).
    const effectiveBaseURL =
      this.providerId !== "anthropic" && baseURL === apiBaseFor("anthropic") ? undefined : baseURL;
    this.provider = createProvider(this.providerId, apiKey, effectiveBaseURL);
  }

  setProviderAndKey(providerId: ProviderId, apiKey: string, baseURL?: string): void {
    this.providerId = providerId;
    setProviderHint(this.providerId);
    this.setApiKey(apiKey, baseURL);
  }

  getProviderId(): ProviderId {
    return this.providerId;
  }

  getCwd(): string {
    return this.bash.getCwd();
  }

  setCwd(dir: string): void {
    this.bash.setCwd(dir);
    this._pendingCwdNote = `(system: working directory has been changed to ${dir} — subsequent shell commands run from there; do NOT cd to that path again)`;
  }

  getMessages(): ModelMessage[] {
    return this.messages;
  }

  async listSchedules(): Promise<StoredSchedule[]> {
    return this.schedules.list();
  }

  async removeSchedule(id: string): Promise<string> {
    const removed = await this.schedules.remove(id);
    return removed ? `Removed schedule "${removed.name}".` : `Schedule "${id}" not found.`;
  }

  async getScheduleDaemonStatus(): Promise<ScheduleDaemonStatus> {
    return this.schedules.getDaemonStatus();
  }

  getContextStats(
    contextWindow: number,
    inFlightText = "",
  ): {
    contextWindow: number;
    usedTokens: number;
    remainingTokens: number;
    ratioUsed: number;
    ratioRemaining: number;
  } {
    const system = buildSystemPrompt(
      this.bash.getCwd(),
      this.mode,
      this.bash.getSandboxMode(),
      this.planContext,
      undefined,
      this.bash.getSandboxSettings(),
      this.providerId,
    );
    const usedTokens = Math.min(contextWindow, estimateConversationTokens(system, this.messages, inFlightText));
    const remainingTokens = Math.max(0, contextWindow - usedTokens);

    return {
      contextWindow,
      usedTokens,
      remainingTokens,
      ratioUsed: usedTokens / contextWindow,
      ratioRemaining: remainingTokens / contextWindow,
    };
  }

  async generateTitle(userMessage: string): Promise<string> {
    const provider = this.provider;
    if (!provider) {
      return "New session";
    }

    const generated = await genTitle(provider, userMessage);
    this.recordUsage(generated.usage, "title", generated.modelId);
    if (this.sessionStore && this.session && !this.session.title && generated.title) {
      this.sessionStore.setTitle(this.session.id, generated.title);
      this.session = this.sessionStore.getRequiredSession(this.session.id);
    }
    return generated.title;
  }

  async askSideQuestion(question: string, signal?: AbortSignal): Promise<SideQuestionResult> {
    if (!this.provider) {
      return { response: "No API key configured." };
    }

    const contextParts: string[] = [];
    let charBudget = 2000;
    for (let i = this.messages.length - 1; i >= 0 && charBudget > 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p: { type: string }) => p.type === "text")
                .map((p: { type: string; text?: string }) => p.text ?? "")
                .join("")
            : "";
      if (!text) continue;
      const snippet = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      contextParts.unshift(`[${msg.role}]: ${snippet}`);
      charBudget -= snippet.length;
    }
    const conversationContext = contextParts.join("\n\n");

    const result = await runSideQuestion(question, this.provider, this.modelId, conversationContext, signal);
    this.recordUsage(result.usage, "other");
    return result;
  }

  abort(): void {
    this.abortController?.abort();
    this.emitSubagentStatus(null);
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled([
      this.bash.cleanup(),
      shutdownWorkspaceLspManager(this.bash.getCwd()),
      extractSession(this.messages, this.bash.getCwd(), "cli-exit", this.getSessionId()),
    ]);
  }

  respondToToolApproval(approvalId: string, approved: boolean): void {
    const toolApprovalResponse: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-approval-response" as const,
          approvalId,
          approved,
        },
      ],
    };
    this.messages.push(toolApprovalResponse);
    this.messageSeqs.push(null);
  }

  async clearHistory(): Promise<void> {
    // D-09: Extract messages accumulated since last clear BEFORE reset
    await extractSession(this.messages, this.bash.getCwd(), "cli-clear", this.getSessionId()).catch(() => {}); // D-05: redundant safety — extractSession already swallows
    this.startNewSession();
  }

  startNewSession(): SessionSnapshot | null {
    if (this.sessionStartHookFired) {
      const endInput: SessionEndHookInput = {
        hook_event_name: "SessionEnd",
        session_id: this.session?.id,
        cwd: this.bash.getCwd(),
      };
      this.fireHook(endInput).catch(() => {});
      this.sessionStartHookFired = false;
    }

    // Reset token counters, cost, and compaction state for the new session
    statusBarStore.setState({
      in_tokens: 0,
      out_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      session_usd: 0,
      ctx_tokens: 0,
      compaction_summary: undefined,
    });

    this._compactionStats = { count: 0, totalSaved: 0 };
    this._pinnedSeqs.clear();

    if (!this.sessionStore) {
      this.messages = [];
      this.messageSeqs = [];
      return null;
    }

    this.sessionStore = new SessionStore(this.bash.getCwd());
    this.workspace = this.sessionStore.getWorkspace();
    this.session = this.sessionStore.createSession(this.modelId, this.mode, this.bash.getCwd());
    this.messages = [];
    this.messageSeqs = [];
    return this.getSessionSnapshot();
  }

  getSessionInfo(): SessionInfo | null {
    return this.session;
  }

  getSessionId(): string | null {
    return this.session?.id || null;
  }

  getSessionTitle(): string | null {
    return this.session?.title || null;
  }

  getCompactionStats(): { count: number; totalSaved: number } {
    return { ...this._compactionStats };
  }

  /**
   * Pin a user message by its sequence number. Pinned messages survive
   * compaction verbatim — re-injected as a system note after the summary.
   * Returns true if the message was found, is a user message, and got pinned.
   */
  pinMessageBySeq(seq: number): boolean {
    const idx = this.messageSeqs.findIndex((s) => s === seq);
    if (idx < 0) return false;
    if (this.messages[idx]?.role !== "user") return false;
    this._pinnedSeqs.add(seq);
    return true;
  }

  /** Pin the most recent user message in the live conversation. Returns its seq, or null. */
  pinLastUserMessage(): number | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]?.role !== "user") continue;
      const seq = this.messageSeqs[i];
      if (typeof seq === "number") {
        this._pinnedSeqs.add(seq);
        return seq;
      }
    }
    return null;
  }

  unpinMessageBySeq(seq: number): boolean {
    return this._pinnedSeqs.delete(seq);
  }

  getPinnedSeqs(): number[] {
    return [...this._pinnedSeqs].sort((a, b) => a - b);
  }

  getChatEntries(): ChatEntry[] {
    if (!this.session) return [];
    return buildChatEntries(this.session.id);
  }

  getSessionSnapshot(): SessionSnapshot | null {
    if (!this.session || !this.workspace) return null;
    return {
      workspace: this.workspace,
      session: this.session,
      messages: loadTranscript(this.session.id),
      entries: buildChatEntries(this.session.id),
      totalTokens: getSessionTotalTokens(this.session.id),
    };
  }

  onSubagentStatus(listener: (status: SubagentStatus | null) => void): () => void {
    this.subagentStatusListeners.add(listener);
    return () => {
      this.subagentStatusListeners.delete(listener);
    };
  }

  private emitSubagentStatus(status: SubagentStatus | null): void {
    for (const listener of this.subagentStatusListeners) {
      listener(status);
    }
  }

  private discardAbortedTurn(userMessage: ModelMessage): void {
    const idx = this.messages.lastIndexOf(userMessage);
    if (idx >= 0) {
      // Keep the user message but add a stub assistant response so the
      // conversation remains valid for follow-up messages after ESC.
      const alreadyHasResponse = idx < this.messages.length - 1 && this.messages[idx + 1]?.role === "assistant";
      if (!alreadyHasResponse) {
        this.messages.splice(idx + 1, 0, { role: "assistant", content: "[Interrupted]" });
        this.messageSeqs.splice(idx + 1, 0, null);
      }
    }
  }

  private recordUsage(
    usage?: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
    source: UsageSource = "message",
    model = this.modelId,
  ): void {
    if (!usage) return;
    if (this.session) {
      const pilActive = source === "message" ? this._pilActive : false;
      const enrichmentDelta = source === "message" ? this._pilEnrichmentDelta : 0;
      // Attribute usage to the most recent persisted message — this lets
      // per-prompt cost analysis work (was null hardcoded → impossible).
      const lastSeq = lastPersistedSeq(this.messageSeqs);
      // Phase O1 — providerOptions shape (types only, no values) attached
      // to every usage event so post-mortem can answer "what provider
      // options did this billed call carry?". Cleared below for "message"
      // sources so non-message calls don't reuse stale data.
      const providerOptionsShape = this._lastProviderOptionsShape;
      recordUsageEvent(
        this.session.id,
        source,
        model,
        usage,
        lastSeq,
        pilActive,
        enrichmentDelta,
        providerOptionsShape,
      );
      if (source === "message") {
        this._pilActive = false;
        this._pilEnrichmentDelta = 0;
        this._lastProviderOptionsShape = null;
      }
    }
    // Phase D — surfaced for harness E2E verification. Mirror the recorded usage
    // event onto the agent-mode sidechannel so spec processes can assert on
    // cacheReadTokens / cacheCreationTokens normalization without poking at the
    // child's sqlite. Best-effort, only fires when agent-mode runtime is set.
    try {
      const rt = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
        | { emitEvent?: (e: unknown) => void }
        | undefined;
      if (rt?.emitEvent) {
        const lastSeqForEvent = this.session ? lastPersistedSeq(this.messageSeqs) : null;
        rt.emitEvent({
          t: "event",
          kind: "usage",
          source,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          messageSeq: lastSeqForEvent,
        });
      }
    } catch {
      // best-effort: do not let sidechannel failures interrupt usage recording
    }
    // Update status bar token counters + provider/model + cache metrics + cost
    const prev = statusBarStore.getState();
    const info = getModelInfo(model);
    const totalInput = usage.inputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheCreate = usage.cacheCreationTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const priceIn = info?.inputPrice ?? 0;
    const priceCached = info?.cachedInputPrice ?? priceIn * 0.1;
    const priceOut = info?.outputPrice ?? 0;
    // API inputTokens includes cacheRead — subtract to get non-cached portion
    const nonCachedInput = Math.max(0, totalInput - cacheRead - cacheCreate);
    const turnCostMicros =
      nonCachedInput * priceIn + cacheRead * priceCached + cacheCreate * priceIn + output * priceOut;
    statusBarStore.setState({
      in_tokens: prev.in_tokens + totalInput,
      out_tokens: prev.out_tokens + output,
      cache_read_tokens: (prev.cache_read_tokens ?? 0) + cacheRead,
      cache_creation_tokens: (prev.cache_creation_tokens ?? 0) + cacheCreate,
      session_usd: prev.session_usd + turnCostMicros / 1_000_000,
      provider: this.providerId,
      model,
    });

    // Append to cost-log JSONL so `usage report --by callsite` can surface
    // where orchestrator/task/title traffic is actually spending.
    // Best-effort: failures inside appendCostLog are swallowed (see cost-log.ts).
    const breakdown = source === "message" ? (this._lastPromptBreakdown ?? undefined) : undefined;
    appendCostLog({
      ts: Date.now(),
      provider: this.providerId,
      model,
      estimatedUsd: turnCostMicros / 1_000_000,
      callsite: `orchestrator.${source}`,
      phase: source,
      actualInputTokens: totalInput,
      actualOutputTokens: output,
      cachedInputTokens: cacheRead,
      systemChars: breakdown?.systemChars,
      promptChars: breakdown?.messagesChars,
      breakdown,
    }).catch(() => undefined);
    // Don't clear breakdown — onStepFinish fires recordUsage per step within
    // the same streamText call, and they all share the same prompt structure.
    // It is overwritten on the next streamText setup, which is the right scope.
  }

  async consumeBackgroundNotifications(): Promise<string[]> {
    try {
      const notifications = await this.delegations.consumeNotifications();
      for (const notification of notifications) {
        this.messages.push({ role: "system", content: notification.message });
        let seq: number | null = null;
        if (this.session) {
          seq = appendSystemMessage(this.session.id, notification.message);
        }
        this.messageSeqs.push(seq);

        const notifInput: NotificationHookInput = {
          hook_event_name: "Notification",
          message: notification.message,
          session_id: this.session?.id,
          cwd: this.bash.getCwd(),
        };
        this.fireHook(notifInput).catch(() => {});
      }
      return notifications.map((notification) => notification.message);
    } catch {
      return [];
    }
  }

  private getBatchClientOptions(signal?: AbortSignal): BatchClientOptions {
    if (!this.apiKey) {
      throw new Error("API key required. Add an API key to continue.");
    }

    return {
      apiKey: this.apiKey,
      baseURL: this.baseURL ?? undefined,
      signal,
    };
  }

  private async executeBatchToolCall(
    tools: ToolSet,
    toolCall: ToolCall,
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{ input: unknown; result: ToolResult }> {
    const tool = tools[toolCall.function.name];
    if (!tool || tool.type === "provider" || typeof tool.execute !== "function") {
      return {
        input: parseToolArgumentsOrRaw(toolCall.function.arguments),
        result: {
          success: false,
          output: `Tool "${toolCall.function.name}" is unavailable in batch mode.`,
        },
      };
    }

    let parsedInput: unknown;
    try {
      parsedInput = toolCall.function.arguments.trim() ? JSON.parse(toolCall.function.arguments) : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        input: toolCall.function.arguments,
        result: {
          success: false,
          output: `Tool "${toolCall.function.name}" received invalid JSON arguments: ${message}`,
        },
      };
    }

    try {
      const output = await tool.execute(parsedInput as never, {
        toolCallId: toolCall.id,
        messages,
        abortSignal: signal,
      });
      return {
        input: parsedInput,
        result: toToolResult(output),
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        input: parsedInput,
        result: {
          success: false,
          output: `Tool "${toolCall.function.name}" failed: ${message}`,
        },
      };
    }
  }

  private async runTaskRequestBatch(args: {
    request: TaskRequest;
    childMessages: ModelMessage[];
    childSystem: string;
    childRuntime: ReturnType<typeof resolveModelRuntime>;
    childTools: ToolSet;
    maxSteps: number;
    initialDetail: string;
    onActivity?: (detail: string) => void;
    signal?: AbortSignal;
  }): Promise<ToolResult> {
    const {
      request,
      childMessages,
      childSystem,
      childRuntime,
      childTools,
      maxSteps,
      initialDetail,
      onActivity,
      signal,
    } = args;

    const childCaps = getProviderCapabilities(childRuntime.modelInfo?.provider ?? "anthropic");
    if (childCaps.usesResponsesAPI(childRuntime.modelInfo)) {
      throw new Error("Batch mode currently supports chat-completions models only.");
    }

    const batchTools = !childCaps.supportsClientTools(childRuntime.modelInfo)
      ? []
      : await toolSetToBatchTools(childTools);
    const batch = await createBatch({
      ...this.getBatchClientOptions(signal),
      name: buildBatchName(`task-${request.agent}`, request.description),
    });

    const turnMessages: ModelMessage[] = [];
    const totalUsage: ProcessMessageUsage = {};
    let assistantText = "";
    let lastActivity = initialDetail;

    for (let round = 0; round < maxSteps; round++) {
      const batchRequestId = `task-${Date.now()}-${round + 1}`;
      await addBatchRequests({
        ...this.getBatchClientOptions(signal),
        batchId: batch.batch_id,
        batchRequests: [
          {
            batch_request_id: batchRequestId,
            batch_request: {
              chat_get_completion: buildBatchChatCompletionRequest({
                modelId: childRuntime.modelId,
                system: childSystem,
                messages: [...childMessages, ...turnMessages],
                temperature: request.agent === "explore" ? 0.2 : 0.5,
                maxOutputTokens: !childCaps.acceptsParam("maxOutputTokens", childRuntime.modelInfo)
                  ? undefined
                  : Math.min(this.maxTokens, 8_192),
                reasoningEffort: childRuntime.providerOptions?.xai.reasoningEffort,
                tools: batchTools,
              }),
            },
          },
        ],
      });

      const result = await pollBatchRequestResult({
        ...this.getBatchClientOptions(signal),
        batchId: batch.batch_id,
        batchRequestId,
      });
      const response = getBatchChatCompletion(result);
      accumulateUsage(totalUsage, getBatchUsage(response));

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("Batch response did not contain any choices.");
      }
      const content = choice?.message.content ?? "";
      if (content) {
        assistantText += content;
      }

      const requestMessages = [...childMessages, ...turnMessages];
      const toolCalls = (choice?.message.tool_calls ?? []).map(toLocalToolCall);
      const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
      if (assistantMessage) {
        turnMessages.push(assistantMessage);
      }

      if (toolCalls.length === 0) {
        if (hasUsage(totalUsage)) {
          this.recordUsage(totalUsage, "task", childRuntime.modelId);
        }
        const output = assistantText.trim() || `Task completed. Last action: ${lastActivity}`;
        return {
          success: true,
          output,
          task: {
            agent: request.agent,
            description: request.description,
            summary: firstLine(output),
            activity: lastActivity,
          },
        };
      }

      const toolParts: ExecutedBatchTool[] = [];
      for (const toolCall of toolCalls) {
        const nextActivity = formatSubagentActivity(
          toolCall.function.name,
          parseToolArgumentsOrRaw(toolCall.function.arguments),
        );
        lastActivity = nextActivity;
        onActivity?.(nextActivity);

        const executed = await this.executeBatchToolCall(childTools, toolCall, requestMessages, signal);
        toolParts.push({
          toolCall,
          input: executed.input,
          toolResult: executed.result,
        });
      }

      const toolMessage = buildToolBatchMessage(toolParts);
      if (toolMessage) {
        turnMessages.push(toolMessage);
      }
    }

    if (hasUsage(totalUsage)) {
      this.recordUsage(totalUsage, "task", childRuntime.modelId);
    }
    const output = assistantText.trim() || `Task stopped after ${maxSteps} batch rounds. Last action: ${lastActivity}`;
    return {
      success: false,
      output,
      task: {
        agent: request.agent,
        description: request.description,
        summary: output,
        activity: lastActivity,
      },
    };
  }

  /**
   * Run a sub-agent task by spawning a child `streamText` session.
   *
   * Phase 12.3 — body extracted to `StreamRunner` (`./stream-runner.ts`).
   * This method now builds the DI dep set and delegates to
   * `StreamRunner.run()`. Public signature is unchanged so all callers
   * (`runTask`, `tools/registry`, batch path, council path) work as before.
   */
  async runTaskRequest(
    request: TaskRequest,
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const provider = this.requireProvider();
    const deps: StreamRunnerDeps = {
      getProvider: () => provider,
      resolveModelForTask: (task) => this._resolveModelForTask(task),
      getModelId: () => this.modelId,
      getProviderId: () => this.providerId,
      getBash: () => this.bash,
      getMaxToolRounds: () => this.maxToolRounds,
      getMaxTokens: () => this.maxTokens,
      isBatchApiEnabled: () => this.batchApi,
      getCrossTurnDedup: () => this._crossTurnDedup,
      getReadBudget: () => this._readBudget,
      recordUsage: (usage, source, model) => this.recordUsage(usage, source, model),
      setCurrentCallId: (id) => {
        this._currentCallId = id;
      },
      setLastProviderOptionsShape: (shape) => {
        this._lastProviderOptionsShape = shape;
      },
      runTaskRequestBatch: (args) => this.runTaskRequestBatch(args),
    };
    const runner = new StreamRunner(deps);
    return runner.run(request, onActivity, abortSignal);
  }

  private async runTask(request: TaskRequest, abortSignal?: AbortSignal): Promise<ToolResult> {
    const startInput: SubagentStartHookInput = {
      hook_event_name: "SubagentStart",
      agent_type: request.agent,
      description: request.description,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(startInput, abortSignal).catch(() => {});

    let result: ToolResult;
    try {
      result = await withStreamRetry(
        () =>
          this.runTaskRequest(
            request,
            (detail) => {
              if (abortSignal?.aborted) return;
              this.emitSubagentStatus({
                agent: request.agent,
                description: request.description,
                detail,
              });
            },
            abortSignal,
          ),
        {
          signal: abortSignal,
          onRetry: (info) => {
            // Emit harness telemetry
            try {
              const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
                | { emitEvent: (e: unknown) => void }
                | undefined;
              _ar?.emitEvent({
                t: "event",
                kind: "stream-retry",
                ...info,
              });
            } catch {
              /* best-effort */
            }
            try {
              if (this.session) {
                logInteraction(this.session.id, "stream_retry", {
                  data: {
                    attempt: info.attempt,
                    maxAttempts: info.maxAttempts,
                    errorName: info.errorName,
                    errorMessage: info.errorMessage.slice(0, 200),
                    nextDelayMs: info.nextDelayMs,
                  },
                });
              }
            } catch {
              /* fail-open */
            }
          },
        },
      );
    } finally {
      this.emitSubagentStatus(null);
    }

    const stopInput: SubagentStopHookInput = {
      hook_event_name: "SubagentStop",
      agent_type: request.agent,
      description: request.description,
      success: result.success,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(stopInput, abortSignal).catch(() => {});

    return result;
  }

  private async runDelegation(request: TaskRequest, abortSignal?: AbortSignal): Promise<ToolResult> {
    const taskCreatedInput: TaskCreatedHookInput = {
      hook_event_name: "TaskCreated",
      agent_type: request.agent,
      description: request.description,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(taskCreatedInput, abortSignal).catch(() => {});

    let result: ToolResult;
    try {
      if (abortSignal?.aborted) {
        return { success: false, output: "[Cancelled]" };
      }

      result = await this.delegations.start(request, {
        model: this.modelId,
        sandboxMode: this.bash.getSandboxMode(),
        sandboxSettings: this.bash.getSandboxSettings(),
        maxToolRounds: this.maxToolRounds,
        maxTokens: this.maxTokens,
        batchApi: this.batchApi,
      });
    } catch (err: unknown) {
      if (abortSignal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        success: false,
        output: `Delegation failed: ${msg}`,
      };
    }

    const taskCompletedInput: TaskCompletedHookInput = {
      hook_event_name: "TaskCompleted",
      agent_type: request.agent,
      description: request.description,
      success: result.success,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(taskCompletedInput, abortSignal).catch(() => {});

    return result;
  }

  private async readDelegation(id: string): Promise<ToolResult> {
    try {
      return {
        success: true,
        output: await this.delegations.read(id),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to read delegation: ${msg}`,
      };
    }
  }

  private async listDelegations(): Promise<ToolResult> {
    try {
      const delegations = await this.delegations.list();
      if (delegations.length === 0) {
        return {
          success: true,
          output: "No delegations found for this project.",
        };
      }

      const lines = delegations.map((delegation) => {
        const title = delegation.description || delegation.id;
        return `- \`${delegation.id}\` [${delegation.status}] ${title}\n  ${delegation.summary}`;
      });

      return {
        success: true,
        output: `## Delegations\n\n${lines.join("\n")}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to list delegations: ${msg}`,
      };
    }
  }

  private getCompactionSettings(contextWindow?: number): CompactionSettings {
    let keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS;

    // For models with very large context windows, keep more recent tokens
    if (contextWindow && contextWindow > 200_000) {
      keepRecentTokens = Math.min(100_000, Math.max(20_000, Math.floor(contextWindow * 0.1)));
    }

    // Compact more aggressively for long sessions to prevent runaway token growth
    if (this._compactionStats.count >= 2) {
      keepRecentTokens = Math.floor(keepRecentTokens * 0.75);
    }

    return {
      reserveTokens: Math.max(this.maxTokens, DEFAULT_RESERVE_TOKENS),
      keepRecentTokens,
    };
  }

  private _resolveCompactModel(): string {
    return this._resolveModelForTask("compact");
  }

  private _resolveModelForTask(task: "compact" | "explore" | "general" | "title"): string {
    const tierPrefs: Record<string, Array<"fast" | "balanced" | "premium">> = {
      compact: ["fast", "balanced"],
      title: ["fast", "balanced"],
      explore: ["balanced", "fast"],
      general: ["premium", "balanced"],
    };
    for (const tier of tierPrefs[task] ?? ["balanced"]) {
      const m = getModelByTier(tier, this.providerId);
      if (m?.provider === this.providerId) return m.id;
    }
    return this.modelId;
  }

  private async compactForContext(
    provider: LegacyProvider,
    system: string,
    contextWindow: number,
    signal: AbortSignal,
    settings = this.getCompactionSettings(contextWindow),
    force = false,
  ): Promise<boolean> {
    if (!this.session) return false;

    const preparation = prepareCompaction(this.messages, system, settings);
    if (!preparation) return false;
    if (!force && !shouldCompactContext(preparation.tokensBefore, contextWindow, settings)) {
      return false;
    }

    const trigger = force ? "manual" : "auto";

    // Fire-and-forget: notify EE of stale suggestions before compaction
    const { surfacedIds, timestamp } = getLastSurfacedState();
    if (surfacedIds.length > 0) {
      getDefaultEEClient()
        .promptStale({
          state: { surfacedIds, timestamp },
          nextPromptMeta: { trigger: "auto-compact", cwd: this.bash.getCwd(), tenantId: getTenantId() },
        })
        .catch(() => {});
    }

    const preCompactInput: PreCompactHookInput = {
      hook_event_name: "PreCompact",
      trigger,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(preCompactInput, signal).catch(() => {});

    const keptSeqs = this.messageSeqs.slice(preparation.firstKeptIndex);
    const firstKeptSeq = keptSeqs.find((seq): seq is number => seq !== null) ?? getNextMessageSequence(this.session.id);
    const compactModelId = this._resolveCompactModel();
    const compactStartedAt = Date.now();
    const { summary, usage: compactUsage } = await generateCompactionSummary(
      provider,
      compactModelId,
      preparation,
      undefined,
      signal,
    );

    // Record compaction call in cost-log — bypasses recordUsage because
    // compaction returns usage separately and isn't routed through the
    // status-bar / usage event pipeline (intentional: it's overhead, not user spend).
    const compactProvider = detectProviderForModel(compactModelId);
    appendCostLog({
      ts: compactStartedAt,
      provider: compactProvider,
      model: compactModelId,
      estimatedUsd: projectCostUSD(
        compactProvider,
        compactModelId,
        compactUsage.promptTokens,
        compactUsage.completionTokens,
      ),
      callsite: "orchestrator.compaction",
      phase: "compaction",
      iteration: this._compactionStats.count + 1,
      actualInputTokens: compactUsage.promptTokens,
      actualOutputTokens: compactUsage.completionTokens,
      durationMs: Date.now() - compactStartedAt,
    }).catch(() => undefined);

    appendCompaction(this.session.id, firstKeptSeq, summary, preparation.tokensBefore);

    // Re-inject pinned user messages that were about to be summarized away.
    // Pinned seqs that are still inside keptMessages don't need re-injection.
    const keptSeqSet = new Set(keptSeqs.filter((s): s is number => s !== null));
    const pinnedReinjections: ModelMessage[] = [];
    const pinnedReinjectionSeqs: Array<number | null> = [];
    for (const seq of [...this._pinnedSeqs].sort((a, b) => a - b)) {
      if (keptSeqSet.has(seq)) continue;
      const idx = this.messageSeqs.findIndex((s) => s === seq);
      if (idx < 0) {
        // Pinned seq no longer present (shouldn't happen, but stay defensive).
        this._pinnedSeqs.delete(seq);
        continue;
      }
      const original = this.messages[idx];
      if (!original || original.role !== "user") continue;
      const text = extractUserContent(original.content).trim();
      if (!text) continue;
      pinnedReinjections.push({
        role: "system",
        content: `[Pinned user message — kept verbatim across compaction]\n${text}`,
      });
      pinnedReinjectionSeqs.push(null);
    }

    this.messages = [createCompactionSummaryMessage(summary), ...pinnedReinjections, ...preparation.keptMessages];
    this.messageSeqs = [null, ...pinnedReinjectionSeqs, ...keptSeqs];

    // Track compaction stats — net of the tokens spent ON compaction itself.
    const tokensAfter = estimateConversationTokens(system, this.messages);
    const grossSaved = Math.max(0, preparation.tokensBefore - tokensAfter);
    const compactCost = compactUsage.promptTokens + compactUsage.completionTokens;
    const saved = Math.max(0, grossSaved - compactCost);
    const pct = preparation.tokensBefore > 0 ? ((saved / preparation.tokensBefore) * 100).toFixed(1) : "0.0";
    this._compactionStats.count++;
    this._compactionStats.totalSaved += saved;

    // Update status bar with current context size and compaction summary
    const fmtCompact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
    const modelSuffix = compactModelId !== this.modelId ? ` via ${compactModelId}` : "";
    const userMsgCount = this.messages.filter((m) => m.role === "user").length;
    const isLongSession = this._compactionStats.count >= 3 || userMsgCount >= 200;
    const sessionHint = isLongSession ? " ⚠ long session — consider /clear" : "";
    const compactLabel = `${this._compactionStats.count} cmp, ${fmtCompact(this._compactionStats.totalSaved)} saved${modelSuffix}${sessionHint}`;
    statusBarStore.setState({ ctx_tokens: tokensAfter, compaction_summary: compactLabel });

    const postCompactInput: PostCompactHookInput = {
      hook_event_name: "PostCompact",
      trigger,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(postCompactInput, signal).catch(() => {});

    // Interaction log: compaction
    try {
      if (this.session) {
        logInteraction(this.session.id, "compaction", {
          data: {
            count: this._compactionStats.count,
            tokensBefore: preparation.tokensBefore,
            tokensAfter,
            saved,
            grossSaved,
            compactCost,
            pct,
            isLongSession,
          },
        });
      }
    } catch {
      /* fail-open */
    }

    this._compactedThisTurn = true;
    return true;
  }

  private async postTurnCompact(
    provider: LegacyProvider,
    system: string,
    contextWindow: number,
    signal: AbortSignal,
  ): Promise<void> {
    const log = (taken: boolean, reason: string, extra?: Record<string, unknown>): void => {
      appendDecisionLog({
        ts: Date.now(),
        sessionId: this.session?.id ?? null,
        kind: "post-turn-compact",
        taken,
        reason,
        meta: { contextWindow, ...extra },
      }).catch(() => undefined);
    };

    if (this._compactedThisTurn) return log(false, "already-compacted-this-turn");
    if (!isAutoCompactAfterTurnEnabled()) return log(false, "feature-disabled");
    const tokens = estimateConversationTokens(system, this.messages);
    const thresholdPct = getAutoCompactThresholdPct();
    const minMeaningfulTokens = Math.max(POST_TURN_MIN_TOKENS, Math.floor(contextWindow * thresholdPct));
    if (tokens < minMeaningfulTokens) {
      return log(false, `under-threshold (${tokens} < ${minMeaningfulTokens})`, {
        tokens,
        thresholdPct,
        minMeaningfulTokens,
      });
    }
    log(true, `over-threshold (${tokens} >= ${minMeaningfulTokens})`, { tokens, thresholdPct, minMeaningfulTokens });
    await this.compactForContext(
      provider,
      system,
      contextWindow,
      signal,
      this.getCompactionSettings(contextWindow),
      true,
    ).catch((err) => console.warn("[compact] failed:", (err as Error)?.message));
  }

  // ========================================================================
  // Council system — delegated to CouncilManager (Phase 12.1-02)
  //
  // All council state + sub-call helpers (generate/research/prompt builders/
  // outcome parser/executor/candidate resolution) live in CouncilManager.
  // The thin facade below preserves the public API the UI + tests rely on
  // (respondToCouncilQuestion/Preflight + the internal _create*Responder
  // hooks used by orchestrator.agent.test.ts).
  // ========================================================================

  respondToCouncilQuestion(questionId: string, answer: string): void {
    this.councilManager.respondToQuestion(questionId, answer);
  }

  respondToCouncilPreflight(preflightId: string, approved: boolean): void {
    this.councilManager.respondToPreflight(preflightId, approved);
  }

  /** Internal hook used by agent.test.ts (private API — do not call externally). */
  private _createQuestionResponder(): (questionId: string) => Promise<string> {
    return this.councilManager.createQuestionResponder();
  }

  /** Internal hook used by agent.test.ts (private API — do not call externally). */
  private _createPreflightResponder(): (preflightId: string) => Promise<boolean> {
    return this.councilManager.createPreflightResponder();
  }

  // ========================================================================
  // Council v2 — Clarify → Confirm → Debate → Plan → Execute
  // ========================================================================

  async *runCouncilV2(
    topic: string,
    options?: {
      skipClarification?: boolean;
      observer?: ProcessMessageObserver;
      userModelMessage?: ModelMessage;
    },
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const { runCouncil } = await import("../council/index.js");
    const { createCouncilLLM } = await import("../council/llm.js");
    const councilStats = { calls: 0, startMs: Date.now(), phases: [] as Array<{ name: string; durationMs: number }> };
    const llm = createCouncilLLM(this.bash, this.mode, this.session?.id, councilStats);

    const processMessageFn = (message: string) => this.processMessage(message, options?.observer);

    const gen = runCouncil(
      topic,
      this.modelId,
      this.messages as Array<{ role: string; content: string | unknown }>,
      this.session?.id,
      llm,
      this.councilManager.createQuestionResponder(),
      this.councilManager.createPreflightResponder(),
      processMessageFn,
      {
        skipClarification: options?.skipClarification,
        userModelMessage: options?.userModelMessage,
        cwd: this.bash.getCwd(),
        councilStats, // NEW — share orchestrator's stats object with runCouncil (Phase 14 CQ-01)
      },
    );

    let result: IteratorResult<StreamChunk, string | null>;
    do {
      result = await gen.next();
      if (!result.done && result.value) {
        yield result.value;
      }
    } while (!result.done);

    const synthesis = result.value;
    this.councilManager.setLastSynthesis(synthesis);

    if (options?.userModelMessage && synthesis) {
      this.appendCompletedTurn(options.userModelMessage, [{ role: "assistant", content: synthesis }]);
    }
  }

  // ========================================================================
  // Product Ideal Loop (Phase 13) — mirror of runCouncilV2 wiring.
  // ========================================================================

  async *runProductLoopV1(
    payload: {
      subcommand: "start" | "status" | "resume" | "abort" | "ship";
      idea?: string;
      runId?: string;
      flags: {
        maxCost: number;
        maxSprints: number;
        doneThreshold: number;
        stack?: string;
        noCustomerDebate?: boolean;
        noPriorContext?: boolean;
        forceCouncil?: boolean;
      };
    },
    options?: {
      observer?: ProcessMessageObserver;
      userModelMessage?: ModelMessage;
    },
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const { runProductLoop } = await import("../product-loop/index.js");
    const { createCouncilLLM } = await import("../council/llm.js");
    const nodePath = await import("node:path");

    const productStats = {
      calls: 0,
      startMs: Date.now(),
      phases: [] as Array<{ name: string; durationMs: number }>,
    };
    const llm = createCouncilLLM(this.bash, this.mode, this.session?.id, productStats);
    const processMessageFn = (m: string) => this.processMessage(m, options?.observer);
    const flowDir = nodePath.join(this.bash.getCwd(), ".muonroi-flow");

    // P2.7: compute complexity from the idea using PIL Layer 1 heuristics (cheap,
    // no LLM calls). Only meaningful for "start"; other subcommands ignore it.
    let complexity: "low" | "medium" | "high" | undefined;
    let sufficiencyMissing: readonly import("../pil/layer1-intent.js").SufficiencyMissing[] | undefined;
    if (payload.subcommand === "start" && payload.idea) {
      const { scoreComplexity, scoreSufficiency } = await import("../pil/layer1-intent.js");
      const result = scoreComplexity({
        rawText: payload.idea,
        taskType: null,
        t0HitCount: 0,
        hasMaxSprintsOne: payload.flags.maxSprints === 1,
      });
      complexity = result.complexity;
      // Sufficiency gate — vague briefs ("todo app") force Council so the
      // discovery AskCard can fill in persona/MVP/architecture/verify before
      // any code is scaffolded.
      const suff = scoreSufficiency({ rawText: payload.idea });
      sufficiencyMissing = suff.sufficient ? undefined : suff.missing;
    }

    const gen = runProductLoop({
      subcommand: payload.subcommand,
      idea: payload.idea ?? "",
      runId: payload.runId,
      flowDir,
      sessionModelId: this.modelId,
      llm,
      flags: {
        maxCost: payload.flags.maxCost,
        maxSprints: payload.flags.maxSprints,
        doneThreshold: payload.flags.doneThreshold,
        stack: payload.flags.stack,
        forceCouncil: payload.flags.forceCouncil,
      },
      respondToQuestion: this.councilManager.createQuestionResponder(),
      respondToPreflight: this.councilManager.createPreflightResponder(),
      cwd: this.bash.getCwd(),
      processMessageFn,
      skipPriorContext: payload.flags.noPriorContext === true,
      complexity,
      sufficiencyMissing,
      // Chat session id — used as the FK key for interaction_logs telemetry.
      // The /ideal runId is NOT a sessions.id and would silently fail FK insert.
      sessionId: this.session?.id,
    } as Parameters<typeof runProductLoop>[0]);

    for await (const chunk of gen) {
      yield chunk;
    }
  }

  // ========================================================================
  // Legacy council — kept for backward compatibility, will be removed
  // ========================================================================

  async *runCouncilRound(
    topic: string,
    observer?: ProcessMessageObserver,
    rounds?: number,
    userModelMessage?: ModelMessage,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const maxRounds = rounds ?? getCouncilRounds();
    const ALL_ROLES: ModelRole[] = ["implement", "verify", "research"];
    this.councilManager.resetStats(Date.now());

    // Resolve council participants: same-provider by default, multi-provider only when configured
    const candidates: Array<{ role: ModelRole; model: string }> = [];
    const configuredRoleModels = getRoleModels();
    const hasExplicitMultiProvider = this.councilManager.hasMultiProviderConfig(configuredRoleModels);

    if (hasExplicitMultiProvider && isCouncilMultiProviderPreferred()) {
      // Multi-provider path: use explicitly configured role models across providers
      for (const role of ALL_ROLES) {
        const modelId = getRoleModel(role);
        if (!modelId) continue;
        const provider = detectProviderForModel(modelId);
        if (isProviderDisabled(provider as ProviderId)) continue;
        const canReach = await loadKeyForProvider(provider)
          .then(() => true)
          .catch(() => false);
        if (canReach) candidates.push({ role, model: modelId });
      }
      if (candidates.length >= 2) {
        const providers = new Set(candidates.map((c) => detectProviderForModel(c.model)));
        yield {
          type: "content",
          content: `\n[Multi-provider mode: ${candidates.length} roles across ${providers.size} provider(s)]\n`,
        };
      }
    }

    // Default: same-provider mode — pick diverse models from the session's provider
    if (candidates.length < 2) {
      const mainProviderId = detectProviderForModel(this.modelId);
      // Skip same-provider resolution if the session's provider is disabled
      if (!isProviderDisabled(mainProviderId as ProviderId)) {
        const sameCandidates = await this.councilManager.resolveSameProviderCandidates(mainProviderId, ALL_ROLES);
        if (sameCandidates.length >= 2) {
          candidates.length = 0;
          candidates.push(...sameCandidates);
          const uniqueModels = new Set(sameCandidates.map((c) => c.model));
          yield {
            type: "content",
            content: `\n[Same-provider mode: ${uniqueModels.size} ${mainProviderId} model(s) for ${sameCandidates.length} roles]\n`,
          };
        }
      }
    }

    // Final fallback: use main model for all roles
    if (candidates.length < 2) {
      const mainProviderId = detectProviderForModel(this.modelId);
      const mainDisabled = isProviderDisabled(mainProviderId as ProviderId);
      const mainCanReach =
        !mainDisabled &&
        (await loadKeyForProvider(mainProviderId)
          .then(() => true)
          .catch(() => false));
      if (mainCanReach) {
        candidates.length = 0;
        for (const role of ALL_ROLES) {
          candidates.push({ role, model: this.modelId });
        }
        yield {
          type: "content",
          content: `\n[Fallback: using \x1b[36m${this.modelId}\x1b[0m for all roles]\n`,
        };
      }
    }

    if (candidates.length < 2) {
      yield {
        type: "content",
        content: "\nNo reachable provider. Check API keys in user-settings.json or environment.\n",
      };
      yield { type: "done" };
      return;
    }

    // Build conversation context for all participants
    const conversationContext = this.councilManager.buildContext();

    // ── Phase 0: Research — gather facts from codebase before discussion ──
    const p0Start = Date.now();
    yield { type: "content", content: `\n## Phase 0 — Codebase Research\n` };

    // Find the research candidate (prefer configured research role, fallback to first available)
    const researchCandidate = candidates.find((c) => c.role === "research") ?? candidates[0];
    yield { type: "content", content: `\n### \x1b[35m[research]\x1b[0m ${researchCandidate.model}\n` };

    const researchFindings = await this.councilManager.research(researchCandidate.model, topic, conversationContext);
    yield { type: "content", content: `${researchFindings}\n` };
    yield { type: "content", content: `\n> Phase 0: ${((Date.now() - p0Start) / 1000).toFixed(1)}s\n` };

    // Inject research findings into conversation context for subsequent phases
    const enrichedContext = conversationContext
      ? `${conversationContext}\n\n---\n\n## Research Findings (Phase 0)\n${researchFindings}`
      : `## Research Findings (Phase 0)\n${researchFindings}`;

    // ── Phase 1: Parallel opening statements ──
    const p1Start = Date.now();
    yield { type: "content", content: "\n## Phase 1 — Opening Analysis\n" };

    const openingPromises = candidates.map(({ role, model }) => {
      const { system, prompt } = this.councilManager.buildDiscussPrompt("open", {
        speakerRole: role,
        partnerRole: candidates.find((c) => c.role !== role)?.role ?? "colleague",
        topic,
        conversationContext: enrichedContext,
      });
      return this.councilManager
        .generate(model, system, prompt)
        .then((text) => ({ role, model, position: text, error: null as string | null }))
        .catch((err: unknown) => ({
          role,
          model,
          position: "",
          error: err instanceof Error ? err.message : String(err),
        }));
    });

    const openings = await Promise.all(openingPromises);
    const active: Array<{ role: ModelRole; model: string; position: string }> = [];

    for (const o of openings) {
      const roleColor = COUNCIL_ROLE_COLORS[o.role] ?? "";
      yield { type: "content", content: `\n### ${roleColor}[${o.role}]${COUNCIL_COLOR_RESET} ${o.model}\n` };
      if (o.error) {
        yield { type: "content", content: `[Error: ${o.error}]\n` };
      } else {
        active.push({ role: o.role, model: o.model, position: o.position });
        const bgColor = COUNCIL_COLOR_BG[o.role] ?? "";
        yield { type: "content", content: `${bgColor} ${o.role.toUpperCase()} ${COUNCIL_COLOR_RESET} ${o.position}\n` };
      }
    }

    yield {
      type: "content",
      content: `\n> Phase 1: ${active.length} participants, ${((Date.now() - p1Start) / 1000).toFixed(1)}s (parallel)\n`,
    };

    if (active.length < 2) {
      yield { type: "content", content: "\nNot enough successful openings for discussion.\n" };
      yield { type: "done" };
      return;
    }

    // ── Phase 2: Discussion rounds with parallel pair debates ──
    const exchangeLogs: Map<string, string[]> = new Map();
    const pairConverged: Map<string, boolean> = new Map();
    let runningSummary = "";

    for (let round = 1; round <= maxRounds; round++) {
      const p2Start = Date.now();
      yield { type: "content", content: `\n## Phase 2 — Discussion Round ${round}/${maxRounds}\n` };

      // Build independent pairs
      const pairs: Array<{ a: (typeof active)[0]; b: (typeof active)[0]; key: string }> = [];
      for (let i = 0; i < active.length; i++) {
        const a = active[i];
        const b = active[(i + 1) % active.length];
        const key = `${a.role}<>${b.role}`;
        if (pairConverged.get(key)) continue;
        if (!exchangeLogs.has(key)) exchangeLogs.set(key, []);
        pairs.push({ a, b, key });
      }

      if (pairs.length === 0) break;

      // Run pair debates in parallel
      const pairResults = await Promise.all(
        pairs.map(async ({ a, b, key }) => {
          const log = exchangeLogs.get(key)!;
          const chunks: Array<{ label: string; text: string }> = [];

          try {
            let aResponse: string;
            let bResponse: string;

            if (round === 1) {
              const aPrompt = this.councilManager.buildDiscussPrompt("respond", {
                speakerRole: a.role,
                partnerRole: b.role,
                topic,
                speakerPosition: a.position,
                partnerPosition: b.position,
                conversationContext: enrichedContext,
              });
              aResponse = await this.councilManager.generate(a.model, aPrompt.system, aPrompt.prompt);
              log.push(`[${a.role}]: ${aResponse}`);
              chunks.push({ label: `[${a.role}] → [${b.role}]`, text: aResponse });

              const bPrompt = this.councilManager.buildDiscussPrompt("respond", {
                speakerRole: b.role,
                partnerRole: a.role,
                topic,
                speakerPosition: b.position,
                partnerPosition: aResponse,
                conversationContext: enrichedContext,
              });
              bResponse = await this.councilManager.generate(b.model, bPrompt.system, bPrompt.prompt);
              log.push(`[${b.role}]: ${bResponse}`);
              chunks.push({ label: `[${b.role}] → [${a.role}]`, text: bResponse });
            } else {
              const historyText = log.join("\n\n");
              const aPrompt = this.councilManager.buildDiscussPrompt("followup", {
                speakerRole: a.role,
                partnerRole: b.role,
                topic,
                partnerPosition: b.position,
                exchangeHistory: historyText,
                round,
                conversationContext: enrichedContext,
                runningSummary,
              });
              aResponse = await this.councilManager.generate(a.model, aPrompt.system, aPrompt.prompt, 1024);
              log.push(`[${a.role}] (round ${round}): ${aResponse}`);
              chunks.push({ label: `[${a.role}] → [${b.role}]`, text: aResponse });

              const bPrompt = this.councilManager.buildDiscussPrompt("followup", {
                speakerRole: b.role,
                partnerRole: a.role,
                topic,
                partnerPosition: aResponse,
                exchangeHistory: historyText,
                round,
                conversationContext: enrichedContext,
                runningSummary,
              });
              bResponse = await this.councilManager.generate(b.model, bPrompt.system, bPrompt.prompt, 1024);
              log.push(`[${b.role}] (round ${round}): ${bResponse}`);
              chunks.push({ label: `[${b.role}] → [${a.role}]`, text: bResponse });
            }

            b.position = bResponse;
            a.position = aResponse;

            // Convergence check
            const convPrompt = this.councilManager.buildDiscussPrompt("convergence-check", {
              speakerRole: a.role,
              partnerRole: b.role,
              topic,
              exchangeHistory: log.slice(-4).join("\n\n"),
              conversationContext: enrichedContext,
            });
            let converged = false;
            let convReason = "";
            try {
              const raw = await this.councilManager.generate(a.model, convPrompt.system, convPrompt.prompt, 256);
              const match = raw.match(/\{[\s\S]*\}/);
              if (match) {
                const parsed = JSON.parse(match[0]) as { converged?: boolean; reason?: string };
                converged = parsed.converged === true;
                convReason = parsed.reason ?? "";
              }
            } catch {
              /* not converged */
            }

            return { key, chunks, converged, convReason, error: null as string | null };
          } catch (err: unknown) {
            return {
              key,
              chunks,
              converged: false,
              convReason: "",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      // Emit results (sequential yield — maintains readable order)
      let allConverged = true;
      for (const pr of pairResults) {
        for (const chunk of pr.chunks) {
          const labelParts = chunk.label.match(/\[(\w+)\] → \[(\w+)\]/);
          let coloredLabel = chunk.label;
          if (labelParts) {
            const fromColor = COUNCIL_ROLE_COLORS[labelParts[1]] ?? "";
            const toColor = COUNCIL_ROLE_COLORS[labelParts[2]] ?? "";
            coloredLabel = `${fromColor}[${labelParts[1]}]${COUNCIL_COLOR_RESET} → ${toColor}[${labelParts[2]}]${COUNCIL_COLOR_RESET}`;
          }
          yield { type: "content", content: `\n### ${coloredLabel}\n${chunk.text}\n` };
        }
        if (pr.error) {
          yield { type: "content", content: `[Discussion error: ${pr.error}]\n` };
          allConverged = false;
        } else if (pr.converged) {
          pairConverged.set(pr.key, true);
          yield { type: "content", content: `\n> ✓ ${pr.key.replace("<>", " ↔ ")} converged: ${pr.convReason}\n` };
        } else {
          allConverged = false;
        }
      }

      yield {
        type: "content",
        content: `\n> Round ${round}: ${((Date.now() - p2Start) / 1000).toFixed(1)}s (${pairs.length} pairs parallel)\n`,
      };

      if (allConverged) {
        yield { type: "content", content: `\n> All pairs converged at round ${round}. Moving to synthesis.\n` };
        break;
      }

      // Generate inter-round summary for next round's focus
      if (round < maxRounds) {
        try {
          runningSummary = await this.councilManager.generateRoundSummary(exchangeLogs, topic, round, active[0].model);
          yield {
            type: "content",
            content: `\n> **Discussion state:** ${runningSummary
              .split("\n")
              .filter((l) => l.trim())
              .slice(0, 3)
              .join(" | ")}\n`,
          };
        } catch {
          // Non-critical — continue without summary
        }
      }
    }

    // ── Phase 3: Leader synthesis ──
    const p3Start = Date.now();
    yield { type: "content", content: "\n## Phase 3 — Leader Synthesis\n" };

    const leaderModelId = getRoleModel("leader") ?? this.modelId;
    yield { type: "content", content: `\n### \x1b[32m[leader]\x1b[0m ${leaderModelId}\n` };

    const allExchanges = [...exchangeLogs.entries()]
      .map(([pair, log]) => `### Discussion: ${pair}\n${log.join("\n\n")}`)
      .join("\n\n---\n\n");

    const finalPositions = active.map((p) => `**${p.role}** (${p.model}): ${p.position.slice(0, 500)}...`).join("\n\n");

    let synthesisText = "";
    try {
      synthesisText = await this.councilManager.generate(
        leaderModelId,
        "You are the team lead. Multiple specialists just had a structured discussion about a topic.\n\n" +
          "Output TWO parts separated by the exact line `---READABLE---`:\n\n" +
          "**Part 1: JSON** — a single JSON object:\n" +
          "```\n" +
          '{ "type": "decision"|"action_items"|"plan_update"|"resolve_question",\n' +
          '  "summary": "1-2 sentence executive summary",\n' +
          '  "agreed": ["point 1", "point 2"],\n' +
          '  "tradeoffs": ["trade-off 1"],\n' +
          '  "recommendation": "Your decisive recommendation",\n' +
          '  "actionItems": ["step 1", "step 2"],\n' +
          '  "planUpdate": "paragraph for plan update (only if type=plan_update)",\n' +
          '  "resolvedQuestion": {"question": "...", "answer": "..."} }\n' +
          "```\n" +
          "Choose type: decision (general), action_items (concrete steps), plan_update (modify active plan), resolve_question (answer a specific question).\n\n" +
          "**Part 2: Human-readable** — after `---READABLE---`, write the synthesis in markdown:\n" +
          "## AGREED\n## TRADE-OFFS\n## RECOMMENDATION\n## NEXT STEPS\n\n" +
          "Be decisive. Output Part 1 JSON first, then ---READABLE---, then Part 2.",
        `Topic: ${topic}\n\nFinal positions:\n${finalPositions}\n\nFull discussion:\n${allExchanges}`,
        4096,
      );

      // Display human-readable part
      const readablePart = synthesisText.includes("---READABLE---")
        ? synthesisText.split("---READABLE---")[1]?.trim()
        : synthesisText;
      yield { type: "content", content: (readablePart || synthesisText) + "\n" };

      // Parse structured outcome and execute actions
      const structuredOutcome = this.councilManager.parseOutcome(synthesisText, topic);
      if (structuredOutcome) {
        yield* this.councilManager.executeOutcome(structuredOutcome, topic);
        if (this.session) {
          try {
            appendSystemMessage(this.session.id, `[Council Outcome]\n${JSON.stringify(structuredOutcome)}`);
          } catch {
            /* non-critical */
          }
        }
      } else {
        // Fallback: store text-only outcome (backward compatible)
        if (this.session) {
          try {
            appendSystemMessage(this.session.id, `[Council Outcome]\nTopic: ${topic}\n${synthesisText.slice(0, 2000)}`);
          } catch {
            /* non-critical */
          }
        }
      }
    } catch (err: unknown) {
      yield { type: "content", content: `[Synthesis error: ${err instanceof Error ? err.message : err}]\n` };
    }

    // ── Stats + Memory ──
    const councilStats = this.councilManager.stats;
    const totalMs = Date.now() - councilStats.startMs;
    yield {
      type: "content",
      content:
        `\n---\n` +
        `> Council stats: ${councilStats.calls} API calls, ${(totalMs / 1000).toFixed(1)}s total, ` +
        `${active.length} participants, synthesis ${((Date.now() - p3Start) / 1000).toFixed(1)}s\n`,
    };

    // Save council result to session for memory across conversations
    if (this.session && this.sessionStore) {
      const councilRecord = {
        topic,
        participants: active.map((a) => ({ role: a.role, model: a.model })),
        finalPositions: active.map((a) => ({ role: a.role, position: a.position.slice(0, 1000) })),
        synthesis: synthesisText.slice(0, 2000),
        convergedPairs: [...pairConverged.entries()].filter(([, v]) => v).map(([k]) => k),
        stats: { calls: councilStats.calls, durationMs: totalMs },
        timestamp: new Date().toISOString(),
      };
      try {
        appendSystemMessage(this.session.id, `[Council Memory] ${JSON.stringify(councilRecord)}`);
      } catch {
        /* non-critical */
      }
    }

    // Store council output as assistant message so the conversation history
    // stays valid (user→assistant alternation required by most APIs).
    const councilResponse = synthesisText || "[Council completed — see discussion above]";
    if (userModelMessage) {
      this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: councilResponse }]);
    }
    this.councilManager.setLastSynthesis(councilResponse);

    yield { type: "done" };
  }

  // ========================================================================
  // processMessageBatchTurn — batch API message processing loop
  // ========================================================================

  private async *processMessageBatchTurn(args: {
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    provider: LegacyProvider;
    subagents: CustomSubagentConfig[];
    system: string;
    runtime: ReturnType<typeof resolveModelRuntime>;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown> {
    const { userModelMessage, observer, provider, subagents, system, runtime, modelInfo, signal } = args;
    let attemptedOverflowRecovery = false;
    let streamRetryCount = 0;
    const MAX_STREAM_RETRIES = 2;

    while (true) {
      this._compactedThisTurn = false;
      let closeMcp: (() => Promise<void>) | undefined;
      const turnMessages: ModelMessage[] = [];
      const totalUsage: ProcessMessageUsage = {};

      try {
        const settings = attemptedOverflowRecovery
          ? relaxCompactionSettings(this.getCompactionSettings(modelInfo?.contextWindow))
          : this.getCompactionSettings(modelInfo?.contextWindow);
        if (modelInfo?.contextWindow) {
          await this.compactForContext(
            provider,
            system,
            modelInfo.contextWindow,
            signal,
            settings,
            attemptedOverflowRecovery,
          );
        }

        const batchCaps = getProviderCapabilities(runtime.modelInfo?.provider ?? "anthropic");
        if (batchCaps.usesResponsesAPI(runtime.modelInfo)) {
          throw new Error("Batch mode currently supports chat-completions models only.");
        }

        const baseTools = createTools(this.bash, provider, this.mode, {
          runTask: (request, abortSignal) => this.runTask(request, combineAbortSignals(signal, abortSignal)),
          runDelegation: (request, abortSignal) =>
            this.runDelegation(request, combineAbortSignals(signal, abortSignal)),
          readDelegation: (id) => this.readDelegation(id),
          listDelegations: () => this.listDelegations(),
          scheduleManager: this.schedules,
          subagents,
          sendTelegramFile: this.sendTelegramFile ?? undefined,
          sessionId: this.session?.id ?? undefined,
        });
        let tools: ToolSet = !batchCaps.supportsClientTools(runtime.modelInfo) ? {} : baseTools;
        if (this.mode === "agent" && batchCaps.supportsClientTools(runtime.modelInfo)) {
          const mcpBundle = await buildMcpToolSet(loadMcpServers(), {
            onOAuthRequired: (_serverId, url) => {
              const urlStr = url.toString();
              import("child_process").then(({ exec }) => {
                const cmd =
                  process.platform === "win32"
                    ? `start "" "${urlStr}"`
                    : process.platform === "darwin"
                      ? `open "${urlStr}"`
                      : `xdg-open "${urlStr}"`;
                exec(cmd);
              });
            },
          });
          closeMcp = mcpBundle.close;
          tools = { ...baseTools, ...mcpBundle.tools };
          if (mcpBundle.errors.length > 0) {
            yield { type: "content", content: `MCP unavailable: ${mcpBundle.errors.join(" | ")}\n\n` };
          }
        }

        const batchTools = !batchCaps.supportsClientTools(runtime.modelInfo) ? [] : await toolSetToBatchTools(tools);
        const batch = await createBatch({
          ...this.getBatchClientOptions(signal),
          name: buildBatchName("session", this.getSessionId() || runtime.modelId),
        });

        for (let round = 0; round < this.maxToolRounds; round++) {
          const stepNumber = round + 1;
          notifyObserver(observer?.onStepStart, {
            stepNumber,
            timestamp: Date.now(),
          });

          const batchRequestId = `turn-${Date.now()}-${stepNumber}`;
          // Phase O1 — capture providerOptions SHAPE for batch path too.
          this._lastProviderOptionsShape = extractProviderOptionsShape(runtime.providerOptions);
          await addBatchRequests({
            ...this.getBatchClientOptions(signal),
            batchId: batch.batch_id,
            batchRequests: [
              {
                batch_request_id: batchRequestId,
                batch_request: {
                  chat_get_completion: buildBatchChatCompletionRequest({
                    modelId: runtime.modelId,
                    system,
                    messages: [...this.messages, ...turnMessages],
                    temperature: 0.7,
                    maxOutputTokens: !batchCaps.acceptsParam("maxOutputTokens", runtime.modelInfo)
                      ? undefined
                      : this.maxTokens,
                    reasoningEffort: runtime.providerOptions?.xai.reasoningEffort,
                    tools: batchTools,
                  }),
                },
              },
            ],
          });

          const result = await pollBatchRequestResult({
            ...this.getBatchClientOptions(signal),
            batchId: batch.batch_id,
            batchRequestId,
          });
          const response = getBatchChatCompletion(result);
          const choice = response.choices[0];
          if (!choice) {
            throw new Error("Batch response did not contain any choices.");
          }

          const usage = getBatchUsage(response);
          accumulateUsage(totalUsage, usage);
          const finishReason = getBatchFinishReason(choice.finish_reason);

          const content = choice.message.content ?? "";
          if (content) {
            yield { type: "content", content };
          }

          const requestMessages = [...this.messages, ...turnMessages];
          const toolCalls = (choice.message.tool_calls ?? []).map(toLocalToolCall);
          const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
          if (assistantMessage) {
            turnMessages.push(assistantMessage);
          }

          if (toolCalls.length === 0) {
            notifyObserver(observer?.onStepFinish, {
              stepNumber,
              timestamp: Date.now(),
              finishReason,
              usage,
            });
            if (hasUsage(totalUsage)) {
              this.recordUsage(totalUsage, "message", runtime.modelId);
            }
            this.appendCompletedTurn(userModelMessage, turnMessages);
            if (modelInfo?.contextWindow) {
              await this.postTurnCompact(provider, system, modelInfo.contextWindow, signal);
            }
            yield { type: "done" };
            return;
          }

          yield { type: "tool_calls", toolCalls };

          const toolParts: ExecutedBatchTool[] = [];
          for (const toolCall of toolCalls) {
            notifyObserver(observer?.onToolStart, {
              toolCall,
              timestamp: Date.now(),
            });

            const executed = await this.executeBatchToolCall(tools, toolCall, requestMessages, signal);
            notifyObserver(observer?.onToolFinish, {
              toolCall,
              toolResult: executed.result,
              timestamp: Date.now(),
            });
            yield { type: "tool_result", toolCall, toolResult: executed.result };
            toolParts.push({
              toolCall,
              input: executed.input,
              toolResult: executed.result,
            });
          }

          const toolMessage = buildToolBatchMessage(toolParts);
          if (toolMessage) {
            turnMessages.push(toolMessage);
          }
          notifyObserver(observer?.onStepFinish, {
            stepNumber,
            timestamp: Date.now(),
            finishReason,
            usage,
          });
        }

        const message = `Error: Reached max tool rounds (${this.maxToolRounds}) in batch mode.`;
        notifyObserver(observer?.onError, {
          message,
          timestamp: Date.now(),
        });
        if (hasUsage(totalUsage)) {
          this.recordUsage(totalUsage, "message", runtime.modelId);
        }
        this.appendCompletedTurn(userModelMessage, turnMessages);
        yield { type: "error", content: message };
        yield { type: "done" };
        return;
      } catch (err: unknown) {
        if (signal.aborted) {
          this.discardAbortedTurn(userModelMessage);
          yield { type: "content", content: "\n\n[Cancelled]" };
          yield { type: "done" };
          return;
        }

        if (!attemptedOverflowRecovery && turnMessages.length === 0 && modelInfo && isContextLimitError(err)) {
          attemptedOverflowRecovery = true;
          continue;
        }

        // Transient retry — batch mode: only retry when no tool messages yet
        if (turnMessages.length === 0 && streamRetryCount < MAX_STREAM_RETRIES && !signal.aborted) {
          const { transient } = classifyStreamError(err);
          if (transient) {
            streamRetryCount++;
            const baseMs = 500;
            const expMs = Math.min(baseMs * 4 ** (streamRetryCount - 1), 8_000);
            const spread = expMs * 0.25;
            const nextDelayMs = Math.round(expMs + (Math.random() * 2 - 1) * spread);
            const errorName = err instanceof Error ? err.name : "Error";
            const errorMessage = err instanceof Error ? err.message : String(err);
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
            await new Promise<void>((resolve) => setTimeout(resolve, nextDelayMs));
            if (!signal.aborted) {
              continue;
            }
          }
        }

        const authError = isAuthenticationError(err);
        const friendly = humanizeApiError(err);
        notifyObserver(observer?.onError, {
          message: friendly,
          timestamp: Date.now(),
        });
        if (hasUsage(totalUsage)) {
          this.recordUsage(totalUsage, "message", runtime.modelId);
        }
        this.appendCompletedTurn(userModelMessage, turnMessages);
        yield {
          type: "error",
          content: friendly,
          isAuthError: authError,
        };
        yield { type: "done" };
        return;
      } finally {
        await closeMcp?.().catch(() => {});
      }
    }
  }

  private appendCompletedTurn(userMessage: ModelMessage, newMessages: ModelMessage[]): void {
    if (newMessages.length === 0) return;

    const userIndex = this.messages.lastIndexOf(userMessage);
    if (!this.sessionStore || !this.session) {
      if (userIndex >= 0 && this.messageSeqs[userIndex] == null) {
        this.messageSeqs[userIndex] = null;
      }
      this.messages.push(...newMessages);
      this.messageSeqs.push(...newMessages.map(() => null));
      return;
    }

    // Phase A5 — if the user message already has a persisted seq (set by
    // the write-ahead path), skip re-inserting it. The write-ahead row
    // will be upserted to status='completed' on the next `appendMessages`
    // call that sees it via ON CONFLICT, but here we only need to insert
    // the *new* assistant/tool messages so they get fresh sequence
    // numbers contiguous with the user row.
    const existingUserSeq = userIndex >= 0 ? this.messageSeqs[userIndex] : null;
    if (typeof existingUserSeq === "number") {
      // User row is already persisted (write-ahead). Insert only the new
      // assistant/tool messages so they get fresh sequence numbers
      // contiguous with the user row. Then flip the user row's status
      // from 'pending' to 'completed' so forensics + replay tooling can
      // tell the turn settled cleanly.
      const insertedSeqs = appendMessages(this.session.id, newMessages);
      markMessageCompleted(this.session.id, existingUserSeq);
      this.messages.push(...newMessages);
      this.messageSeqs.push(...insertedSeqs);
      this.sessionStore.touchSession(this.session.id, this.bash.getCwd());
      this.session = this.sessionStore.getRequiredSession(this.session.id);
      return;
    }

    const insertedSeqs = appendMessages(this.session.id, [userMessage, ...newMessages]);
    if (userIndex >= 0) {
      this.messageSeqs[userIndex] = insertedSeqs[0] ?? this.messageSeqs[userIndex];
    }
    this.messages.push(...newMessages);
    this.messageSeqs.push(...insertedSeqs.slice(1));
    this.sessionStore.touchSession(this.session.id, this.bash.getCwd());
    this.session = this.sessionStore.getRequiredSession(this.session.id);
  }

  private fireHook(
    input: Parameters<typeof executeEventHooks>[0],
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof executeEventHooks>>> {
    return executeEventHooks(input, this.bash.getCwd(), signal);
  }

  // ========================================================================
  // processMessage — main streaming turn loop (PIL enrichment, routing, LLM
  // stream, tool execution, compaction, hooks, observer notifications)
  // ========================================================================

  async *processMessage(
    userMessage: string,
    observer?: ProcessMessageObserver,
    images?: Array<{ path: string; mediaType: string; base64: string }>,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    // TUI-04: prefer the external AbortContext (from SIGINT handler) so that
    // Ctrl+C mid-tool-call triggers a single, unified abort across all I/O.
    // If no external context, fall back to creating a local AbortController.
    if (this.externalAbortContext) {
      // Wrap the external signal in a local controller so existing cleanup
      // paths (this.abortController = null) still work without side-effects.
      this.abortController = new AbortController();
      // Forward external abort to the local controller.
      this.externalAbortContext.signal.addEventListener(
        "abort",
        () => {
          this.abortController?.abort(this.externalAbortContext?.reason());
        },
        { once: true },
      );
    } else {
      this.abortController = new AbortController();
    }
    const signal = this.abortController.signal;
    this.emitSubagentStatus(null);

    // Phase C3: advance the cross-turn dedup turn counter so stubs can point
    // back to the correct prior turn.
    this._crossTurnDedup?.beginTurn();

    // P0 native observation: turn boundary. Capture the prior batch via
    // resetBatch — file-revert detection (in the hook layer) reads it on
    // the first edit of the new turn. No language-based veto matching.
    try {
      getMistakeDetector().resetBatch();
      if (this.session?.id) {
        fireTrajectoryEvent({
          ts: new Date().toISOString(),
          sessionId: this.session.id,
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
            this.abortController?.signal.reason ? String(this.abortController.signal.reason) : undefined,
          );
        } catch {
          /* fail-open */
        }
        try {
          const det = getMistakeDetector();
          const events = det.detectAbort(
            this.abortController?.signal.reason ? String(this.abortController.signal.reason) : undefined,
          );
          if (events.length === 0) return;
          const cwd = this.bash.getCwd();
          const tenantId = getTenantIdForVeto();
          void buildScopeForVeto({ cwd })
            .then((scope) => {
              for (const ev of events) {
                void getEEClientForVeto()
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

    // P0 native observation: cache turn-level intent fields for PreToolUse.
    this._turnUserGoalExcerpt = userMessage.slice(0, 200);
    this._turnAssistantReasoning = "";

    // Ensure flow run is ready before processing (fail-open).
    await this._flowReady?.catch(() => {});

    // Upgrade to OAuth-backed provider on first turn if tokens are available.
    await this._initOAuthProvider().catch(() => {});

    if (!this.sessionStartHookFired) {
      this.sessionStartHookFired = true;
      const isResume = this.messages.length > 0;
      const sessionStartInput: SessionStartHookInput = {
        hook_event_name: "SessionStart",
        source: isResume ? "resume" : "startup",
        session_id: this.session?.id,
        cwd: this.bash.getCwd(),
      };
      await this.fireHook(sessionStartInput, signal).catch(() => {});
    }

    const promptInput: UserPromptSubmitHookInput = {
      hook_event_name: "UserPromptSubmit",
      user_prompt: userMessage,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(promptInput, signal).catch(() => {});

    await this.consumeBackgroundNotifications();

    const _debugOn = isDebugEnabled();
    const _debugSteps: PipelineStep[] = [];
    const _debugTurnId = this.messages.filter((m) => m.role === "user").length + 1;

    // PIL: enrich prompt before pushing to messages (D-01, D-03, D-04)
    // Promise.race timeout of 200ms is inside runPipeline — fail-open guaranteed
    const _pilStart = Date.now();
    const pilCtx = await runPipeline(userMessage, {
      resumeDigest: this._resumeDigest,
      activeRunId: this._activeRunId,
      sessionId: this.session?.id ?? null,
    }).catch((err) => ({
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
    }));
    // Cheap signal forwarded from PIL Layer 1 — true when input is greeting /
    // small-talk (≤10 chars + ≤2 words OR brain-classified "none"). Used to
    // skip the MCP tool catalog, which dominates input tokens (~20K) and is
    // useless for "hi" / "ok" / "thanks".
    const isChitchat = pilCtx.intentKind === "chitchat";
    const enrichedMessage = pilCtx.enriched;
    this._pilActive = pilCtx.taskType !== null;
    this._pilEnrichmentDelta =
      pilCtx.metrics?.suffixInstructionTokens ?? Math.round((enrichedMessage.length - userMessage.length) / 4);

    // P1 Item 3 wiring: phase-boundary detection. setPhase returns a snapshot
    // of the prior phase iff the phase NAME just changed. We classify the
    // outcome (pass/fail/abandoned/null) and fire phase-outcome to the EE
    // server when there is a high-SNR verdict. Endpoint is feature-flagged
    // server-side; 404 is silently swallowed by the client wrapper.
    try {
      const drained = phaseTracker.setPhase(pilCtx.gsdPhase ?? null);
      if (drained && drained.principleRefs.length > 0 && this.session?.id) {
        const outcome = phaseTracker.classifyOutcome(drained);
        if (outcome) {
          fireAndForgetPhaseOutcome(
            {
              sessionId: this.session.id,
              phaseName: drained.phaseName,
              outcome,
              toolEventIds: drained.principleRefs,
              evidence: {
                durationMs: drained.endedAt - drained.startedAt,
                toolCount: drained.toolCount,
                cwd: this.bash.getCwd(),
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
        tokens_saved: this._pilEnrichmentDelta > 0 ? this._pilEnrichmentDelta : undefined,
      });
    }

    // Interaction log: PIL classification
    try {
      if (this.session) {
        const pilDurationMs = Date.now() - _pilStart;
        logInteraction(this.session.id, "pil", {
          eventSubtype: pilCtx.taskType ?? "none",
          durationMs: pilDurationMs,
          data: {
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
        logInteraction(this.session.id, "user_message", {
          data: {
            raw_length: userMessage.length,
            enriched_length: enrichedMessage.length,
            taskType: pilCtx.taskType,
            intentKind: pilCtx.intentKind ?? null,
            confidence: pilCtx.confidence,
            pilActive: this._pilActive,
          },
        });
      }
    } catch {
      /* fail-open */
    }

    // ROUTE-11: Per-turn model routing via decide() — picks cheapest capable model
    const turnStartMs = Date.now();
    let turnModelId = this.modelId;
    let taskHash: string | null = null;
    const _routeStart = Date.now();
    try {
      const { decide } = await import("../router/decide.js");
      const routeDecision = await decide(userMessage, {
        tenantId: "local",
        cwd: this.bash.getCwd(),
        defaultModel: this.modelId,
        defaultProvider: this.providerId,
        pil: {
          domain: pilCtx.domain,
          taskType: pilCtx.taskType,
          confidence: pilCtx.confidence,
          gsdPhase: pilCtx.gsdPhase ?? null,
          activeRunId: pilCtx.activeRunId ?? null,
          recentTurnsSummary: this._buildRecentTurnsSummary(),
          projectSize: this._estimateProjectSize(),
          filesTouched: this._countFilesTouched(),
          mode: this.mode,
        },
      });
      if (routeDecision.model && routeDecision.model !== "HALT") {
        // Respect user's default model when it has a vision proxy and the
        // current turn (or history) has images — the proxy will convert
        // images to text, so there's no need to switch to a vision-capable
        // (and usually pricier / rate-limited) model.
        const defaultHasVisionProxy = needsVisionProxy(this.modelId);
        const historyHasImages = this.messages.some(
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
      if (turnModelId !== this.modelId) {
        statusBarStore.setState({ routed_from: this.modelId, model: turnModelId });
      } else {
        const prev = statusBarStore.getState();
        if (prev.routed_from || prev.model !== this.modelId) {
          statusBarStore.setState({ routed_from: null, model: this.modelId });
        }
      }
      if (_debugOn) {
        _debugSteps.push({
          name: "Router",
          duration_ms: Date.now() - _routeStart,
          input_summary: `default=${this.modelId}`,
          output_summary: turnModelId !== this.modelId ? `routed→${turnModelId}` : `kept ${turnModelId}`,
        });
      }
    } catch {
      // Router unavailable — use session default model (skip if provider is disabled)
      if (!isProviderDisabled(this.providerId as ProviderId)) {
        const eeRoute = await routeModel(userMessage, {}, this.providerId).catch(() => null);
        taskHash = eeRoute?.taskHash ?? null;
      }
    }

    // Interaction log: model routing
    try {
      if (this.session) {
        logInteraction(this.session.id, "routing", {
          model: turnModelId,
          data: { defaultModel: this.modelId, routedModel: turnModelId, taskHash },
        });
      }
    } catch {
      /* fail-open */
    }

    // Re-detect provider if router picked a model from a different provider
    const turnProviderId = detectProviderForModel(turnModelId);
    let turnProvider: LegacyProvider;
    if (turnProviderId !== this.providerId) {
      // Even if the key is reachable, skip disabled providers
      const turnKey = !isProviderDisabled(turnProviderId as ProviderId)
        ? await loadKeyForProvider(turnProviderId).catch(() => null)
        : null;
      if (turnKey) {
        turnProvider = createProvider(turnProviderId, turnKey);
      } else {
        // Router's provider unreachable or disabled — fall back to a non-disabled provider
        const fallback = await this.councilManager.resolveNonDisabledFallback();
        turnModelId = fallback.modelId;
        turnProvider = this.requireProvider();
      }
    } else if (isProviderDisabled(this.providerId as ProviderId)) {
      // Session provider is disabled — find a non-disabled alternative
      const fallback = await this.councilManager.resolveNonDisabledFallback();
      turnModelId = fallback.modelId;
      turnProvider = this.requireProvider();
    } else {
      turnProvider = this.requireProvider();
    }

    // E4: prepend one-shot cwd note when setCwd() changed the working directory
    // mid-session. Clears after injection so only the first subsequent turn sees it.
    const cwdNote = this._pendingCwdNote;
    this._pendingCwdNote = null;
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
      const historyHasImages = this.messages.some(
        (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((p) => p.type === "image"),
      );
      const turnHasImages = (images?.length ?? 0) > 0;
      if (turnHasImages || historyHasImages) {
        try {
          if (historyHasImages) {
            const historyResult = await proxyVision(this.messages, turnModelId, signal);
            if (historyResult.proxied) {
              this.messages = historyResult.messages;
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
          this.messages = this.messages.map((m) => {
            if (!Array.isArray(m.content)) return m;
            const filtered = (m.content as Array<{ type: string }>).filter((p) => p.type !== "image");
            return { ...m, content: filtered } as typeof m;
          });
        }
      }
    }

    this.messages.push(userModelMessage);
    // Phase A5 — write-ahead the user row so `recordUsage` mid-stream can
    // attribute usage to a real `message_seq` instead of falling back to
    // NULL (or to the previous turn's assistant seq for a session that has
    // multi-turn history). The post-stream `appendCompletedTurn(...)` path
    // upserts the same row to `status='completed'` via the
    // `ON CONFLICT(session_id, seq) DO UPDATE` clause in `appendMessages`.
    let userWriteAheadSeq: number | null = null;
    if (this.session) {
      try {
        userWriteAheadSeq = getNextMessageSequence(this.session.id);
        persistMessageWriteAhead(this.session.id, userWriteAheadSeq, "user", JSON.stringify(userModelMessage));
      } catch {
        // Fail-open: if seq lookup throws, fall back to the legacy NULL
        // path. The forensics anomaly returns but the turn proceeds.
        userWriteAheadSeq = null;
      }
    }
    this.messageSeqs.push(userWriteAheadSeq);

    // Inject accumulated EE session guidance as a system message so the model
    // is informed of past warnings before making tool decisions this turn.
    if (this._sessionEEGuidance.size > 0) {
      const lines = Array.from(this._sessionEEGuidance.entries()).map(([, g]) => {
        const pct = Math.round(g.confidence * 100);
        return `- [${g.toolName}] ${g.message} (Why: ${g.why}) [${pct}%]`;
      });
      this.messages.push({
        role: "system",
        content: `[EE Session Guidance — avoid these patterns when using tools]\n${lines.join("\n")}`,
      });
      this.messageSeqs.push(null);
    }

    const provider = turnProvider;
    const subagents = loadValidSubAgents();
    const _pilResponseTools = getResponseToolSet(pilCtx, this.providerId);
    const _hasResponseTools = Object.keys(_pilResponseTools).length > 0;
    const systemParts = buildSystemPromptParts(
      this.bash.getCwd(),
      this.mode,
      this.bash.getSandboxMode(),
      this.planContext,
      subagents,
      this.bash.getSandboxSettings(),
      this.providerId,
      this._resumeDigest,
      { chitchat: isChitchat },
    );
    if (this._resumeDigest) this._resumeDigest = null;
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
    const stepRouterDecision = decideStepRouting(turnModelId, this.providerId, stepRouterCfg);
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

    this.planContext = null;
    let attemptedOverflowRecovery = false;
    // Stream-retry state: track how many transient retries have been attempted
    // for the current turn. Reset to 0 on each new user turn (we're in processMessage).
    let streamRetryCount = 0;
    const MAX_STREAM_RETRIES = 2; // 3 total attempts = 1 first try + 2 retries

    // Auto-council: route to multi-model debate when EITHER
    //   (a) PIL classified taskType=plan|analyze with high confidence, OR
    //   (b) GSD-native tier === "heavy" (wholesale / multi-step / cross-repo work).
    // After the debate finishes, runCouncilV2 records synthesis on
    // councilManager.lastSynthesis; we then re-enter processMessage with the synthesis
    // as the next user turn so the main loop continues with full debate context.
    // Skip if this is already a council continuation turn (prevent infinite recursion).
    const autoCouncilTypes = new Set(["plan", "analyze"]);
    const councilRoles = getRoleModels();
    const configuredRoleCount = Object.values(councilRoles).filter(Boolean).length;
    const heavyTier = (pilCtx as { complexityTier?: string | null }).complexityTier === "heavy";
    const autoCouncilConfidence = getAutoCouncilConfidence();
    const autoCouncilMinRoles = getAutoCouncilMinRoles();
    const taskTypeMatch =
      pilCtx.taskType && autoCouncilTypes.has(pilCtx.taskType) && pilCtx.confidence >= autoCouncilConfidence;
    const shouldAutoCouncil =
      !this.councilManager.isContinuation &&
      isAutoCouncilEnabled() &&
      configuredRoleCount >= autoCouncilMinRoles &&
      (taskTypeMatch || heavyTier);

    // Always log the auto-council decision (taken or skipped) with the gate
    // values that decided it. Lets reports answer "why did this turn cost
    // $0.30?" and "is the confidence floor tuned wrong for my prompts?".
    const autoCouncilSkipReason = (() => {
      if (this.councilManager.isContinuation) return "continuation-turn";
      if (!isAutoCouncilEnabled()) return "feature-disabled";
      if (configuredRoleCount < autoCouncilMinRoles)
        return `role-count<${autoCouncilMinRoles} (have ${configuredRoleCount})`;
      if (!taskTypeMatch && !heavyTier) {
        if (!pilCtx.taskType || !autoCouncilTypes.has(pilCtx.taskType))
          return `taskType=${pilCtx.taskType ?? "null"} not in plan|analyze`;
        if (pilCtx.confidence < autoCouncilConfidence)
          return `confidence<${autoCouncilConfidence} (got ${pilCtx.confidence.toFixed(2)})`;
        return "no-trigger";
      }
      return "taken";
    })();
    appendDecisionLog({
      ts: Date.now(),
      sessionId: this.session?.id ?? null,
      kind: "auto-council",
      taken: shouldAutoCouncil,
      reason: autoCouncilSkipReason,
      meta: {
        taskType: pilCtx.taskType ?? null,
        confidence: pilCtx.confidence,
        complexityTier: (pilCtx as { complexityTier?: string | null }).complexityTier ?? null,
        configuredRoleCount,
        autoCouncilConfidence,
        autoCouncilMinRoles,
        heavyTier,
        isContinuation: this.councilManager.isContinuation,
      },
    }).catch(() => undefined);

    if (shouldAutoCouncil) {
      const reason = heavyTier
        ? `complexity=heavy${pilCtx.taskType ? ` task=${pilCtx.taskType}` : ""}`
        : `${pilCtx.taskType} task detected with ${(pilCtx.confidence * 100).toFixed(0)}% confidence`;
      yield { type: "content", content: `\n[Auto-council triggered: ${reason}]\n` };
      yield* this.runCouncilV2(userMessage, { skipClarification: true, observer, userModelMessage });
      const synthesis = this.councilManager.lastSynthesis;
      this.councilManager.setLastSynthesis(null);
      if (synthesis) {
        yield { type: "content", content: "\n[Auto-continuing with council recommendations...]\n" };
        this.councilManager.setContinuation(true);
        try {
          yield* this.processMessage(
            `Council debate completed. Synthesis:\n\n${synthesis}\n\nProceed with the recommended action items.`,
            observer,
          );
        } finally {
          this.councilManager.setContinuation(false);
        }
      }
      return;
    }

    if (this.batchApi) {
      try {
        yield* this.processMessageBatchTurn({
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
        if (this.abortController?.signal === signal) {
          this.abortController = null;
        }
      }
      return;
    }

    try {
      while (true) {
        // SAMR Phase 2: switch to fast model for tool-execution steps
        if (stepRouterPhase === "phase2" && phase2Runtime) {
          runtime = phase2Runtime;
          modelInfo = runtime.modelInfo;
        }

        this._compactedThisTurn = false;
        let assistantText = "";
        let reasoningPreview = "";
        let encryptedReasoningHidden = false;
        let streamOk = false;
        let closeMcp: (() => Promise<void>) | undefined;
        let stepNumber = -1;
        const activeToolCalls: ToolCall[] = [];
        // SAMR: track whether Phase 1 produced tool calls
        let phase1HadToolCalls = false;

        try {
          const settings = attemptedOverflowRecovery
            ? relaxCompactionSettings(this.getCompactionSettings(modelInfo?.contextWindow))
            : this.getCompactionSettings(modelInfo?.contextWindow);
          if (modelInfo?.contextWindow) {
            await this.compactForContext(
              provider,
              system,
              modelInfo.contextWindow,
              signal,
              settings,
              attemptedOverflowRecovery,
            );
          }

          const baseToolsRaw = createTools(this.bash, provider, this.mode, {
            runTask: (request, abortSignal) => this.runTask(request, combineAbortSignals(signal, abortSignal)),
            runDelegation: (request, abortSignal) =>
              this.runDelegation(request, combineAbortSignals(signal, abortSignal)),
            readDelegation: (id) => this.readDelegation(id),
            listDelegations: () => this.listDelegations(),
            scheduleManager: this.schedules,
            subagents,
            sendTelegramFile: this.sendTelegramFile ?? undefined,
            sessionId: this.session?.id ?? undefined,
            modelId: turnModelId,
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
          const turnCaps = getProviderCapabilities(runtime.modelInfo?.provider ?? "anthropic");
          let rawToolSet: ToolSet = !turnCaps.supportsClientTools(runtime.modelInfo)
            ? {}
            : isChitchat
              ? {}
              : baseToolsRaw;
          // MCP skip: chitchat / greeting inputs don't need 7 MCP servers'
          // worth of tool schemas (~20K input tokens). PIL Layer 1 already
          // gates this conservatively (≤10 chars + ≤2 words OR brain "none").
          if (this.mode === "agent" && !isChitchat && turnCaps.supportsClientTools(runtime.modelInfo)) {
            // Smart MCP filter: skip browser/vision MCP servers unless the
            // user's current message has a URL or explicitly invokes the
            // browser/screenshot/design vocabulary. Local code work — which
            // is the majority of turns — does not need Playwright/Figma/Canva
            // tool schemas (each MCP contributes 8-15 tools at ~150 tok each).
            // Override with MUONROI_DISABLE_SMART_MCP=1.
            const smartMcp = process.env.MUONROI_DISABLE_SMART_MCP !== "1";
            const browserSignal =
              /https?:\/\/\S+|\b(screenshot|browser|playwright|chrome|figma|canva|render|webpage|website|url|hyperlink|navigate|click|scrape)\b/i.test(
                userMessage,
              );
            const SKIP_WHEN_NO_BROWSER = /playwright|chrome|browser|devtools|vision|figma|canva/i;
            const allServers = loadMcpServers();
            const filteredServers =
              smartMcp && !browserSignal ? allServers.filter((s) => !SKIP_WHEN_NO_BROWSER.test(s.id)) : allServers;
            const mcpBundle = await buildMcpToolSet(filteredServers, {
              onOAuthRequired: (_serverId, url) => {
                const urlStr = url.toString();
                import("child_process").then(({ exec }) => {
                  const cmd =
                    process.platform === "win32"
                      ? `start "" "${urlStr}"`
                      : process.platform === "darwin"
                        ? `open "${urlStr}"`
                        : `xdg-open "${urlStr}"`;
                  exec(cmd);
                });
              },
            });
            closeMcp = mcpBundle.close;
            rawToolSet = { ...rawToolSet, ...mcpBundle.tools };
            if (mcpBundle.errors.length > 0) {
              yield { type: "content", content: `MCP unavailable: ${mcpBundle.errors.join(" | ")}\n\n` };
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
            wrapToolSetWithDedup(topLevelCap.tools, this._crossTurnDedup),
            this._readBudget,
          );
          captureToolSchemas(tools);
          let responseToolCalled = false;

          // G3: providerOptions assembly is owned by the capability layer
          // (src/providers/capabilities.ts). buildTurnProviderOptions feeds
          // sessionId in so openai.promptCacheKey is derived per turn.
          // The task-type-driven anthropic.thinking budget override stays
          // here because it depends on PIL task context, not provider quirks.
          // biome-ignore lint/suspicious/noExplicitAny: matches RuntimeResult.providerOptions shape (any) used downstream
          const baseProviderOpts: any = buildTurnProviderOptions(runtime, { sessionId: this.session?.id }) ?? {};
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

          const systemForModel = runtime.modelId.startsWith("claude")
            ? [
                {
                  role: "system" as const,
                  content: systemParts.staticPrefix,
                  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
                },
                { role: "system" as const, content: system.slice(systemParts.staticPrefix.length) },
              ]
            : system;

          // Capture prompt-size breakdown so recordUsage can attach it to the
          // cost-log entry. Without this, "system prompt is huge" is unfalsifiable.
          // chars/4 ≈ tokens for English; reported as chars to keep math obvious.
          const messagesChars = this.messages.reduce((s, m) => {
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
          this._lastPromptBreakdown = {
            systemChars: system.length,
            staticPrefixChars: systemParts.staticPrefix.length,
            dynamicSuffixChars: systemParts.dynamicSuffix.length,
            playwrightGuidanceChars: playwrightGuidance.length,
            messagesChars,
            messagesCount: this.messages.length,
            toolsChars,
            toolsCount,
          };

          // Task 2.6a — assign a fresh correlation ID for this top-level streamText call.
          this._currentCallId = crypto.randomUUID();
          const _topCallId = this._currentCallId;
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
          this._lastProviderOptionsShape =
            Object.keys(providerOpts).length > 0 ? extractProviderOptionsShape(providerOpts) : null;
          if (wireDebug.enabled) {
            wireDebug.logRequest({
              providerId: runtime.modelInfo?.provider ?? "unknown",
              modelId: runtime.modelId,
              messages: this.messages as readonly unknown[],
              systemChars: systemForModel?.length ?? 0,
              toolNames: tools ? Object.keys(tools as Record<string, unknown>) : undefined,
              providerOptions: providerOpts,
            });
          }
          // SiliconFlow DeepSeek thinking-mode reasoning_content workaround
          // (see siliconflow-history.ts). Sub-agent path applies the same strip
          // via the capability hook; identity for every other provider.
          const _topMessagesForCall = turnCaps.sanitizeHistory(this.messages) as typeof this.messages;
          const result = streamText({
            model: runtime.model,
            system: systemForModel,
            messages: _topMessagesForCall,
            tools,
            toolChoice: _hasResponseTools && turnCaps.supportsClientTools(runtime.modelInfo) ? "auto" : undefined,
            stopWhen:
              stepRouterPhase === "phase1"
                ? stepCountIs(1) // SAMR Phase 1: stop after reasoning step
                : stepCountIs(this.maxToolRounds),
            maxRetries: 0,
            abortSignal: signal,
            prepareStep: ({ stepNumber: sn, messages: stepMessages }) => {
              if (sn < 1) return {};
              const stripped = turnCaps.sanitizeHistory(stepMessages) as typeof stepMessages;
              const compacted = compactSubAgentMessages(stripped, {
                thresholdChars: topLevelCompactThreshold,
                keepLastTurns: topLevelCompactKeepLast,
                label: "top-level",
              });
              if (compacted === stripped && stripped === stepMessages) return {};
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
                this.recordUsage(stepUsage, "message", runtime.modelId);
              }
            },
            onFinish: ({ finishReason }) => {
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
              } catch {
                /* best-effort */
              }
              this._currentCallId = "";
            },
          });

          let _topTokenIndex = 0;
          const _wireProviderIdTop = runtime.modelInfo?.provider ?? "unknown";
          for await (const part of result.fullStream) {
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
                this._turnAssistantReasoning = (this._turnAssistantReasoning + part.text).slice(-400);
                yield { type: "reasoning", content: part.text };
                break;

              case "tool-call": {
                const tc = toToolCall(part);
                activeToolCalls.push(tc);
                // SAMR: track that Phase 1 produced tool calls → transition to Phase 2
                if (stepRouterPhase === "phase1") phase1HadToolCalls = true;

                // EE PreToolUse hook: fire intercept before tool execution.
                {
                  const intentContext: import("../hooks/types.js").PreToolIntentContext = {
                    ...(this._turnAssistantReasoning
                      ? { assistantReasoningExcerpt: this._turnAssistantReasoning.slice(-200) }
                      : {}),
                    ...(this._priorWarningIdsInSession.size > 0
                      ? {
                          priorWarningIdsInSession: Array.from(this._priorWarningIdsInSession).slice(-20),
                        }
                      : {}),
                    ...(pilCtx.gsdPhase ? { gsdPhase: pilCtx.gsdPhase } : {}),
                    ...(this._turnUserGoalExcerpt ? { userGoalExcerpt: this._turnUserGoalExcerpt } : {}),
                  };
                  const preInput: PreToolUseHookInput = {
                    hook_event_name: "PreToolUse",
                    tool_name: tc.function.name,
                    tool_input: JSON.parse(tc.function.arguments || "{}"),
                    session_id: this.session?.id,
                    cwd: this.bash.getCwd(),
                    ...(Object.keys(intentContext).length > 0 ? { intent_context: intentContext } : {}),
                  };
                  const preResult = await this.fireHook(preInput, signal).catch(() => ({
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
                    this._sessionEEGuidance.set(m.id, {
                      toolName: m.toolName,
                      message: m.message,
                      why: m.why,
                      confidence: m.confidence,
                    });
                    // Cap at 30 entries — oldest first, trim when exceeded.
                    if (this._sessionEEGuidance.size > 30) {
                      const firstKey = this._sessionEEGuidance.keys().next().value;
                      if (firstKey !== undefined) this._sessionEEGuidance.delete(firstKey);
                    }
                  }
                  // P0 native observation: track which principle IDs surfaced
                  // this turn so the next intercept can dedup server-side.
                  try {
                    const { getLastSurfacedState } = await import("../ee/intercept.js");
                    const { surfacedIds } = getLastSurfacedState();
                    for (const id of surfacedIds) this._priorWarningIdsInSession.add(id);
                    // Cap memory: keep only most-recent 100 IDs.
                    if (this._priorWarningIdsInSession.size > 100) {
                      const arr = Array.from(this._priorWarningIdsInSession);
                      this._priorWarningIdsInSession = new Set(arr.slice(-100));
                    }
                  } catch {
                    /* fail-open */
                  }
                }

                // Pitfall 9: log the pending call so reconcile() can recover any
                // staged .tmp files if the process is killed before tool-result.
                if (this.pendingCalls) {
                  const turnId = this.session?.id ?? "anon";
                  const callId = stableCallId(turnId, tc.function.name, tc.function.arguments);
                  // Phase 0: predictStagedPaths = [] for all tools (refined in Phase 1).
                  void this.pendingCalls.begin({ call_id: callId, tool_name: tc.function.name }).catch(() => {});
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
                if (this.sessionStore && this.session) {
                  // Predicted assistant seq: user message + assistant message
                  // are appended atomically by appendCompletedTurn().
                  // getNextMessageSequence() returns the seq the user message
                  // will get; the assistant message is the next one after.
                  let predictedSeq = -1;
                  try {
                    predictedSeq = getNextMessageSequence(this.session.id) + 1;
                  } catch {
                    /* fail-open — leave predictedSeq=-1; post-stream UPDATE corrects it */
                  }
                  persistToolCallWriteAhead(
                    this.session.id,
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
                  if (this.session) {
                    logInteraction(this.session.id, "tool_call", {
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
                } catch {
                  /* fail-open */
                }

                // Pitfall 9: settle the pending call log entry.
                if (this.pendingCalls) {
                  const pending = activeToolCalls.find((t) => t.id === part.toolCallId);
                  const callId = (pending as ToolCall & { _pendingCallId?: string })?._pendingCallId;
                  if (callId) {
                    const endStatus = signal.aborted ? "aborted" : "settled";
                    void this.pendingCalls.end(callId, endStatus).catch(() => {});
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
                    session_id: this.session?.id,
                    cwd: this.bash.getCwd(),
                  };
                  await this.fireHook(postInput, signal).catch(() => {});
                }

                // Response tool: yield as structured_response instead of tool_result.
                // AI SDK v5 wraps tool outputs as `{type:"json", value:{...}}`; unwrap
                // to expose the schema-shaped payload to the UI renderer.
                if (isResponseTool(part.toolName)) {
                  responseToolCalled = true;
                  const taskType = getResponseTaskType(part.toolName);
                  const rawOutput = part.output as unknown;
                  const unwrapped =
                    rawOutput && typeof rawOutput === "object" && (rawOutput as { type?: string }).type === "json"
                      ? ((rawOutput as { value?: unknown }).value ?? {})
                      : (rawOutput ?? {});
                  yield {
                    type: "structured_response" as StreamChunk["type"],
                    structuredResponse: {
                      taskType: taskType ?? part.toolName,
                      data: unwrapped as Record<string, unknown>,
                    },
                  };
                  notifyObserver(observer?.onToolFinish, { toolCall: tc, toolResult: tr, timestamp: Date.now() });
                  break;
                }

                notifyObserver(observer?.onToolFinish, {
                  toolCall: tc,
                  toolResult: tr,
                  timestamp: Date.now(),
                });
                // Interaction log: tool result
                try {
                  if (this.session) {
                    const outputPreview =
                      typeof tr.output === "string" ? tr.output.slice(0, 200) : JSON.stringify(tr.output).slice(0, 200);
                    logInteraction(this.session.id, "tool_result", {
                      eventSubtype: tc.function.name,
                      data: { success: tr.success, outputPreview },
                    });
                  }
                } catch {
                  /* fail-open */
                }
                yield { type: "tool_result", toolCall: tc, toolResult: tr };
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
                if (this.pendingCalls) {
                  const pending = activeToolCalls.find((t) => t.id === errPart.toolCallId);
                  const callId = (pending as ToolCall & { _pendingCallId?: string })?._pendingCallId;
                  if (callId) void this.pendingCalls.end(callId, "settled").catch(() => {});
                }

                // Phase A4: mark the write-ahead tool_calls row as `errored`.
                // The post-stream appendMessages() path does NOT see tool-error
                // parts in the assistant message content (the SDK doesn't emit
                // them there), so without this explicit update the row would
                // remain `pending` after a clean tool failure.
                if (this.session) {
                  markToolCallErrored(this.session.id, errPart.toolCallId, errMsg);
                }

                // Fire PostToolUseFailure so EE judge can record IGNORED outcome.
                {
                  const failInput: PostToolUseFailureHookInput = {
                    hook_event_name: "PostToolUseFailure",
                    tool_name: errPart.toolName,
                    tool_input: (errPart.input as Record<string, unknown>) ?? {},
                    error: errMsg,
                    session_id: this.session?.id,
                    cwd: this.bash.getCwd(),
                  };
                  await this.fireHook(failInput, signal).catch(() => {});
                }

                try {
                  if (this.session) {
                    logInteraction(this.session.id, "tool_result", {
                      eventSubtype: errPart.toolName,
                      data: { success: false, error: errMsg.slice(0, 500), reason: "tool-error" },
                    });
                  }
                } catch {
                  /* fail-open */
                }

                notifyObserver(observer?.onToolFinish, { toolCall: tc, toolResult: tr, timestamp: Date.now() });
                yield { type: "tool_result", toolCall: tc, toolResult: tr };
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
                if (!toolNeedsApproval(toolName, this.permissionMode)) {
                  // Auto-approve: respond directly without surfacing to UI.
                  this.respondToToolApproval(approvalPart.approvalId, true);
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
                const friendly = humanizeApiError(part.error);
                notifyObserver(observer?.onError, {
                  message: friendly,
                  timestamp: Date.now(),
                });
                // Interaction log: error
                try {
                  if (this.session) {
                    logInteraction(this.session.id, "error", {
                      eventSubtype: authError ? "auth" : "api",
                      data: { message: friendly.slice(0, 200) },
                    });
                  }
                } catch {
                  /* fail-open */
                }
                yield {
                  type: "error",
                  content: friendly,
                  isAuthError: authError,
                };
                break;
              }

              case "abort":
                yield { type: "content", content: "\n\n[Cancelled]" };
                break;
            }
          }

          // ─── SAMR Phase 1 → Phase 2 transition ─────────────────────────
          // Phase 1 (premium model) produced tool calls but the SDK stopped
          // before executing them (stopWhen: stepCountIs(1)). Append the
          // assistant message to this.messages and restart the loop with
          // the fast execution model. Phase 2's streamText call will see
          // the pending tool calls and execute them automatically.
          if (stepRouterPhase === "phase1" && phase1HadToolCalls) {
            try {
              const phase1Response = await result.response;
              // Append only new messages (assistant message with tool calls)
              const newMsgs = phase1Response.messages.slice(this.messages.length);
              for (const msg of newMsgs) {
                if (msg.role === "assistant") {
                  this.messages.push(msg);
                }
              }
            } catch {
              // If response extraction fails, fall through to normal completion
            }
            stepRouterPhase = "phase2";
            continue; // Re-enter while loop with Phase 2 (fast) model
          }

          if (signal.aborted) {
            this.discardAbortedTurn(userModelMessage);
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
              this.appendCompletedTurn(userModelMessage, sanitizeModelMessages(scrubbed));
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
            this.discardAbortedTurn(userModelMessage);
            yield { type: "done" };
            return;
          }

          if (!streamOk && assistantText.trim()) {
            this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
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

          // Interaction log: agent response complete
          try {
            if (this.session) {
              const sb = statusBarStore.getState();
              const turnDurationMs = Date.now() - turnStartMs;
              logInteraction(this.session.id, "agent_response", {
                model: turnModelId,
                inputTokens: sb.in_tokens,
                outputTokens: sb.out_tokens,
                durationMs: turnDurationMs,
                data: {
                  textLength: assistantText.length,
                  toolCallCount: activeToolCalls.length,
                  compacted: this._compactedThisTurn,
                },
              });
            }
          } catch {
            /* fail-open */
          }

          const stopInput: StopHookInput = {
            hook_event_name: "Stop",
            session_id: this.session?.id,
            cwd: this.bash.getCwd(),
          };
          await this.fireHook(stopInput, signal).catch(() => {});

          // Debug trace: emit pipeline summary
          if (_debugOn) {
            const sb = statusBarStore.getState();
            const defaultInfo = getModelInfo(this.modelId);
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
              model_requested: this.modelId,
              model_used: turnModelId,
              routed: turnModelId !== this.modelId,
              input_tokens: sb.in_tokens,
              output_tokens: sb.out_tokens,
              cache_read_tokens: sb.cache_read_tokens,
              cost_usd: sb.session_usd,
              estimated_savings: {
                pil_tokens_saved: this._pilEnrichmentDelta > 0 ? this._pilEnrichmentDelta : 0,
                cache_tokens_saved: sb.cache_read_tokens,
                router_cost_saved_usd: routerSaved,
                total_tokens_saved:
                  (this._pilEnrichmentDelta > 0 ? this._pilEnrichmentDelta : 0) + sb.cache_read_tokens,
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
            await this.postTurnCompact(provider, system, modelInfo.contextWindow, signal);
          }
          yield { type: "done" };
          return;
        } catch (err: unknown) {
          if (signal.aborted) {
            this.discardAbortedTurn(userModelMessage);
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

          // Transient network/server error retry — up to MAX_STREAM_RETRIES extra attempts.
          // Only retry when no content has flowed yet (assistantText empty) to avoid
          // partial-output corruption. Honour the abort signal between retries.
          if (!assistantText.trim() && streamRetryCount < MAX_STREAM_RETRIES && !signal.aborted) {
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
                if (this.session) {
                  logInteraction(this.session.id, "stream_retry", {
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
          const friendly = humanizeApiError(err);
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
            this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
          } else if (this.session && userWriteAheadSeq != null) {
            // Phase A5 — Stream threw before producing assistant text. The
            // write-ahead user row is stuck at `status='pending'`. Mark it
            // errored so forensics + recovery can distinguish "in-flight"
            // from "crashed mid-flight".
            markMessageErrored(this.session.id, userWriteAheadSeq);
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
            session_id: this.session?.id,
            cwd: this.bash.getCwd(),
          };
          await this.fireHook(stopFailureInput, signal).catch(() => {});

          if (modelInfo?.contextWindow) {
            await this.postTurnCompact(provider, system, modelInfo.contextWindow, signal);
          }
          yield { type: "done" };
          return;
        } finally {
          await closeMcp?.().catch(() => {});
        }
      }
    } finally {
      if (this.abortController?.signal === signal) {
        this.abortController = null;
      }
    }
  }

  // ========================================================================
  // Private helper methods — summary, estimation, verify
  // ========================================================================

  private _buildRecentTurnsSummary(): string | null {
    if (this.messages.length < 2) return null;
    const recent = this.messages.slice(-6);
    const parts: string[] = [];
    for (const msg of recent) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p: { type: string }) => p.type === "text")
                .map((p: { type: string; text?: string }) => p.text ?? "")
                .join("")
            : "";
      if (!text) continue;
      const snippet = text.length > 80 ? `${text.slice(0, 77)}...` : text;
      parts.push(`[${msg.role}]: ${snippet}`);
    }
    return parts.length > 0 ? parts.join(" | ") : null;
  }

  private _estimateProjectSize(): "small" | "medium" | "large" | null {
    try {
      const fs = require("fs");
      const path = require("path");
      const cwd = this.bash.getCwd();
      const srcDir = path.join(cwd, "src");
      if (!fs.existsSync(srcDir)) return null;
      let count = 0;
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          if (entry.isDirectory()) walk(path.join(dir, entry.name));
          else if (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(entry.name)) count++;
          if (count > 200) return;
        }
      };
      walk(srcDir);
      if (count <= 20) return "small";
      if (count <= 100) return "medium";
      return "large";
    } catch {
      return null;
    }
  }

  private _countFilesTouched(): number {
    let count = 0;
    for (const msg of this.messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if ((part as { type: string }).type === "tool-call") {
          const tc = part as { type: string; toolName?: string; args?: Record<string, unknown> };
          if (tc.toolName === "write_file" || tc.toolName === "edit_file" || tc.toolName === "bash") count++;
        }
      }
    }
    return count;
  }

  private requireProvider(): LegacyProvider {
    if (!this.provider) {
      throw new Error("API key required. Add an API key to continue.");
    }

    return this.provider;
  }

  /**
   * One-shot async init: upgrades the OpenAI provider to use OAuth tokens when
   * stored tokens are available and no explicit API key was supplied by the user.
   * Called at the start of processMessage so the first real LLM call benefits
   * from OAuth without requiring a sync constructor change.
   *
   * Idempotent: skips on second call and for non-OpenAI providers.
   * Fail-open: any error leaves the existing provider untouched.
   */
  private async _initOAuthProvider(): Promise<void> {
    if (this._oauthInitDone) return;
    this._oauthInitDone = true;

    // Only upgrade when there is no explicit API key — OAuth is an alternative
    // auth path, not an override when the user deliberately passed a key.
    // The boot wizard in src/index.ts uses the literal "oauth" as a sentinel
    // to signal "no API key but OAuth tokens exist", so treat that as "no
    // key" here.
    if (this.apiKey && this.apiKey !== "oauth") return;

    try {
      const { listOAuthProviderIds } = await import("../providers/auth/registry.js");
      const ids = await listOAuthProviderIds();
      if (!ids.includes(this.providerId)) return;

      const effectiveBaseURL =
        this.baseURL &&
        this.baseURL !== (await import("../providers/endpoints.js").then((m) => m.apiBaseFor("anthropic")))
          ? this.baseURL
          : undefined;
      const result = await createProviderFactoryAsync(this.providerId, {
        baseURL: effectiveBaseURL ?? undefined,
      });
      this.provider = result.factory;
    } catch {
      // Fail-open — provider remains null; requireProvider() will surface the error
    }
  }

  async detectVerifyRecipe(settings?: SandboxSettings, abortSignal?: AbortSignal): Promise<VerifyRecipe | null> {
    try {
      const result = await this.runTaskRequest(
        {
          agent: "verify-detect",
          description: "Detect verification recipe",
          prompt: buildVerifyDetectPrompt(this.bash.getCwd(), settings ?? this.bash.getSandboxSettings()),
        },
        undefined,
        abortSignal,
      );
      if (!result.success || !result.output) return null;
      const maybeJson = extractJsonObject(result.output);
      if (!maybeJson) return null;
      return normalizeVerifyRecipe(JSON.parse(maybeJson));
    } catch {
      return null;
    }
  }

  async runVerify(onProgress?: (detail: string) => void, abortSignal?: AbortSignal): Promise<ToolResult> {
    this.abortController = new AbortController();
    const signal = abortSignal ?? this.abortController.signal;
    const userModelMessage: ModelMessage = { role: "user", content: "/verify" };
    this.messages.push(userModelMessage);
    this.messageSeqs.push(null);

    try {
      await this.consumeBackgroundNotifications();
      const result = await runVerifyOrchestration(this, { onProgress, abortSignal: signal });
      const assistantText = result.output || result.error || "Verification completed.";
      this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const failureText = signal.aborted ? "Verification aborted." : `Verification failed: ${msg}`;
      this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: failureText }]);
      return { success: false, output: failureText };
    } finally {
      if (this.abortController?.signal === signal) {
        this.abortController = null;
      }
    }
  }
}
