// StreamRunner — extracted from orchestrator.ts as part of Phase 12.3.
//
// Owns the sub-agent `streamText` lifecycle that lives in `Agent.runTaskRequest`:
//   1. setup()      — resolve agent kind, prepare verify sandbox, spawn child
//                     BashTool, wire cumulative-cap + read-budget + cross-turn
//                     dedup tool wrappers, resolve child model runtime, build
//                     childSystem + childMessages, merge MCP tools (agent mode).
//   2. runStream()  — call `streamText({...})` with prepareStep (siliconflow
//                     reasoning-strip + B3 sub-agent compaction) + onFinish
//                     (C1 cache split + llm-done event), drain `fullStream`,
//                     dispatch text-delta / tool-call / debug-only finish+error.
//   3. run()        — orchestrate setup + runStream with catch (transient
//                     re-throw via classifyStreamError) and finally (MCP teardown).
//
// Zero behavioral changes — every method body mirrors the original
// `runTaskRequest` (see commit history). The DI surface (`StreamRunnerDeps`) is
// the minimum callback set needed to reach back into `Agent` state without
// holding a circular reference. Public `Agent.runTaskRequest` signature is
// unchanged and continues to be the entrypoint; internally it constructs a
// `StreamRunner` per call.
//
// Cost-leak code paths preserved here:
//   - G1 (OAuth `maxOutputTokens` drop)  — via shouldDropParam(runtime, ...)
//   - B3 (sub-agent prepareStep compaction) — compactSubAgentMessages
//   - C1 (DeepSeek cache split read)        — onFinish normalization
//   - C3 (cross-turn dedup wrap)            — wrapToolSetWithDedup
//   - F1 (sub-agent cumulative cap)         — wrapToolSetWithCap
//   - reasoning-strip (provider quirk)       — taskCaps.sanitizeHistory

import { appendFileSync } from "node:fs";
import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { recordArtifact } from "../ee/artifact-cache.js";
import { getDefaultEEClient } from "../ee/intercept.js";
import { acquireMcpTools } from "../mcp/client-pool";
import { normalizeModelId } from "../models/registry.js";
import {
  cheapModelShellLine,
  injectCheapModelPlaybook,
  injectCheapModelShellDirective,
  shouldInjectCheapModelPlaybook,
} from "../pil/cheap-model-playbook.js";
import {
  injectCheapModelWorkbook,
  shouldInjectCheapModelWorkbook,
  subagentTaskType,
} from "../pil/cheap-model-workbooks.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { getVisionGuidanceForTextOnly } from "../providers/mcp-vision-bridge.js";
import { captureToolSchemas } from "../providers/patch-zod-schema.js";
import {
  buildTurnProviderOptions,
  type ResolvedModelRuntime,
  requireRuntimeProvider,
  resolveModelRuntime,
  resolveTemperatureParam,
  shouldDropParam,
} from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { needsVisionProxy } from "../providers/vision-proxy.js";
import { wireDebug } from "../providers/wire-debug.js";
import { statusBarStore } from "../state/status-bar-store.js";
import { BashTool } from "../tools/bash";
import { createBuiltinTools } from "../tools/registry.js";
import type { AgentMode, TaskRequest, ToolResult, VerifyRecipe } from "../types/index";
import { openUrl } from "../utils/open-url.js";
import {
  getCurrentShellSettings,
  getProviderProgressTimeoutMs,
  getProviderStallTimeoutMs,
  getSubAgentBudgetChars,
  getSubAgentCompactKeepLast,
  getSubAgentCompactThresholdChars,
  loadMcpServers,
  loadValidSubAgents,
  type SandboxSettings,
} from "../utils/settings";
import { resolveShell } from "../utils/shell.js";
import { prepareVerifySandbox } from "../verify/entrypoint";
import type { LegacyProvider } from "./agent-options";
import { asNumber } from "./batch-utils";
import type { CrossTurnDedup } from "./cross-turn-dedup.js";
import { wrapToolSetWithDedup } from "./cross-turn-dedup.js";
import {
  applyModelConstraints,
  buildSubagentPrompt,
  COMPUTER_MODEL,
  findCustomSubagent,
  VISION_MODEL,
} from "./prompts";
import { extractProviderOptionsShape } from "./provider-options-shape.js";
import type { ReadPathBudget } from "./read-path-budget.js";
import { wrapToolSetWithReadBudget } from "./read-path-budget.js";
import { repairToolCallHook } from "./repair-tool-call.js";
import { classifyStreamError } from "./retry-classifier.js";
import { incSessionStep, resolveCeiling } from "./scope-ceiling.js";
import {
  attachReminderToMessages,
  buildScopeReminder,
  type ComplexitySize,
  cadenceForSize,
  shouldInjectReminder,
  shouldInjectSoftWarn,
} from "./scope-reminder.js";
import { recordCompaction, recordElision } from "./session-experience.js";
import { createStallWatchdog, STALL_ERROR_MESSAGE } from "./stall-watchdog.js";
import { wrapToolSetWithCap } from "./sub-agent-cap.js";
import { applyAnthropicPromptCaching, compactSubAgentMessages } from "./subagent-compactor.js";
import { combineAbortSignals, firstLine, formatSubagentActivity } from "./tool-utils";

/**
 * Dependency callbacks the StreamRunner needs to reach back into Agent state
 * without holding a circular reference. Mirrors the CouncilManager DI pattern.
 */
