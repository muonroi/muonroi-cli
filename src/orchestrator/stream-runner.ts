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
//   - siliconflow reasoning-strip           — taskCaps.sanitizeHistory

import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { buildMcpToolSet } from "../mcp/runtime";
import { normalizeModelId } from "../models/registry.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { captureToolSchemas } from "../providers/patch-zod-schema.js";
import {
  type ResolvedModelRuntime,
  requireRuntimeProvider,
  resolveModelRuntime,
  shouldDropParam,
} from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { wireDebug } from "../providers/wire-debug.js";
import { BashTool } from "../tools/bash";
import { createBuiltinTools } from "../tools/registry.js";
import type { AgentMode, TaskRequest, ToolResult, VerifyRecipe } from "../types/index";
import { statusBarStore } from "../ui/status-bar/store.js";
import {
  getCurrentShellSettings,
  getSubAgentBudgetChars,
  getSubAgentCompactKeepLast,
  getSubAgentCompactThresholdChars,
  loadMcpServers,
  loadValidSubAgents,
  type SandboxSettings,
} from "../utils/settings";
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
import { classifyStreamError } from "./retry-classifier.js";
import { wrapToolSetWithCap } from "./sub-agent-cap.js";
import { compactSubAgentMessages } from "./subagent-compactor.js";
import { firstLine, formatSubagentActivity } from "./tool-utils";

/**
 * Dependency callbacks the StreamRunner needs to reach back into Agent state
 * without holding a circular reference. Mirrors the CouncilManager DI pattern.
 */
