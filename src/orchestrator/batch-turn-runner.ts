// BatchTurnRunner — extracted from orchestrator.ts as part of Phase 12.5.
//
// Owns the batch-API streaming turn loop that lives in
// `Agent.processMessageBatchTurn`:
//   - Per-turn compaction (with overflow-relax on context-limit recovery)
//   - Batch chat-completions request build (tools from createTools + MCP)
//   - Provider-options shape capture (O1) per round
//   - Polling via pollBatchRequestResult + finish-reason / usage accumulation
//   - Tool roundtrip loop via executeBatchToolCall
//   - Observer notifications (onStepStart / onStepFinish / onToolStart /
//     onToolFinish / onError)
//   - Transient retry with exponential backoff + jitter + harness
//     `stream-retry` event emission
//   - Context-overflow recovery (single retry, relaxed compaction settings)
//   - MCP teardown via `closeMcp` in `finally`
//
// Zero behavioral changes — every body mirrors the original
// `processMessageBatchTurn`. The DI surface (`BatchTurnRunnerDeps`) is the
// minimum proxy onto Agent state needed to reach back into Agent without
// holding a circular reference. `Agent.processMessageBatchTurn` becomes a
// thin wrapper that constructs `BatchTurnRunner` per call.
//
// Callback names overlap with `MessageProcessorDeps` where the signature
// matches (`getCompactionSettings`, `compactForContext`, `postTurnCompact`,
// `recordUsage`, `appendCompletedTurn`, `discardAbortedTurn`,
// `getCompactedThisTurn` / `setCompactedThisTurn`, etc.) so a future
// `TurnRunnerDepsBase` hoist is mechanical.

import type { ModelMessage, ToolSet } from "ai";
import { buildMcpToolSet } from "../mcp/runtime";
import type { getModelInfo } from "../models/registry.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { requireRuntimeProvider, type resolveModelRuntime } from "../providers/runtime.js";
import type { BashTool } from "../tools/bash";
import type { AgentMode, StreamChunk, TaskRequest, ToolCall, ToolResult } from "../types/index";
import { openUrl } from "../utils/open-url";
import { loadMcpServers } from "../utils/settings";
import type {
  BatchClientOptions,
  BatchFunctionTool,
  LegacyProvider,
  ProcessMessageObserver,
  ProcessMessageUsage,
} from "./agent-options";
import {
  accumulateUsage,
  buildAssistantBatchMessage,
  buildBatchChatCompletionRequest,
  buildBatchName,
  buildToolBatchMessage,
  type ExecutedBatchTool,
  getBatchFinishReason,
  getBatchUsage,
  hasUsage,
  toLocalToolCall,
} from "./batch-utils";
import { relaxCompactionSettings } from "./compaction";
import { humanizeApiError, isAuthenticationError, isContextLimitError } from "./error-utils";
import { extractProviderOptionsShape } from "./provider-options-shape.js";
import { classifyStreamError } from "./retry-classifier.js";
import { combineAbortSignals, notifyObserver } from "./tool-utils";
import type { TurnRunnerDepsBase } from "./turn-runner-deps.js";

// ---------------------------------------------------------------------------
// Batch-API stubs (Phase 0 — these throw; real impl lands in Phase 1).
// Kept here next to the runner since the runner is the sole call site.
// ---------------------------------------------------------------------------