export interface StreamRunnerDeps {
  /** Current top-level provider instance (already validated). */
  getProvider(): LegacyProvider;
  /** Resolve a specific task tier's model id (uses Agent's role config). */
  resolveModelForTask(task: "compact" | "explore" | "general" | "title" | "verify"): string;
  /** Top-level model id (for routed_from telemetry). */
  getModelId(): string;
  /** Top-level provider id fallback when child runtime has no explicit provider. */
  getProviderId(): ProviderId;
  /** Top-level Bash tool (cwd + sandbox baseline). */
  getBash(): BashTool;
  /** Cap on tool rounds inside a sub-agent loop. */
  getMaxToolRounds(): number;
  /** Top-level max output tokens (capped to 8192 for sub-agents). */
  getMaxTokens(): number;
  /** Whether the batch API is enabled (delegates to Agent.runTaskRequestBatch). */
  isBatchApiEnabled(): boolean;
  /** Cross-turn dedup wrapper (C3). */
  getCrossTurnDedup(): CrossTurnDedup | null;
  /** Per-session read-path budget enforcer. */
  getReadBudget(): ReadPathBudget | null;
  /** Record usage event (C1 cache split happens in onFinish). */
  recordUsage(
    usage: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
    source: "task",
    model?: string,
    /** O1 — providerOptions shape of this sub-agent call, threaded per event. */
    providerOptionsShape?: string | null,
  ): void;
  /** Set the current call id (for forensics correlation). */
  setCurrentCallId(id: string): void;
  /** Persist the last providerOptions shape (O1 forensics). */
  setLastProviderOptionsShape(shape: string | null): void;
  /**
   * Current session id, used to derive a stable openai.promptCacheKey for the
   * sub-agent (F1 parity with the top-level turn). Returns undefined for
   * headless one-shot requests with no persisted session.
   */
  getSessionId(): string | undefined;
  /**
   * Delegate to Agent.runTaskRequestBatch when batchApi is enabled. Returning
   * the call signature inline keeps StreamRunner from importing the orchestrator.
   */
  runTaskRequestBatch(args: {
    request: TaskRequest;
    childMessages: ModelMessage[];
    childSystem: string;
    childRuntime: ResolvedModelRuntime;
    childTools: ToolSet;
    maxSteps: number;
    initialDetail: string;
    onActivity?: (detail: string) => void;
    signal?: AbortSignal;
  }): Promise<ToolResult>;
}

/**
 * Shape produced by `setup()` — everything `runStream()` needs to make the
 * `streamText` call. Exported for unit tests that exercise setup in isolation.
 */
export interface PreparedSubAgentCall {
  request: TaskRequest;
  agentKey: string;
  childMode: AgentMode;
  childBash: BashTool;
  childRuntime: ResolvedModelRuntime;
  childSystem: string;
  childMessages: ModelMessage[];
  childTools: ToolSet;
  /**
   * Per-turn providerOptions for the sub-agent streamText call. Built via
   * buildTurnProviderOptions so it carries the session-derived
   * openai.promptCacheKey (F1) on top of resolve-time defaults — not the bare
   * childRuntime.providerOptions, which has no cache key.
   */
  childProviderOptions?: Record<string, unknown>;
  initialDetail: string;
  lastActivity: string;
  maxSteps: number;
  closeMcp?: () => Promise<void>;
  /** True when caller should short-circuit to runTaskRequestBatch. */
  useBatchApi: boolean;
}

/**
 * Failure or short-circuit detected during setup (unknown agent, computer
 * agent on tool-less runtime). When present, the caller returns this directly
 * without running the stream.
 */
export interface SetupShortCircuit {
  kind: "short-circuit";
  result: ToolResult;
  closeMcp?: () => Promise<void>;
}

export type SetupOutcome = { kind: "prepared"; prepared: PreparedSubAgentCall } | SetupShortCircuit;

/**
 * Emit one sub-agent diagnostic line (MUONROI_DEBUG_SUBAGENT=1).
 *
 * Writes to the file named by MUONROI_SUBAGENT_DEBUG_LOG when set, else stderr.
 * The file sink exists because stderr is a dead end for the case this
 * diagnostic was written for: under the MCP harness the TUI runs as a child
 * whose stderr nobody reads (opentui-spawn.ts consumes only the fd3/named-pipe
 * stream), so every line went into a pipe no one drains. G1 — "Task failed: No
 * output generated" — was named, given this flag, and never diagnosed, because
 * the diagnostic could not reach whoever turned it on. Mirrors the working
 * MUONROI_COUNCIL_DEBUG_LOG sink in council/llm.ts.
 */
export function writeSubagentDebug(enabled: boolean, line: string): void {
  if (!enabled) return;
  const text = `[subagent] ${line}\n`;
  const path = process.env.MUONROI_SUBAGENT_DEBUG_LOG?.trim();
  if (!path) {
    process.stderr.write(text);
    return;
  }
  try {
    appendFileSync(path, text);
  } catch (err) {
    // Never let diagnostics become the failure. Fall back to stderr and say why.
    process.stderr.write(
      `[subagent] debug-log append failed (path=${path}): ${err instanceof Error ? err.message : String(err)}\n${text}`,
    );
  }
}

/**
 * StreamRunner — extracted sub-agent stream lifecycle.
 *
 * Lifecycle:
 *   const runner = new StreamRunner(deps);
 *   return runner.run(request, onActivity, signal);
 *
 * Individual phases (`setup`, `runStream`) are public to enable focused unit
 * tests but `run()` is the canonical entrypoint.
 */
export class StreamRunner {
  constructor(private deps: StreamRunnerDeps) {}