export interface StreamRunnerDeps {
  /** Current top-level provider instance (already validated). */
  getProvider(): LegacyProvider;
  /** Resolve a specific task tier's model id (uses Agent's role config). */
  resolveModelForTask(task: "compact" | "explore" | "general" | "title"): string;
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
  ): void;
  /** Set the current call id (for forensics correlation). */
  setCurrentCallId(id: string): void;
  /** Persist the last providerOptions shape (O1 forensics). */
  setLastProviderOptionsShape(shape: string | null): void;
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
      sandboxMode: isVerify ? "shuru" : topBash.getSandboxMode(),
      sandboxSettings: isVerify
        ? (verifyPreparedSettings ?? { ...topBash.getSandboxSettings(), ...verifySandboxOverrides })
        : topBash.getSandboxSettings(),
      shellSettings: getCurrentShellSettings(),
    });
    // Mirror the file-local `createTools` wrapper from orchestrator.ts —
    // it calls createBuiltinTools(bash, mode) without provider/opts; the
    // provider arg in the original wrapper was unused.
    const childBaseToolsRaw = createBuiltinTools(childBash, childMode);
    // Wrap with the cumulative cap so the sub-agent's tool loop cannot
    // accumulate unbounded tool_result tokens. See sub-agent-cap.ts for the
    // tiered compression schedule. The cap is per-invocation; each sub-agent
    // gets a fresh budget.
    const subAgentCapBudget = getSubAgentBudgetChars();
    const subAgentCap = wrapToolSetWithCap(childBaseToolsRaw, { maxCumulativeChars: subAgentCapBudget });
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
    const childModelId = normalizeModelId(
      isVision
        ? VISION_MODEL
        : isComputer
          ? COMPUTER_MODEL
          : custom
            ? custom.model
            : this.deps.resolveModelForTask(isExplore ? "explore" : "general"),
    );
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
    const childSystem = applyModelConstraints(
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

    onActivity?.(initialDetail);

    if (childMode === "agent" && taskCaps.supportsClientTools(childRuntime.modelInfo)) {
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

    const maxSteps = Math.min(this.deps.getMaxToolRounds(), isExplore ? 60 : 120);

    return {
      kind: "prepared",
      prepared: {
        request,
        agentKey,
        childMode,
        childBash,
        childRuntime,
        childSystem,
        childMessages,
        childTools,
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
  ): Promise<{ output: string; lastActivity: string; cancelled: boolean; assistantText: string }> {
    const { childRuntime, childSystem, childMessages, childTools, maxSteps } = prepared;
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
    const debugLog = (line: string): void => {
      if (debugSubagent) process.stderr.write(`[subagent] ${line}\n`);
    };
    if (debugSubagent) {
      const mi = childRuntime.modelInfo;
      debugLog(
        `start: model=${childRuntime.modelId} provider=${mi?.provider} reasoning=${mi?.reasoning} thinkingType=${mi?.thinkingType} supportsClientTools=${mi?.supportsClientTools} supportsMaxOutputTokens=${mi?.supportsMaxOutputTokens} agent=${prepared.request.agent}`,
      );
      try {
        debugLog(`providerOptions=${JSON.stringify(childRuntime.providerOptions ?? {})}`);
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
    const childDropTemperature = shouldDropParam(childRuntime, "temperature");
    // Phase B3: compact older tool_results out of the running message history
    // before each AI SDK step. First step (stepNumber === 0) has no history
    // worth compacting; later steps are where cumulative input balloons.
    const compactThreshold = getSubAgentCompactThresholdChars();
    const compactKeepLast = getSubAgentCompactKeepLast();
    // Phase O1 — capture providerOptions SHAPE (types only) for forensics.
    this.deps.setLastProviderOptionsShape(extractProviderOptionsShape(childRuntime.providerOptions));
    if (wireDebug.enabled) {
      wireDebug.logRequest({
        providerId: childRuntime.modelInfo?.provider ?? "unknown",
        modelId: childRuntime.modelId,
        messages: childMessages as readonly unknown[],
        systemChars: childSystem?.length ?? 0,
        toolNames: childTools ? Object.keys(childTools) : undefined,
        providerOptions: childRuntime.providerOptions,
      });
    }
    // SiliconFlow DeepSeek thinking-mode rejects assistant history with
    // `reasoning` parts (HTTP 400 code 20015). The siliconflow capability
    // override strips them; every other provider's capability is identity.
    const subMessagesForCall = taskCaps.sanitizeHistory(childMessages) as typeof childMessages;
    const result = streamText({
      model: childRuntime.model,
      system: childSystem,
      messages: subMessagesForCall,
      tools: !taskCaps.supportsClientTools(childRuntime.modelInfo) ? {} : childTools,
      stopWhen: stepCountIs(maxSteps),
      maxRetries: 0,
      abortSignal: signal,
      prepareStep: ({ messages, stepNumber }) => {
        if (stepNumber < 1) return undefined;
        // SiliconFlow internal multi-step loop: AI-SDK accumulates streamed
        // reasoning parts into in-flight assistant history and re-POSTs them
        // on the next step within the same streamText call — orchestrator-
        // level strip at call setup never sees this. Strip per step too via
        // the capability hook (identity for non-siliconflow providers).
        const stripped = taskCaps.sanitizeHistory(messages) as typeof messages;
        const compacted = compactSubAgentMessages(stripped, {
          thresholdChars: compactThreshold,
          keepLastTurns: compactKeepLast,
        });
        if (compacted === stripped && stripped === messages) return undefined;
        return { messages: compacted };
      },
      ...(childDropTemperature ? {} : { temperature: isExplore ? 0.2 : 0.5 }),
      ...(childDropMaxOutput ? {} : { maxOutputTokens: Math.min(this.deps.getMaxTokens(), 8_192) }),
      ...(childRuntime.providerOptions ? { providerOptions: childRuntime.providerOptions } : {}),
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
        this.deps.recordUsage({ ...totalUsage, cacheReadTokens, cacheCreationTokens }, "task", childRuntime.modelId);
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
    for await (const part of result.fullStream) {
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

    const output = assistantText.trim() || `Task completed. Last action: ${lastActivity}`;
    return { output, lastActivity, cancelled: false, assistantText };
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
      if (process.env.MUONROI_DEBUG_SUBAGENT === "1") {
        const e = err as {
          name?: string;
          message?: string;
          cause?: unknown;
          stack?: string;
          statusCode?: number;
          data?: unknown;
          responseBody?: unknown;
        };
        process.stderr.write(
          `[subagent] catch: name=${e.name ?? "?"} statusCode=${e.statusCode ?? "?"} message=${(e.message ?? "").slice(0, 400)}\n`,
        );
        if (e.cause !== undefined) {
          try {
            process.stderr.write(
              `[subagent] catch.cause=${JSON.stringify(e.cause, Object.getOwnPropertyNames(e.cause as object)).slice(0, 600)}\n`,
            );
          } catch {
            process.stderr.write(`[subagent] catch.cause(string)=${String(e.cause).slice(0, 400)}\n`);
          }
        }
        if (e.responseBody !== undefined) {
          process.stderr.write(`[subagent] catch.responseBody=${String(e.responseBody).slice(0, 600)}\n`);
        }
        if (e.data !== undefined) {
          try {
            process.stderr.write(`[subagent] catch.data=${JSON.stringify(e.data).slice(0, 400)}\n`);
          } catch {
            /* non-serializable */
          }
        }
        if (e.stack) process.stderr.write(`[subagent] stack: ${e.stack.split("\n").slice(0, 6).join(" | ")}\n`);
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