async function toolSetToBatchTools(_tools: ToolSet): Promise<BatchFunctionTool[]> {
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

function getBatchChatCompletion(_result: unknown): import("./agent-options").BatchChatCompletionResponse {
  throw new Error("Batch API not available in Phase 0. Use standard streaming mode.");
}

/**
 * Dependency surface BatchTurnRunner needs to reach back into Agent state
 * without a circular reference. Callback names align with
 * `MessageProcessorDeps` where the signature matches, so a future
 * `TurnRunnerDepsBase` hoist is mechanical.
 */
export interface BatchTurnRunnerDeps extends TurnRunnerDepsBase {
  // ---- Batch-specific read-only state references ------------------------
  // (messages, bash, mode, maxToolRounds, schedules, sendTelegramFile inherited)
  readonly maxTokens: number;

  // ---- Batch-specific scalar getters / setters --------------------------
  // (getCompactedThisTurn, setCompactedThisTurn, setLastProviderOptionsShape inherited)
  getSessionId(): string | null;
  getBatchClientOptions(signal?: AbortSignal): BatchClientOptions;

  // ---- Batch-specific behavior delegators -------------------------------
  // (getCompactionSettings, compactForContext, postTurnCompact, runTask,
  // runDelegation, readDelegation, listDelegations, appendCompletedTurn,
  // discardAbortedTurn, recordUsage inherited)
  createTools(
    bash: BashTool,
    provider: LegacyProvider,
    mode: AgentMode,
    opts: {
      runTask: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
      runDelegation: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
      readDelegation: (id: string) => Promise<ToolResult>;
      listDelegations: () => Promise<ToolResult>;
      scheduleManager: import("../tools/schedule").ScheduleManager;
      subagents: unknown[];
      sendTelegramFile?: (filePath: string) => Promise<ToolResult>;
      sessionId?: string;
    },
  ): ToolSet;
  executeBatchToolCall(
    tools: ToolSet,
    toolCall: ToolCall,
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{ input: unknown; result: ToolResult }>;
}

/**
 * BatchTurnRunner — extracted batch-API turn loop.
 *
 * Lifecycle:
 *   const runner = new BatchTurnRunner(deps);
 *   yield* runner.run(args);
 *
 * Constructed per call (heap allocation is negligible against the network
 * polling cost), matching the StreamRunner / CouncilManager / MessageProcessor
 * pattern.
 */
export class BatchTurnRunner {
  constructor(private deps: BatchTurnRunnerDeps) {}

  async *run(args: {
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    provider: LegacyProvider;
    subagents: unknown[];
    system: string;
    runtime: ReturnType<typeof resolveModelRuntime>;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown> {
    const deps = this.deps;
    const { userModelMessage, observer, provider, subagents, system, runtime, modelInfo, signal } = args;
    let attemptedOverflowRecovery = false;
    let streamRetryCount = 0;
    const MAX_STREAM_RETRIES = 2;

    while (true) {
      deps.setCompactedThisTurn(false);
      let closeMcp: (() => Promise<void>) | undefined;
      const turnMessages: ModelMessage[] = [];
      const totalUsage: ProcessMessageUsage = {};

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

        const batchCaps = getProviderCapabilities(requireRuntimeProvider(runtime));
        if (batchCaps.usesResponsesAPI(runtime.modelInfo)) {
          throw new Error("Batch mode currently supports chat-completions models only.");
        }

        const baseTools = deps.createTools(deps.bash, provider, deps.mode, {
          runTask: (request, abortSignal) => deps.runTask(request, combineAbortSignals(signal, abortSignal)),
          runDelegation: (request, abortSignal) =>
            deps.runDelegation(request, combineAbortSignals(signal, abortSignal)),
          readDelegation: (id) => deps.readDelegation(id),
          listDelegations: () => deps.listDelegations(),
          scheduleManager: deps.schedules,
          subagents,
          sendTelegramFile: deps.sendTelegramFile ?? undefined,
          sessionId: deps.getSessionId() ?? undefined,
        });
        let tools: ToolSet = !batchCaps.supportsClientTools(runtime.modelInfo) ? {} : baseTools;
        if (deps.mode === "agent" && batchCaps.supportsClientTools(runtime.modelInfo)) {
          const mcpBundle = await buildMcpToolSet(loadMcpServers(), {
            onOAuthRequired: (_serverId, url) => {
              // Server-supplied URL is untrusted — openUrl validates the scheme
              // and spawns via execFile (no shell), closing the command-injection
              // vector the old exec() opener had.
              openUrl(url);
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
          ...deps.getBatchClientOptions(signal),
          name: buildBatchName("session", deps.getSessionId() || runtime.modelId),
        });

        for (let round = 0; round < deps.maxToolRounds; round++) {
          const stepNumber = round + 1;
          notifyObserver(observer?.onStepStart, {
            stepNumber,
            timestamp: Date.now(),
          });

          const batchRequestId = `turn-${Date.now()}-${stepNumber}`;
          // Phase O1 — capture providerOptions SHAPE for batch path too.
          deps.setLastProviderOptionsShape(extractProviderOptionsShape(runtime.providerOptions));
          await addBatchRequests({
            ...deps.getBatchClientOptions(signal),
            batchId: batch.batch_id,
            batchRequests: [
              {
                batch_request_id: batchRequestId,
                batch_request: {
                  chat_get_completion: buildBatchChatCompletionRequest({
                    modelId: runtime.modelId,
                    system,
                    messages: [...deps.messages, ...turnMessages],
                    temperature: 0.7,
                    maxOutputTokens: !batchCaps.acceptsParam("maxOutputTokens", runtime.modelInfo)
                      ? undefined
                      : deps.maxTokens,
                    reasoningEffort: runtime.providerOptions?.xai.reasoningEffort,
                    tools: batchTools,
                  }),
                },
              },
            ],
          });

          const result = await pollBatchRequestResult({
            ...deps.getBatchClientOptions(signal),
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

          const requestMessages = [...deps.messages, ...turnMessages];
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
              deps.recordUsage(totalUsage, "message", runtime.modelId);
            }
            deps.appendCompletedTurn(userModelMessage, turnMessages);
            if (modelInfo?.contextWindow) {
              await deps.postTurnCompact(provider, system, modelInfo.contextWindow, signal);
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

            const executed = await deps.executeBatchToolCall(tools, toolCall, requestMessages, signal);
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

        const message = `Error: Reached max tool rounds (${deps.maxToolRounds}) in batch mode.`;
        notifyObserver(observer?.onError, {
          message,
          timestamp: Date.now(),
        });
        if (hasUsage(totalUsage)) {
          deps.recordUsage(totalUsage, "message", runtime.modelId);
        }
        deps.appendCompletedTurn(userModelMessage, turnMessages);
        yield { type: "error", content: message };
        yield { type: "done" };
        return;
      } catch (err: unknown) {
        if (signal.aborted) {
          deps.discardAbortedTurn(userModelMessage);
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
        const friendly = humanizeApiError(err, { modelId: runtime.modelId, providerId: modelInfo?.provider });
        notifyObserver(observer?.onError, {
          message: friendly,
          timestamp: Date.now(),
        });
        if (hasUsage(totalUsage)) {
          deps.recordUsage(totalUsage, "message", runtime.modelId);
        }
        deps.appendCompletedTurn(userModelMessage, turnMessages);
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
}