  /**
   * Phase 1 — resolve agent kind, prepare verify sandbox, spawn child Bash,
   * wrap tools, resolve runtime, build prompt + messages, merge MCP tools.
   * Returns either a prepared call or a short-circuit ToolResult.
   */
  async setup(
    request: TaskRequest,
    onActivity?: (detail: string) => void,
    signal?: AbortSignal,
  ): Promise<SetupOutcome> {
    const provider = this.deps.getProvider();
    const agentKey = String(request.agent);
    const isExplore = agentKey === "explore";
    const isGeneral = agentKey === "general";
    const isVision = agentKey === "vision";
    const isVerify = agentKey === "verify";
    const isVerifyDetect = agentKey === "verify-detect";
    const isVerifyManifest = agentKey === "verify-manifest";
    const isComputer = agentKey === "computer";
    const subagents = loadValidSubAgents();
    const custom =
      !isExplore && !isGeneral && !isVision && !isVerify && !isVerifyDetect && !isVerifyManifest && !isComputer
        ? findCustomSubagent(agentKey, subagents)
        : undefined;

    if (
      !isExplore &&
      !isGeneral &&
      !isVision &&
      !isVerify &&
      !isVerifyDetect &&
      !isVerifyManifest &&
      !isComputer &&
      !custom
    ) {
      const message = `Unknown sub-agent "${agentKey}". Use general, explore, vision, verify, verify-detect, verify-manifest, computer, or a configured name from ~/.muonroi-cli/user-settings.json.`;
      return {
        kind: "short-circuit",
        result: {
          success: false,
          output: message,
          task: {
            agent: agentKey,
            description: request.description,
            summary: message,
          },
        },
      };
    }

    const childMode: AgentMode = isExplore || isVerifyDetect ? "ask" : "agent";
    const verifySandboxOverrides: SandboxSettings = isVerify
      ? { allowNet: true, allowedHosts: undefined, allowEphemeralInstall: true, hostBrowserCommandsOnHost: true }
      : {};
    let verifyPreparedSettings: SandboxSettings | null = null;
    let verifyPreparedRecipe: VerifyRecipe | null = null;
    const topBash = this.deps.getBash();
    if (isVerify) {
      const prepared = await prepareVerifySandbox(
        topBash.getCwd(),
        { ...topBash.getSandboxSettings(), ...verifySandboxOverrides },
        undefined,
        onActivity,
      );
      verifyPreparedSettings = prepared.sandboxSettings;
      verifyPreparedRecipe = prepared.profile.recipe;
    }
    const childBash = new BashTool(topBash.getCwd(), {
      sandboxMode: isVerify ? topBash.getSandboxMode() : topBash.getSandboxMode(),
      sandboxSettings: isVerify
        ? (verifyPreparedSettings ?? { ...topBash.getSandboxSettings(), ...verifySandboxOverrides })
        : topBash.getSandboxSettings(),
      shellSettings: getCurrentShellSettings(),
    });

    // Resolve child model early so we can pass modelId to createBuiltinTools
    // (needed for vision-proxy tools: analyze_image / ask_vision_proxy).
    const childModelId = normalizeModelId(
      request.modelId
        ? request.modelId
        : isVision
          ? VISION_MODEL
          : isComputer
            ? COMPUTER_MODEL
            : custom
              ? custom.model
              : this.deps.resolveModelForTask(
                  isExplore ? "explore" : isVerify || isVerifyDetect || isVerifyManifest ? "verify" : "general",
                ),
    );

    // Mirror the file-local `createTools` wrapper from orchestrator.ts —
    // pass modelId so registry can inject analyze_image/ask_vision_proxy for
    // text-only child models (needsVisionProxy).
    const childBaseToolsRaw = createBuiltinTools(childBash, childMode, {
      modelId: childModelId,
      sessionId: this.deps.getSessionId(),
    });
    // Wrap with the cumulative cap so the sub-agent's tool loop cannot
    // accumulate unbounded tool_result tokens. See sub-agent-cap.ts for the
    // tiered compression schedule. The cap is per-invocation; each sub-agent
    // gets a fresh budget.
    const subAgentCapBudget = getSubAgentBudgetChars();
    const subAgentCap = wrapToolSetWithCap(childBaseToolsRaw, {
      maxCumulativeChars: subAgentCapBudget,
      // Opt-out toggle (default ON). The cap dedups identical tool outputs by
      // content hash; set MUONROI_SUBAGENT_CAP_DEDUP=0 to disable. Used by the
      // B3 compaction E2E, where the harness re-processes each tool result and
      // the self-dedup would otherwise collapse distinct reads into pointer
      // stubs before cumulative history can grow enough to trigger compaction.
      dedupRepeatOutputs: process.env.MUONROI_SUBAGENT_CAP_DEDUP !== "0",
    });
    // Phase C3: layer cross-turn dedup ON TOP of the per-invocation cap. The
    // cap sees raw output (for accurate cumulative accounting); dedup sees
    // the already-trimmed output that will actually reach the model.
    const childBaseTools = wrapToolSetWithReadBudget(
      wrapToolSetWithDedup(subAgentCap.tools, this.deps.getCrossTurnDedup()),
      this.deps.getReadBudget(),
    );
    const initialDetail = isExplore
      ? "Scanning the codebase"
      : isVerifyDetect
        ? "Detecting verification recipe"
        : isVerifyManifest
          ? "Creating verification manifest"
          : isVerify
            ? "Preparing verification pass"
            : isComputer
              ? "Preparing computer control pass"
              : "Planning delegated work";
    let lastActivity = initialDetail;
    let childTools: ToolSet = childBaseTools;
    let closeMcp: (() => Promise<void>) | undefined;
    const topModelId = this.deps.getModelId();
    if (childModelId !== topModelId) {
      statusBarStore.setState({ routed_from: topModelId, model: childModelId });
    }
    const childRuntime = isVision
      ? {
          ...resolveModelRuntime(provider, childModelId),
          model: provider.responses?.(childModelId) ?? provider(childModelId),
        }
      : resolveModelRuntime(provider, childModelId);
    const taskCaps = getProviderCapabilities(requireRuntimeProvider(childRuntime));
    if (isComputer && !taskCaps.supportsClientTools(childRuntime.modelInfo)) {
      return {
        kind: "short-circuit",
        result: {
          success: false,
          output:
            "Computer sub-agent requires a tool-capable model, but the selected runtime does not support client tools.",
          task: {
            agent: agentKey,
            description: request.description,
            summary: "Computer sub-agent could not start because the chosen model does not support tools.",
          },
        },
      };
    }
    const childSystemBase = applyModelConstraints(
      buildSubagentPrompt(
        request,
        childBash.getCwd(),
        custom ?? null,
        childBash.getSandboxMode(),
        subagents,
        childBash.getSandboxSettings(),
        childRuntime.modelInfo?.provider ?? this.deps.getProviderId(),
      ),
      childRuntime.modelId,
    );
    // Tier-aware behavioural steering — same front-loaded stack as the
    // top-level turn (see message-processor.ts), gated on the SUB-AGENT's
    // runtime (a top-level claude turn can still spawn a deepseek sub-agent
    // via SAMR/cost optimisation, and the sub-agent needs the steering even
    // though the parent does not). Layered so the final prompt OPENS with
    // [ENV] → [CRITICAL playbook] → [CONVERGENCE workbook] → base, matching
    // the cached-prefix order used at the top level. The sub-agent has no PIL
    // classifier of its own, so its workbook task type is derived from its
    // role via subagentTaskType (explore→analyze, verify*→debug, else null).
    const childWithWorkbook = shouldInjectCheapModelWorkbook(childRuntime.modelInfo)
      ? injectCheapModelWorkbook(childSystemBase, subagentTaskType(agentKey))
      : childSystemBase;
    const childWithPlaybook = shouldInjectCheapModelPlaybook(childRuntime.modelInfo)
      ? injectCheapModelPlaybook(childWithWorkbook)
      : childWithWorkbook;
    const childSystem = shouldInjectCheapModelPlaybook(childRuntime.modelInfo)
      ? injectCheapModelShellDirective(childWithPlaybook, cheapModelShellLine(resolveShell({}).kind, process.platform))
      : childWithPlaybook;

    // Inject vision proxy guidance for text-only child models (DeepSeek etc.)
    // so sub-agents know to use analyze_image / ask_vision_proxy when they
    // receive image context or file paths. Mirrors top-level in message-processor.
    const visionGuidance = needsVisionProxy(childModelId) ? getVisionGuidanceForTextOnly(childModelId) : "";
    const childSystemWithVision = visionGuidance ? `${childSystem}\n\n${visionGuidance}` : childSystem;

    onActivity?.(initialDetail);

    if (childMode === "agent" && taskCaps.supportsClientTools(childRuntime.modelInfo)) {
      const mcpBundle = await acquireMcpTools(loadMcpServers(), {
        onOAuthRequired: (_serverId, url) => {
          // Server-supplied URL is untrusted — openUrl validates the scheme
          // and spawns via execFile (no shell), closing the command-injection
          // vector the old exec() opener had.
          openUrl(url);
        },
      });
      closeMcp = mcpBundle.close;
      // Re-wrap merged tools through the same cumulative-cap state so MCP
      // tools (which aren't part of childBaseTools) also count against and
      // honor the sub-agent budget.
      childTools = subAgentCap.rewrap({ ...childBaseTools, ...mcpBundle.tools });
      captureToolSchemas(childTools);
      if (mcpBundle.errors.length > 0) {
        lastActivity = `MCP unavailable: ${mcpBundle.errors.join(" | ")}`;
        onActivity?.(lastActivity);
      }
    }

    const childPrompt =
      isVerify && verifyPreparedRecipe
        ? `${request.prompt}\n\nPrepared verify recipe JSON (use this as the primary execution recipe and keep .muonroi-cli/environment.json aligned with it if present):\n${JSON.stringify(verifyPreparedRecipe, null, 2)}`
        : request.prompt;

    // Vision input is an anti-feature per PROJECT.md Out-of-Scope; the
    // file-local `buildVisionUserMessages` in orchestrator.ts always throws.
    // Mirror that behavior inline rather than re-export the throwing stub.
    if (isVision) {
      throw new Error("Vision input is not supported in muonroi-cli (anti-feature per PROJECT.md).");
    }
    // signal is intentionally unused on this branch — vision was the only consumer.
    void signal;
    const childMessages: ModelMessage[] = [{ role: "user", content: childPrompt }];

    // The main agent manages its sub-agents, so don't apply an arbitrary hard limit.
    const maxSteps = request.maxToolRounds ?? this.deps.getMaxToolRounds() * 2;

    // F1 parity — derive per-turn providerOptions so the sub-agent OpenAI calls
    // carry a stable session-derived promptCacheKey (every tool round routes to
    // the same cache node, keeping the unchanging prefix cached). The top-level
    // turn does this in message-processor.ts; the sub-agent path previously used
    // only resolve-time childRuntime.providerOptions (no cache key). Guard on a
    // resolvable provider so a runtime without catalog modelInfo (vision/computer
    // constants) falls back to the resolve-time options instead of throwing.
    const childProviderOptions = childRuntime.modelInfo?.provider
      ? (buildTurnProviderOptions(childRuntime, { sessionId: this.deps.getSessionId() }) ??
        (childRuntime.providerOptions as Record<string, unknown> | undefined))
      : (childRuntime.providerOptions as Record<string, unknown> | undefined);

    return {
      kind: "prepared",
      prepared: {
        request,
        agentKey,
        childMode,
        childBash,
        childRuntime,
        childSystem: childSystemWithVision,
        childMessages,
        childTools,
        childProviderOptions,
        initialDetail,
        lastActivity,
        maxSteps,
        closeMcp,
        useBatchApi: this.deps.isBatchApiEnabled(),
      },
    };
  }

