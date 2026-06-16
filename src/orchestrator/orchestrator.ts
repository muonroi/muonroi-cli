// Multi-provider wired — runtime dispatch via providers/runtime.ts.

import type { ModelMessage, ToolSet } from "ai";
import { extractSession } from "../ee/extract-session.js";
import {
  bootstrapEEClient,
  getDefaultEEClient,
  getLastSurfacedState,
  updateLastSurfacedState,
} from "../ee/intercept.js";
import { getTenantId } from "../ee/tenant.js";
import { emitTranscriptToDisk } from "../ee/transcript-emit.js";
import { createRun, getActiveRunId, setActiveRunId } from "../flow/run-manager.js";
import { ensureFlowDir } from "../flow/scaffold.js";
import { executeEventHooks } from "../hooks/index";
import type {
  NotificationHookInput,
  PostCompactHookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TaskCompletedHookInput,
  TaskCreatedHookInput,
} from "../hooks/types";
import { shutdownWorkspaceLspManager } from "../lsp/runtime";
import { ensureDefaultMcpServers } from "../mcp/auto-setup.js";
import { getModelInfo, normalizeModelId } from "../models/registry.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { apiBaseFor } from "../providers/endpoints.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import {
  createProviderFactory,
  createProviderFactoryAsync,
  detectProviderForModel,
  requireRuntimeProvider,
  resolveModelRuntime as resolveRuntime,
} from "../providers/runtime.js";
import { ALL_PROVIDER_IDS, type ProviderId } from "../providers/types.js";
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
  recordUsageEvent,
  SessionStore,
} from "../storage/index.js";
import { BashTool } from "../tools/bash";
import { createBuiltinTools } from "../tools/registry.js";
import { type ScheduleDaemonStatus, ScheduleManager, type StoredSchedule } from "../tools/schedule";
import type {
  AgentMode,
  ChatEntry,
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
import { statusBarStore } from "../ui/status-bar/store.js";
import { appendCostLog } from "../usage/cost-log.js";
import { appendDecisionLog } from "../usage/decision-log.js";
import { projectCostUSD } from "../usage/estimator.js";
import type { PermissionMode } from "../utils/permission-mode.js";
import {
  type CustomSubagentConfig,
  getAutoCompactThresholdPct,
  getCouncilRounds,
  getCurrentModel,
  getCurrentShellSettings,
  getModeSpecificModel,
  getRoleModel,
  getRoleModels,
  isAutoCompactAfterTurnEnabled,
  isCouncilMultiProviderPreferred,
  isProviderDisabled,
  type ModelRole,
  type SandboxMode,
  type SandboxSettings,
} from "../utils/settings";
import { runSideQuestion, type SideQuestionResult } from "../utils/side-question";
import { buildVerifyDetectPrompt, normalizeVerifyRecipe } from "../verify/entrypoint";
import { runVerifyOrchestration } from "../verify/orchestrator";
import {
  type AgentOptions,
  type BatchChatCompletionResponse,
  type BatchClientOptions,
  type BatchFunctionTool,
  COUNCIL_COLOR_BG,
  COUNCIL_COLOR_RESET,
  COUNCIL_ROLE_COLORS,
  type LegacyProvider,
  type ProcessMessageObserver,
  type ProcessMessageUsage,
  type ResolvedModelRuntime,
} from "./agent-options";
import { BatchTurnRunner, type BatchTurnRunnerDeps } from "./batch-turn-runner.js";
import {
  accumulateUsage,
  buildAssistantBatchMessage,
  buildBatchChatCompletionRequest,
  buildBatchName,
  buildToolBatchMessage,
  type ExecutedBatchTool,
  extractJsonObject,
  getBatchUsage,
  hasUsage,
  parseToolArgumentsOrRaw,
  toLocalToolCall,
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
  shouldCompactContext,
} from "./compaction";
import { CouncilManager } from "./council-manager.js";
import { CrossTurnDedup, isCrossTurnDedupEnabled } from "./cross-turn-dedup.js";
import { DelegationManager } from "./delegations";
import { loadFlowResumeDigest } from "./flow-resume.js";
import { MessageProcessor, type MessageProcessorDeps } from "./message-processor.js";
import { lastPersistedSeq } from "./message-seq.js";
import { buildSystemPrompt, MAX_TOOL_ROUNDS } from "./prompts";
import { getReadPathBudgetCap, ReadPathBudget } from "./read-path-budget.js";
import { withStreamRetry } from "./retry-stream.js";
import { StreamRunner, type StreamRunnerDeps } from "./stream-runner.js";
import { type ModelTaskKind, resolveModelForTask } from "./sub-agent-model-tier.js";
import { setProviderHint } from "./token-counter.js";
import type { ToolLoopCapAsk } from "./tool-loop-cap.js";
import { firstLine, formatSubagentActivity, toToolResult } from "./tool-utils";

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
 * True iff `url` equals the default apiBase of ANY registered provider.
 * Used to detect stale carryover of one provider's default URL into another
 * provider's factory after a /model switch (see setModel + setApiKey).
 */
function isAnyProviderApiBase(url: string | null | undefined): boolean {
  if (!url) return false;
  for (const id of ALL_PROVIDER_IDS) {
    if (url === apiBaseFor(id)) return true;
  }
  return false;
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
  return Promise.resolve({ title, modelId: getCurrentModel() });
}

/**
 * Resolve a model ID to a runnable AI SDK LanguageModel.
 * Uses the Anthropic provider factory created by createProvider().
 */
function resolveModelRuntime(provider: LegacyProvider, modelId: string): ResolvedModelRuntime {
  return resolveRuntime(provider, modelId);
}

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

// ---------------------------------------------------------------------------
// END Plan 00-05 provider implementations
// (Phase 12.3 — `buildVisionUserMessages` was inlined into StreamRunner;
// vision is an anti-feature per PROJECT.md Out-of-Scope so the helper is gone.)
// ---------------------------------------------------------------------------

// ============================================================================
// Agent class — fields, constructor, session management, core processing loop
// ============================================================================

export class Agent {
  private provider: LegacyProvider | null = null;
  private providerId: ProviderId = null!;
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
  /** Per-call correlation id for top-level streamText; set in MessageProcessor, consumed by recordUsage / onFinish llm-done. */
  private _currentCallId = "";
  /** P0 native observation: first 200 chars of the user's current turn — sent as intent_context.userGoalExcerpt to PreToolUse. */
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
      // Drop this.baseURL when it points at a DIFFERENT provider's default
      // apiBase — otherwise the rebuilt factory binds the new provider's
      // strategy to the OLD provider's URL, sending requests to the wrong
      // host. Evidence: session 2492d6579b1d — user switched defaultProvider
      // siliconflow→ (via UI), this.baseURL was still api.deepseek.com from
      // startup, SiliconflowStrategy.createFactory was created with that
      // baseURL, requests landed at api.deepseek.com which rejected the SF-
      // style model id ("deepseek-ai/DeepSeek-V4-Flash") with "supported API
      // model names are deepseek-v4-pro or deepseek-v4-flash".
      // A user-supplied custom baseURL is preserved only when it does NOT
      // match any known provider's apiBase (i.e. it's a real override, not
      // a stale default).
      const staleBaseURL = isAnyProviderApiBase(this.baseURL) && this.baseURL !== apiBaseFor(this.providerId);
      const effectiveBaseURL = staleBaseURL ? undefined : (this.baseURL ?? undefined);
      if (staleBaseURL) this.baseURL = null;
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
    // Drop baseURL when it points at a DIFFERENT provider's default apiBase
    // (e.g. caller passed the legacy anthropic URL while providerId is
    // siliconflow — without this we'd send siliconflow requests to
    // api.anthropic.com or similar). User-supplied custom URLs that don't
    // match any known provider's apiBase are preserved as real overrides.
    const stale = isAnyProviderApiBase(baseURL) && baseURL !== apiBaseFor(this.providerId);
    const effectiveBaseURL = stale ? undefined : baseURL;
    this.baseURL = stale ? null : baseURL || null;
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
    // Slow-path sidecar — write transcript to disk SYNCHRONOUSLY before
    // racing the async HTTP extract. Survives X-close + EE-offline.
    try {
      emitTranscriptToDisk(this.messages, this.getSessionId(), "cli-exit", this.bash.getCwd());
    } catch {
      /* fail-open */
    }
    await Promise.allSettled([
      this.bash.cleanup(),
      shutdownWorkspaceLspManager(this.bash.getCwd()),
      extractSession(this.messages, this.bash.getCwd(), "cli-exit", this.getSessionId()),
      // Tear down pooled MCP clients (client-pool.ts). They persist across turns
      // by design (no per-turn cold-spawn), so the only real teardown is here at
      // session end. Stdio children would die with the process anyway, but close
      // them gracefully on a clean exit.
      import("../mcp/client-pool.js").then((m) => m.closeAllMcpClients()),
    ]);
  }

  // Tool-loop cap handler — set by the UI (app.tsx) at startup. Invoked from
  // the message-processor streamText loop when stepCount reaches the current
  // cap. The UI surfaces an askcard ("Continue +50? / Stop and answer") and
  // resolves with the verdict. When unset, the loop stops gracefully — no
  // hard-throw, matches the user-friendly behaviour we promised.
  private _toolLoopCapHandler: ToolLoopCapAsk | null = null;

  setToolLoopCapHandler(fn: ToolLoopCapAsk | null): void {
    this._toolLoopCapHandler = fn;
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
    try {
      emitTranscriptToDisk(this.messages, this.getSessionId(), "cli-clear", this.bash.getCwd());
    } catch {
      /* fail-open */
    }
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
    // Collapse double startNewSession() calls into a single row. The current
    // session is REUSED (not orphaned with a fresh createSession) when it is
    // brand-new and empty — no persisted messages in memory AND no title.
    // Root cause of ~60% orphaned session rows (1187/1966): the /clear slash
    // path calls clearHistory() — which already starts a new session — and then
    // resetToNewSession(), which started ANOTHER. The first session never
    // received any work and was left title-less and empty. The first call here
    // still sees the prior conversation in `this.messages` (non-empty → new
    // row, correct); the immediate second call sees the just-cleared empty
    // session and reuses it instead of creating a twin.
    const cur = this.session;
    if (cur && this.messages.length === 0 && !cur.title) {
      this.messageSeqs = [];
      return this.getSessionSnapshot();
    }
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
    const idx = this.messageSeqs.indexOf(seq);
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
    /**
     * Phase O1 — the providerOptions shape of the call that produced THIS event,
     * threaded explicitly per call. Multi-step turns emit one event per step and
     * a `task` sub-agent can run mid-turn, so a single mutable
     * `_lastProviderOptionsShape` corrupted later events (the clear nulled it
     * after step 1; an interleaved task overwrote it). When omitted (title /
     * other one-shot calls that set no shape), fall back to the mutable field,
     * which is cleared after each message event so they record null, not stale.
     */
    providerOptionsShape?: string | null,
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
      // options did this billed call carry?". Prefer the explicitly-threaded
      // shape (correct per-event, immune to the clear + task interleaving);
      // fall back to the mutable field only when the caller passed nothing
      // (title / other), which is cleared below so they record null, not stale.
      const resolvedShape = providerOptionsShape !== undefined ? providerOptionsShape : this._lastProviderOptionsShape;
      recordUsageEvent(this.session.id, source, model, usage, lastSeq, pilActive, enrichmentDelta, resolvedShape);
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
    // F5 — ctx_tokens reflects the CURRENT call's input size (≈ context
    // window usage), not cumulative. Lets the user see "how full is my
    // window" instead of "how much have I billed in total this session".
    // Pair with context-fill % derived from model contextWindow.
    const ctxWindow = info?.contextWindow ?? 0;
    const ctxPct = ctxWindow > 0 ? Math.min(100, Math.round((totalInput / ctxWindow) * 100)) : undefined;
    statusBarStore.setState({
      in_tokens: prev.in_tokens + totalInput,
      out_tokens: prev.out_tokens + output,
      cache_read_tokens: (prev.cache_read_tokens ?? 0) + cacheRead,
      cache_creation_tokens: (prev.cache_creation_tokens ?? 0) + cacheCreate,
      session_usd: prev.session_usd + turnCostMicros / 1_000_000,
      provider: this.providerId,
      model,
      ctx_tokens: totalInput,
      ctx_pct: ctxPct,
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

    const childCaps = getProviderCapabilities(requireRuntimeProvider(childRuntime));
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
      recordUsage: (usage, source, model, shape) => this.recordUsage(usage, source, model, shape),
      setCurrentCallId: (id) => {
        this._currentCallId = id;
      },
      setLastProviderOptionsShape: (shape) => {
        this._lastProviderOptionsShape = shape;
      },
      getSessionId: () => this.session?.id,
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

  private _resolveModelForTask(task: ModelTaskKind): string {
    return resolveModelForTask(task, this.providerId, this.modelId);
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

    // Emit pre-compact transcript snapshot so lessons survive the rewrite.
    try {
      emitTranscriptToDisk(this.messages, this.session?.id ?? null, "cli-compact", this.bash.getCwd());
    } catch {
      /* fail-open */
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
      const idx = this.messageSeqs.indexOf(seq);
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

    // EE anti-mù (Phase 1 of docs/ee-anti-mu-compaction-plan.md): immediately extract the fresh structured checkpoint summary
    // so pilContext / layer3 search / ee.query can recall exact prior ✔ DONE items + progress for the rest of this long session
    // (and sub-agents) even after further B3/B4 rewrites. Uses same client + fail-open pattern as promptStale above (1449).
    // Transcript is the summary itself (not full history) to keep it small and focused on task state.
    getDefaultEEClient()
      .extract(
        {
          transcript: `[Context checkpoint summary]\n${summary}`,
          projectPath: this.bash.getCwd(),
          meta: {
            source: "cli-compact-checkpoint",
            sessionId: this.session?.id ?? undefined,
            iteration: this._compactionStats.count + 1,
            tokensBefore: preparation.tokensBefore,
          },
        },
        AbortSignal.timeout(1500),
      )
      .catch(() => {});

    // Mark as surfaced for prompt-stale reconciliation (per plan Phase 1).
    updateLastSurfacedState([`compact-checkpoint-${this._compactionStats.count + 1}`]);

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
        budgetTokens?: number;
        stack?: string;
        noCustomerDebate?: boolean;
        noPriorContext?: boolean;
        forceCouncil?: boolean;
        mode?: "maintain" | "new";
        ghPr?: boolean;
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
        budgetTokens: payload.flags.budgetTokens,
        stack: payload.flags.stack,
        forceCouncil: payload.flags.forceCouncil,
      },
      respondToQuestion: this.councilManager.createQuestionResponder(),
      respondToPreflight: this.councilManager.createPreflightResponder(),
      cwd: this.bash.getCwd(),
      processMessageFn,
      // Mode C — wire verify-recipe detector so runProductLoop auto-detect can probe cwd.
      detectVerifyRecipe: () => this.detectVerifyRecipe(),
      skipPriorContext: payload.flags.noPriorContext === true,
      complexity,
      sufficiencyMissing,
      // Mode C explicit override + gh pr create opt-in (see .planning/MAINTAIN-MODE.md).
      mode: payload.flags.mode,
      ghPr: payload.flags.ghPr === true,
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
    _observer?: ProcessMessageObserver,
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
      yield { type: "content", content: `${readablePart || synthesisText}\n` };

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
  // processMessageBatchTurn — batch API message processing loop.
  // Body extracted into BatchTurnRunner (Phase 12.5). Thin wrapper preserved
  // so MessageProcessorDeps' `processMessageBatchTurn` callback continues to
  // dispatch through `Agent.processMessageBatchTurn` unchanged.
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
    const runner = new BatchTurnRunner(this._buildBatchTurnRunnerDeps());
    yield* runner.run(args);
  }

  /**
   * Build the DI surface BatchTurnRunner (Phase 12.5) needs to reach back
   * into Agent state without holding a circular reference. Callback names
   * align with `MessageProcessorDeps` where the signature matches so a
   * future `TurnRunnerDepsBase` hoist is mechanical. Built per call —
   * allocation cost is negligible against the batch polling spend.
   */
  private _buildBatchTurnRunnerDeps(): BatchTurnRunnerDeps {
    const self = this;
    return {
      get messages() {
        return self.messages;
      },
      get bash() {
        return self.bash;
      },
      get mode() {
        return self.mode;
      },
      get maxToolRounds() {
        return self.maxToolRounds;
      },
      get maxTokens() {
        return self.maxTokens;
      },
      get schedules() {
        return self.schedules;
      },
      get sendTelegramFile() {
        return self.sendTelegramFile;
      },
      getSessionId: () => self.session?.id ?? null,
      getCompactedThisTurn: () => self._compactedThisTurn,
      setCompactedThisTurn: (v) => {
        self._compactedThisTurn = v;
      },
      setLastProviderOptionsShape: (shape) => {
        self._lastProviderOptionsShape = shape;
      },
      getBatchClientOptions: (signal) => self.getBatchClientOptions(signal),
      getCompactionSettings: (cw) => self.getCompactionSettings(cw),
      compactForContext: (provider, system, cw, signal, settings, overflow) =>
        self.compactForContext(provider, system, cw, signal, settings, overflow),
      postTurnCompact: (provider, system, cw, signal) => self.postTurnCompact(provider, system, cw, signal),
      createTools: (bash, provider, mode, opts) => createTools(bash, provider, mode, opts),
      runTask: (request, signal) => self.runTask(request, signal),
      runDelegation: (request, signal) => self.runDelegation(request, signal),
      readDelegation: (id) => self.readDelegation(id),
      listDelegations: () => self.listDelegations(),
      executeBatchToolCall: (tools, toolCall, messages, signal) =>
        self.executeBatchToolCall(tools, toolCall, messages, signal),
      appendCompletedTurn: (user, asst) => self.appendCompletedTurn(user, asst),
      discardAbortedTurn: (user) => self.discardAbortedTurn(user),
      recordUsage: (usage, source, model, shape) => self.recordUsage(usage, source, model, shape),
    };
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
    const processor = new MessageProcessor(this._buildMessageProcessorDeps());
    yield* processor.run(userMessage, observer, images);
  }

  /**
   * Build the DI surface MessageProcessor (Phase 12.4) needs to reach back
   * into Agent state without holding a circular reference. Exposes array
   * references for in-place mutation (messages/messageSeqs) and bound
   * callbacks for behavior. Built per call — allocation cost is negligible
   * against the streamText spend.
   */
  private _buildMessageProcessorDeps(): MessageProcessorDeps {
    const self = this;
    return {
      get messages() {
        return self.messages;
      },
      get messageSeqs() {
        return self.messageSeqs;
      },
      get session() {
        return self.session;
      },
      get sessionStore() {
        return self.sessionStore;
      },
      get bash() {
        return self.bash;
      },
      get mode() {
        return self.mode;
      },
      get modelId() {
        return self.modelId;
      },
      get providerId() {
        return self.providerId;
      },
      get maxToolRounds() {
        return self.maxToolRounds;
      },
      get batchApi() {
        return self.batchApi;
      },
      get permissionMode() {
        return self.permissionMode;
      },
      get schedules() {
        return self.schedules;
      },
      get sendTelegramFile() {
        return self.sendTelegramFile;
      },
      get externalAbortContext() {
        return self.externalAbortContext;
      },
      get pendingCalls() {
        return self.pendingCalls;
      },
      get councilManager() {
        return self.councilManager;
      },
      get crossTurnDedup() {
        return self._crossTurnDedup;
      },
      get readBudget() {
        return self._readBudget;
      },
      get priorWarningIdsInSession() {
        return self._priorWarningIdsInSession;
      },
      get sessionEEGuidance() {
        return self._sessionEEGuidance;
      },
      get flowReady() {
        return self._flowReady;
      },
      getAbortController: () => self.abortController,
      setAbortController: (c) => {
        self.abortController = c;
      },
      getSessionStartHookFired: () => self.sessionStartHookFired,
      setSessionStartHookFired: (v) => {
        self.sessionStartHookFired = v;
      },
      getPlanContext: () => self.planContext,
      setPlanContext: (v) => {
        self.planContext = v;
      },
      getResumeDigest: () => self._resumeDigest,
      setResumeDigest: (v) => {
        self._resumeDigest = v;
      },
      getActiveRunId: () => self._activeRunId,
      getPendingCwdNote: () => self._pendingCwdNote,
      setPendingCwdNote: (v) => {
        self._pendingCwdNote = v;
      },
      setPilActive: (v) => {
        self._pilActive = v;
      },
      setPilEnrichmentDelta: (n) => {
        self._pilEnrichmentDelta = n;
      },
      setCurrentCallId: (id) => {
        self._currentCallId = id;
      },
      setLastProviderOptionsShape: (shape) => {
        self._lastProviderOptionsShape = shape;
      },
      setLastPromptBreakdown: (b) => {
        self._lastPromptBreakdown = b;
      },
      setCompactedThisTurn: (v) => {
        self._compactedThisTurn = v;
      },
      getCompactedThisTurn: () => self._compactedThisTurn,
      setTurnUserGoalExcerpt: (v) => {
        self._turnUserGoalExcerpt = v;
      },
      setTurnAssistantReasoning: (v) => {
        self._turnAssistantReasoning = v;
      },
      appendTurnAssistantReasoning: (delta) => {
        self._turnAssistantReasoning = (self._turnAssistantReasoning + delta).slice(-400);
      },
      getTurnAssistantReasoning: () => self._turnAssistantReasoning,
      setPriorWarningIdsInSession: (s) => {
        self._priorWarningIdsInSession = s;
      },
      setMessages: (m) => {
        self.messages = m;
      },
      requireProvider: () => self.requireProvider(),
      emitSubagentStatus: (s) => self.emitSubagentStatus(s),
      fireHook: (input, signal) =>
        self.fireHook(input as Parameters<Agent["fireHook"]>[0], signal) as ReturnType<
          MessageProcessorDeps["fireHook"]
        >,
      consumeBackgroundNotifications: () => self.consumeBackgroundNotifications(),
      initOAuthProvider: () => self._initOAuthProvider(),
      buildRecentTurnsSummary: () => self._buildRecentTurnsSummary(),
      estimateProjectSize: () => self._estimateProjectSize(),
      countFilesTouched: () => self._countFilesTouched(),
      getCompactionSettings: (cw) => self.getCompactionSettings(cw),
      compactForContext: (provider, system, cw, signal, settings, overflow) =>
        self.compactForContext(provider, system, cw, signal, settings, overflow),
      postTurnCompact: (provider, system, cw, signal) => self.postTurnCompact(provider, system, cw, signal),
      runTask: (request, signal) => self.runTask(request, signal),
      runDelegation: (request, signal) => self.runDelegation(request, signal),
      readDelegation: (id) => self.readDelegation(id),
      listDelegations: () => self.listDelegations(),
      appendCompletedTurn: (user, asst) => self.appendCompletedTurn(user, asst),
      discardAbortedTurn: (user) => self.discardAbortedTurn(user),
      recordUsage: (usage, source, model, shape) => self.recordUsage(usage, source, model, shape),
      respondToToolApproval: (id, ok) => self.respondToToolApproval(id, ok),
      askToolLoopContinue: async (info) => {
        const h = self._toolLoopCapHandler;
        if (!h) return "stop";
        try {
          return await h(info);
        } catch (err) {
          console.error(`[Agent] askToolLoopContinue crashed: ${(err as Error)?.message ?? err}`);
          return "stop";
        }
      },
      runCouncilV2: (msg, opts) => self.runCouncilV2(msg, opts),
      processMessage: (msg, obs, imgs) => self.processMessage(msg, obs, imgs),
      processMessageBatchTurn: (args) => self.processMessageBatchTurn(args),
    };
  }

  // ========================================================================
  // processMessage body extracted into MessageProcessor (Phase 12.4).
  // The single original implementation now lives in
  // `src/orchestrator/message-processor.ts`. The thin wrapper above is the
  // only entry point.
  // ========================================================================

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