  /**
   * Phase 2 — invoke streamText with the prepared call config and drain the
   * full stream. Returns the assembled assistant output. Throws on transient
   * stream errors when no content has flowed (caller decides retry).
   */
  async runStream(
    prepared: PreparedSubAgentCall,
    onActivity?: (detail: string) => void,
    signal?: AbortSignal,
  ): Promise<{ output: string; lastActivity: string; cancelled: boolean; assistantText: string; stalled?: boolean }> {
    const { childRuntime, childSystem, childMessages, childTools, maxSteps } = prepared;
    // F1 — per-turn options (with promptCacheKey) built in setup(); falls back
    // to resolve-time options when no provider/session was available.
    const childProviderOptions = prepared.childProviderOptions ?? childRuntime.providerOptions;
    const taskCaps = getProviderCapabilities(requireRuntimeProvider(childRuntime));
    let assistantText = "";
    let lastActivity = prepared.lastActivity;
    const isExplore = prepared.agentKey === "explore";

    // Task 2.6a — assign a fresh correlation ID for this streamText call.
    const subCallId = crypto.randomUUID();
    this.deps.setCurrentCallId(subCallId);
    // G1 debug: enable detailed sub-agent telemetry via env flag so we can
    // diagnose "No output generated" / silent task failures (e.g. with
    // gpt-5.4 reasoning models). Disabled by default — zero cost.
    const debugSubagent = process.env.MUONROI_DEBUG_SUBAGENT === "1";
    const debugLog = writeSubagentDebug.bind(null, debugSubagent);
    if (debugSubagent) {
      const mi = childRuntime.modelInfo;
      debugLog(
        `start: model=${childRuntime.modelId} provider=${mi?.provider} reasoning=${mi?.reasoning} thinkingType=${mi?.thinkingType} supportsClientTools=${mi?.supportsClientTools} supportsMaxOutputTokens=${mi?.supportsMaxOutputTokens} agent=${prepared.request.agent}`,
      );
      try {
        debugLog(`providerOptions=${JSON.stringify(childProviderOptions ?? {})}`);
      } catch {
        /* providerOptions may contain non-serializable refs */
      }
      debugLog(`toolCount=${Object.keys(childTools).length} stopWhen=stepCountIs(${maxSteps})`);
    }

    // Honor `unsupportedParams` from OAuth registry (ChatGPT Codex backend
    // rejects `max_output_tokens` with HTTP 400; top-level orchestrator
    // already strips it via `dropParam`, the sub-agent path was missing
    // the same guard, causing G1: "Task failed: No output generated.").
    const childDropMaxOutput = shouldDropParam(childRuntime, "maxOutputTokens");
    // Phase B3: compact older tool_results out of the running message history
    // before each AI SDK step. First step (stepNumber === 0) has no history
    // worth compacting; later steps are where cumulative input balloons.
    const compactThreshold = getSubAgentCompactThresholdChars();
    const compactKeepLast = getSubAgentCompactKeepLast();
    // Phase O1 — capture providerOptions SHAPE (types only) for forensics.
    this.deps.setLastProviderOptionsShape(extractProviderOptionsShape(childProviderOptions));
    if (wireDebug.enabled) {
      wireDebug.logRequest({
        providerId: childRuntime.modelInfo?.provider ?? "unknown",
        modelId: childRuntime.modelId,
        messages: childMessages as readonly unknown[],
        systemChars: childSystem?.length ?? 0,
        toolNames: childTools ? Object.keys(childTools) : undefined,
        providerOptions: childProviderOptions,
      });
    }
    // Some DeepSeek thinking-mode endpoints reject assistant history with
    // `reasoning` parts (HTTP 400 code 20015). A provider capability
    // override strips them; every other provider's capability is identity.
    const subMessagesForCall = taskCaps.sanitizeHistory(childMessages) as typeof childMessages;
    // Phase 4 Plan 04 (4B) — mirror top-level scope-ceiling integration.
    // Sub-agent ceiling resolves against ("general", "medium") because the
    // sub-agent has no PIL ctx of its own; the caller already bounded the
    // work via maxSteps. We compose alongside that hard step cap so a
    // wandering sub-agent loop trips whichever fires first (logical OR).
    // Explore sub-agents are READ-ONLY research — a codebase investigation
    // legitimately needs more grep/read steps than the tight general/medium=10
    // cell allows. Cutting it early (esp. for reasoning models that front-load
    // Sub-agent ceiling is no longer a hard halt. Per user request:
    // "cũng áp dụng với sub agent nhé không nên hardcode maxtool mà nếu có
    // vấn đề gì sẽ có main agent (khi spawn) kiểm soát đừng hard"
    const _subCeiling = isExplore ? resolveCeiling("analyze", "large") : resolveCeiling("general", "medium");
    const _subCounterKey = `subagent:${subCallId}`;
    const _subStopWhen = (async (state: { steps: ReadonlyArray<unknown> }) => {
      incSessionStep(_subCounterKey); // Keep telemetry counter ticking
      if (state.steps.length >= maxSteps) return true;
      return false;
    }) as unknown as Parameters<typeof streamText>[0]["stopWhen"];

    // Silent-hang guard — mirror the top-level loop (message-processor.ts).
    // A sub-agent provider connection can accept the request but never send a
    // chunk (overloaded/stalled backend); `streamText` has no time-to-first-
    // byte timeout, so the drain loop below would block forever with ZERO user
    // feedback. The watchdog aborts after getProviderStallTimeoutMs of silence
    // and is re-armed by stall.pet() on every chunk. Cheap models (which run
    // mostly as sub-agents via SAMR) hit this most.
    let stallTriggered = false;
    // Second timer (progressTimeoutMs) is the no-forward-progress guard: the
    // stall timer re-arms on EVERY chunk — including a reasoning model's
    // `reasoning-delta` chunks — so a sub-agent stuck in an endless
    // chain-of-thought keeps petting it and it never fires (observed live
    // 2026-07-10: a deepseek-v4-flash sprint sub-agent churned reasoning for
    // 30+ min, 1.4M input tokens, ZERO text/tool output; the 2-min stall
    // watchdog never tripped). The progress timer is reset ONLY by
    // stall.petProgress() on real output (text-delta / tool-call), so a runaway
    // reasoning loop is aborted while a legitimately long reasoning burst that
    // DOES eventually emit output survives. Both timers abort the same signal
    // and set stallTriggered, so the existing surface-and-return path handles it.
    const stall = createStallWatchdog(
      getProviderStallTimeoutMs(),
      () => {
        stallTriggered = true;
      },
      {
        progressTimeoutMs: getProviderProgressTimeoutMs(),
        onProgressFire: () => {
          stallTriggered = true;
          console.error(
            `[stream-runner] sub-agent aborted: no text/tool output for ${getProviderProgressTimeoutMs()}ms ` +
              `(runaway reasoning / no forward progress) model=${childRuntime.modelId}`,
          );
        },
      },
    );
    const result = streamText({
      model: childRuntime.model,
      system: childSystem,
      messages: subMessagesForCall,
      tools: !taskCaps.supportsClientTools(childRuntime.modelInfo) ? {} : childTools,
      stopWhen: _subStopWhen ?? stepCountIs(maxSteps),
      maxRetries: 0,
      abortSignal: combineAbortSignals(signal, stall.signal),
      // Repair malformed tool-call JSON args — same wiring as the top-level
      // loop in message-processor.ts. Without this, sub-agents on models
      // with broken tool-arg emission (Qwen3-30B-Instruct observed) loop on
      // tool-error until the repetition detector aborts the whole run.
      experimental_repairToolCall: repairToolCallHook,
      prepareStep: ({ messages, stepNumber }) => {
        if (stepNumber < 1) return undefined;
        // Internal multi-step loop: AI-SDK accumulates streamed reasoning
        // parts into in-flight assistant history and re-POSTs them on the
        // next step within the same streamText call — orchestrator-level
        // strip at call setup never sees this. Strip per step too via the
        // capability hook (identity for providers without the quirk).
        const stripped = taskCaps.sanitizeHistory(messages) as typeof messages;
        // G1 + G2 — pass the sub-agent's model context window so the
        // compactor can use a token-aware threshold and shrink the keep
        // window when the prompt is near the ceiling.
        const childCtxWindow = childRuntime.modelInfo?.contextWindow ?? 0;
        // Idea 3: support KEEP_TOOL_IDS even in sub-agent loops (if the token
        // reached the child history via injected reminder or prior context).
        let subKeepToolIds: string[] = [];
        for (const m of stripped as any[]) {
          const c = m?.content;
          const texts: string[] = [];
          if (typeof c === "string") texts.push(c);
          if (Array.isArray(c)) for (const p of c) if (typeof p?.text === "string") texts.push(p.text);
          const joined = texts.join(" ");
          const mKeep = joined.match(/KEEP_TOOL_IDS\s*[:=]\s*([a-z0-9_, -]+)/i);
          if (mKeep) {
            subKeepToolIds = mKeep[1]
              .split(/[,\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            break;
          }
        }

        const persistSubArtifact = (
          toolCallId: string,
          toolName: string,
          fullContent: string,
          reason: string,
          summary?: string,
        ) => {
          // Local-first durable cache so ee_query rehydrates even when EE is down.
          recordArtifact(toolCallId, toolName, fullContent);
          recordElision(toolCallId, toolName, fullContent.length, stepNumber, summary);
          try {
            getDefaultEEClient()
              .extract(
                {
                  transcript: fullContent.slice(0, 4000),
                  projectPath: process.cwd(),
                  meta: { source: "tool-artifact", toolCallId, toolName, reason, summary },
                },
                AbortSignal.timeout(600),
              )
              .catch(() => {});
          } catch {
            /* fail-open */
          }
        };

        // T1.1 + T1.2 — reasoning models (DeepSeek V4 Flash, R1) emit 2K-5K
        // CoT tokens per turn that accumulate across the multi-step loop.
        // Strip old reasoning and compact earlier (ratio 0.3 vs 0.5) to
        // cut ~40-60% of cumulative input tokens.
        const isReasoningModel = childRuntime.modelInfo?.reasoning === true;
        const compacted = compactSubAgentMessages(stripped, {
          thresholdChars: compactThreshold,
          keepLastTurns: compactKeepLast,
          contextWindowTokens: childCtxWindow,
          contextFillRatio: isReasoningModel ? 0.3 : undefined,
          keepToolIds: subKeepToolIds.length ? subKeepToolIds : undefined,
          persistArtifact: persistSubArtifact,
          stripOldReasoning: isReasoningModel,
        });
        if (compacted !== stripped) recordCompaction(stepNumber);
        // Phase 4A — scope reminder injection for the sub-agent loop.
        // Mirror of the top-level wiring in message-processor.ts:
        // K = cadenceForSize(size) where size defaults to "medium" because
        // the sub-agent has no PIL ctx of its own (matches 4B sub-agent
        // ceiling that uses ("general", "medium") above). Original prompt
        // is `prepared.request.prompt`. Session id reuses the sub-agent
        // counter key so soft-warn fires at most once per sub-agent call.
        const _subSize: ComplexitySize = "medium";
        const _subK = cadenceForSize(_subSize);
        const _subShouldRemind = shouldInjectReminder(stepNumber, _subK);
        const _subShouldWarn = shouldInjectSoftWarn(stepNumber, _subCeiling, _subCounterKey);
        const finalMessages = (() => {
          if (_subShouldRemind || _subShouldWarn) {
            const _baseReminder = buildScopeReminder({
              step: stepNumber,
              ceiling: _subCeiling,
              taskType: "general",
              size: _subSize,
              originalPrompt: prepared.request.prompt,
            });
            const _reminder = _subShouldWarn ? `[approaching ceiling] ${_baseReminder}` : _baseReminder;
            return attachReminderToMessages(compacted, _reminder);
          }
          return compacted;
        })();

        if (childRuntime.modelId.startsWith("claude")) {
          return { messages: applyAnthropicPromptCaching(finalMessages, childRuntime.modelId) };
        }

        if (compacted === stripped && stripped === messages) return undefined;
        return { messages: finalMessages };
      },
      ...resolveTemperatureParam(childRuntime, isExplore ? 0.2 : 0.5),
      ...(childDropMaxOutput ? {} : { maxOutputTokens: Math.min(this.deps.getMaxTokens(), 8_192) }),
      ...(childProviderOptions ? { providerOptions: childProviderOptions } : {}),
      onFinish: ({ totalUsage, finishReason }) => {
        const tu = totalUsage as Record<string, unknown>;
        const details = tu.inputTokenDetails as Record<string, unknown> | undefined;
        const raw = tu.raw as Record<string, unknown> | undefined;
        const cacheReadTokens =
          asNumber(tu.cachedInputTokens) ??
          asNumber(details?.cacheReadTokens) ??
          asNumber(raw?.prompt_cache_hit_tokens) ??
          0;
        const cacheCreationTokens =
          asNumber(details?.cacheWriteTokens) ?? asNumber(raw?.cache_creation_input_tokens) ?? 0;
        this.deps.recordUsage(
          { ...totalUsage, cacheReadTokens, cacheCreationTokens },
          "task",
          childRuntime.modelId,
          // O1 — thread THIS sub-agent's providerOptions shape so the task event
          // records its own shape, not whatever the mutable field last held.
          extractProviderOptionsShape(childProviderOptions),
        );
        // Task 2.6b — emit llm-done (agent-mode only).
        try {
          const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
            | { emitEvent: (e: unknown) => void }
            | undefined;
          _ar?.emitEvent({
            t: "event",
            kind: "llm-done",
            correlationId: subCallId,
            totalChars: assistantText.length,
            finishReason: finishReason ?? "stop",
          });
        } catch {
          /* best-effort */
        }
        this.deps.setCurrentCallId("");
      },
    });

    let subTokenIndex = 0;
    const partCounts: Record<string, number> = {};
    let toolCallCount = 0;
    let textDeltaCount = 0;
    const wireProviderIdSub = childRuntime.modelInfo?.provider ?? "unknown";
    try {
      for await (const part of result.fullStream) {
        stall.pet(); // chunk arrived — reset the stall watchdog
        if (signal?.aborted) {
          break;
        }

        if (debugSubagent) {
          partCounts[part.type] = (partCounts[part.type] ?? 0) + 1;
        }

        if (wireDebug.enabled) {
          wireDebug.logChunk(wireProviderIdSub, String(part.type ?? "unknown"), {
            hasText:
              typeof (part as { text?: string }).text === "string" ? (part as { text: string }).text.length : undefined,
            hasReasoning:
              typeof (part as unknown as { reasoning?: string }).reasoning === "string"
                ? (part as unknown as { reasoning: string }).reasoning.length
                : undefined,
            errorMsg:
              part.type === "error"
                ? (() => {
                    const e = (part as { error?: unknown }).error;
                    wireDebug.logError(wireProviderIdSub, e);
                    return typeof (e as Error)?.message === "string" ? (e as Error).message : String(e);
                  })()
                : undefined,
          });
        }

        if (part.type === "text-delta") {
          stall.petProgress(); // real forward progress — reset the no-progress guard
          textDeltaCount++;
          assistantText += part.text;
          // Task 2.6b — emit llm-token (agent-mode only; high-volume, default-off per Phase 4).
          try {
            const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
              | { emitEvent: (e: unknown) => void }
              | undefined;
            _ar?.emitEvent({
              t: "event",
              kind: "llm-token",
              correlationId: subCallId,
              delta: part.text,
              tokenIndex: subTokenIndex++,
            });
          } catch {
            /* best-effort */
          }
          continue;
        }

        if (part.type === "tool-call") {
          stall.petProgress(); // real forward progress — reset the no-progress guard
          toolCallCount++;
          lastActivity = formatSubagentActivity(part.toolName, part.input);
          onActivity?.(lastActivity);
          continue;
        }

        if (debugSubagent) {
          // Capture finish reasons + error parts that we'd otherwise swallow.
          if ((part as { type: string }).type === "error") {
            const errPart = (part as { error?: unknown }).error ?? part;
            const errStr = (() => {
              try {
                return JSON.stringify(errPart, Object.getOwnPropertyNames(errPart as object));
              } catch {
                return String(errPart);
              }
            })();
            debugLog(`stream-error-part: ${errStr.slice(0, 500)}`);
          }
          if ((part as { type: string }).type === "finish") {
            const reason = (part as { finishReason?: string }).finishReason ?? null;
            debugLog(`stream-finish: reason=${reason}`);
          }
        }
      }

      if (signal?.aborted) {
        return { output: "[Cancelled]", lastActivity, cancelled: true, assistantText };
      }

      if (debugSubagent) {
        debugLog(
          `stream-end: textDeltas=${textDeltaCount} toolCalls=${toolCallCount} assistantTextLen=${assistantText.length} parts=${JSON.stringify(partCounts)}`,
        );
      }

      await result.response;
    } catch (err) {
      // Provider stalled (no chunk within the stall timeout): surface a clear
      // error toast + a failed ToolResult instead of an opaque hang/throw.
      // Returning (not throwing) means run()'s transient-retry path is skipped
      // — a stalled provider would just stall again for another full timeout.
      // (retry-classifier also marks provider-stall non-transient as defence.)
      if (stallTriggered) {
        try {
          const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
            | { emitEvent: (e: unknown) => void }
            | undefined;
          _ar?.emitEvent({ t: "event", kind: "toast", level: "error", text: STALL_ERROR_MESSAGE });
        } catch {
          /* best-effort toast */
        }
        onActivity?.(STALL_ERROR_MESSAGE);
        return { output: STALL_ERROR_MESSAGE, lastActivity, cancelled: false, assistantText, stalled: true };
      }
      throw err;
    } finally {
      stall.dispose();
    }

    // Forced final synthesis. When the loop ends on a tool-call / step-ceiling
    // cut (finishReason="tool-calls"), the model never got a turn to write its
    // findings, so assistantText is empty and the parent would receive the
    // useless "Task completed. Last action: <tool>" fallback — then redo the
    // work itself, defeating the whole point of delegation (live root cause:
    // grok-build-0.1 emitted 277 reasoning-deltas + 19 tool-calls but ZERO
    // text-deltas across the 10-step ceiling). Give the sub exactly ONE
    // tool-free turn to synthesize what it already gathered. Tools are removed
    // so finishReason cannot be "tool-calls" again — the model MUST emit text.
    let synthesizedText = "";
    if (!assistantText.trim() && !signal?.aborted && !stallTriggered) {
      try {
        const resp = await result.response;
        const priorMessages = (resp.messages ?? []) as ModelMessage[];
        const synthResult = streamText({
          model: childRuntime.model,
          system: childSystem,
          messages: [
            ...childMessages,
            ...priorMessages,
            {
              role: "user",
              content:
                "You've reached your tool execution budget (max steps) for this turn and have not written your final answer yet. Stop now — do NOT call any more tools.\n\n" +
                "Option A: If you have enough findings, write your final synthesis FOR THE PARENT AGENT: lead with the answer to the delegated task, cite the concrete file:line behind each claim, then note any gaps or the recommended next step. Be concise; the parent only ingests this message.\n\n" +
                "Option B: If you need to continue working but are blocked by this limit, you can request the system to compact the context and start a fresh turn. To do this, reply with EXACTLY this format and nothing else:\n/compact <instructions on what to focus on after compaction>",
            },
          ],
          tools: {},
          maxRetries: 0,
          abortSignal: signal,
          ...(childProviderOptions ? { providerOptions: childProviderOptions } : {}),
        });
        for await (const part of synthResult.fullStream) {
          if (part.type === "text-delta") synthesizedText += part.text ?? "";
        }
        debugLog(`forced-synthesis: textLen=${synthesizedText.length}`);
      } catch (err) {
        debugLog(`forced-synthesis failed: ${(err as Error)?.message}`);
      }
    }

    const recovered = assistantText.trim() || synthesizedText.trim();
    const output = recovered || `Task completed. Last action: ${lastActivity}`;
    return { output, lastActivity, cancelled: false, assistantText: recovered };
  }

  /**
   * Phase 3 — canonical entrypoint. Orchestrates setup + runStream with
   * transient-error re-throw + G1 diagnostic dump + MCP teardown.
   */
  async run(request: TaskRequest, onActivity?: (detail: string) => void, signal?: AbortSignal): Promise<ToolResult> {
    const outcome = await this.setup(request, onActivity, signal);
    if (outcome.kind === "short-circuit") {
      // No try/finally needed — setup didn't open MCP if it short-circuited
      // BEFORE the MCP merge; but the computer-agent short-circuit happens
      // AFTER MCP open, so honor closeMcp if present.
      if (outcome.closeMcp) await outcome.closeMcp().catch(() => {});
      return outcome.result;
    }
    const prepared = outcome.prepared;
    let lastActivity = prepared.lastActivity;
    let assistantText = "";

    try {
      if (prepared.useBatchApi) {
        return await this.deps.runTaskRequestBatch({
          request,
          childMessages: prepared.childMessages,
          childSystem: prepared.childSystem,
          childRuntime: prepared.childRuntime,
          childTools: prepared.childTools,
          maxSteps: prepared.maxSteps,
          initialDetail: prepared.initialDetail,
          onActivity,
          signal,
        });
      }

      const streamResult = await this.runStream(prepared, onActivity, signal);
      lastActivity = streamResult.lastActivity;
      assistantText = streamResult.assistantText;
      if (streamResult.cancelled) {
        return { success: false, output: "[Cancelled]" };
      }
      if (streamResult.stalled) {
        // Provider stalled — surface as a failed task so the parent agent (and
        // the user via the toast emitted in runStream) sees it, instead of a
        // success carrying the stall message as "output".
        return {
          success: false,
          output: streamResult.output,
          task: {
            agent: request.agent,
            description: request.description,
            summary: firstLine(streamResult.output),
            activity: lastActivity,
          },
        };
      }
      return {
        success: true,
        output: streamResult.output,
        task: {
          agent: request.agent,
          description: request.description,
          summary: firstLine(streamResult.output),
          activity: lastActivity,
        },
      };
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      // Re-throw transient network errors when no content has flowed so the
      // caller (runTask) can retry with withStreamRetry. Only re-throw when
      // assistantText is empty — if the agent produced partial output we must
      // NOT restart, as that would corrupt the task output.
      if (!assistantText.trim()) {
        const { transient } = classifyStreamError(err);
        if (transient) {
          throw err;
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      // G1 diagnostic: surface the full error shape under
      // MUONROI_DEBUG_SUBAGENT=1 so we can see whether `msg` is "No output
      // generated" (AI SDK validation failure on empty assistant response)
      // or a deeper provider error.
      const debugCatch = process.env.MUONROI_DEBUG_SUBAGENT === "1";
      if (debugCatch) {
        const e = err as {
          name?: string;
          message?: string;
          cause?: unknown;
          stack?: string;
          statusCode?: number;
          data?: unknown;
          responseBody?: unknown;
        };
        writeSubagentDebug(
          true,
          `catch: name=${e.name ?? "?"} statusCode=${e.statusCode ?? "?"} message=${(e.message ?? "").slice(0, 400)}`,
        );
        if (e.cause !== undefined) {
          try {
            writeSubagentDebug(
              true,
              `catch.cause=${JSON.stringify(e.cause, Object.getOwnPropertyNames(e.cause as object)).slice(0, 600)}`,
            );
          } catch (jsonErr) {
            writeSubagentDebug(
              true,
              `catch.cause(string)=${String(e.cause).slice(0, 400)} [stringify failed: ${
                jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
              }]`,
            );
          }
        }
        if (e.responseBody !== undefined) {
          writeSubagentDebug(true, `catch.responseBody=${String(e.responseBody).slice(0, 600)}`);
        }
        if (e.data !== undefined) {
          try {
            writeSubagentDebug(true, `catch.data=${JSON.stringify(e.data).slice(0, 400)}`);
          } catch (jsonErr) {
            writeSubagentDebug(
              true,
              `catch.data(unserializable): ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
            );
          }
        }
        if (e.stack) writeSubagentDebug(true, `stack: ${e.stack.split("\n").slice(0, 6).join(" | ")}`);
      }
      const output = `Task failed: ${msg}`;
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
    } finally {
      await prepared.closeMcp?.().catch(() => {});
    }
  }
}
