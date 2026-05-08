import { generateText, stepCountIs } from "ai";
import type { ToolSet } from "ai";
import { loadKeyForProvider } from "../providers/keychain.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../providers/runtime.js";
import { createBuiltinTools as createTools } from "../tools/registry.js";
import type { BashTool } from "../tools/bash.js";
import type { AgentMode, CouncilStatusPhase, StreamChunk } from "../types/index.js";
import type { CouncilLLM, CouncilStats } from "./types.js";
import { loadMcpServers } from "../utils/settings.js";
import { buildMcpToolSet } from "../mcp/runtime.js";
import type { McpToolBundle } from "../mcp/runtime.js";
import { buildResearchSystemPrompt } from "./prompts.js";
import { getDefaultEEClient } from "../ee/intercept.js";
import { emitMatches } from "../ee/render.js";

/**
 * Wrap each tool in the set with EE PreToolUse intercept check.
 * Before executing any tool, fires EE intercept and emits warnings via render sink.
 * CQ-15: wrapToolsWithEeCheck applied to all debate round tools.
 */
function wrapToolsWithEeCheck(tools: ToolSet, tenantId: string): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof (tool as { execute?: unknown }).execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (args: unknown, opts: unknown) => {
        // Fire EE PreToolUse intercept (non-blocking, fail-open)
        try {
          const client = getDefaultEEClient();
          const resp = await client.intercept({
            toolName: name,
            toolInput: args,
            cwd: process.cwd(),
            tenantId,
            scope: { kind: "global" },
          });
          emitMatches(resp?.matches);
        } catch { /* fail-open — tool must execute regardless */ }
        return (tool as { execute: (args: unknown, opts: unknown) => unknown }).execute(args, opts);
      },
    };
  }
  return wrapped;
}

export function createCouncilLLM(
  bash: BashTool,
  mode: AgentMode,
  sessionId: string | undefined,
  stats: CouncilStats,
): CouncilLLM {
  return {
    async generate(modelId: string, system: string, prompt: string, maxTokens = 2048): Promise<string> {
      const providerId = detectProviderForModel(modelId);
      const key = await loadKeyForProvider(providerId);
      const { factory } = createProviderFactory(providerId, { apiKey: key });
      const runtime = resolveModelRuntime(factory, modelId);
      const { text } = await generateText({
        model: runtime.model,
        system,
        prompt,
        maxOutputTokens: maxTokens,
        temperature: 0.7,
        ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
      });
      stats.calls++;
      return text;
    },

    async debate(modelId: string, system: string, prompt: string, signal?: AbortSignal): Promise<{ text: string; toolCalls: Array<{ toolName: string; result?: unknown }> }> {
      const providerId = detectProviderForModel(modelId);
      const key = await loadKeyForProvider(providerId);
      const { factory } = createProviderFactory(providerId, { apiKey: key });
      const runtime = resolveModelRuntime(factory, modelId);

      const builtinTools = createTools(bash, mode);

      // Lazy MCP bundle — fail-open so builtins remain available
      let mcpBundle: McpToolBundle | null = null;
      try {
        mcpBundle = await buildMcpToolSet(loadMcpServers());
      } catch {
        // MCP spawn failed — debate continues with builtin tools only
      }

      const mergedTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };
      const allTools: ToolSet = wrapToolsWithEeCheck(mergedTools, sessionId ?? "council");

      try {
        const result = await generateText({
          model: runtime.model,
          system,
          prompt,
          tools: allTools,
          stopWhen: stepCountIs(4),
          maxOutputTokens: 2048,
          temperature: 0.7,
          ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
          ...(signal ? { abortSignal: signal } : {}),
        });
        stats.calls++;
        return {
          text: result.text,
          toolCalls: (result.toolCalls ?? []) as Array<{ toolName: string; result?: unknown }>,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { text: `[debate failed: ${errMsg}]`, toolCalls: [] };
      } finally {
        await mcpBundle?.close().catch(() => {});
      }
    },

    async research(modelId: string, topic: string, conversationContext: string, signal?: AbortSignal): Promise<string> {
      const providerId = detectProviderForModel(modelId);
      const key = await loadKeyForProvider(providerId);
      const { factory } = createProviderFactory(providerId, { apiKey: key });
      const runtime = resolveModelRuntime(factory, modelId);

      const builtinTools = createTools(bash, mode);

      // CQ-03: Lazy MCP bundle per research call — fail-open so builtins remain available
      let mcpBundle: McpToolBundle | null = null;
      try {
        mcpBundle = await buildMcpToolSet(loadMcpServers());
      } catch {
        // MCP spawn failed — research continues with builtin tools only
      }

      const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };

      // CQ-04: Detect URL in topic — inject mandatory browser instruction into system prompt
      const hasUrl = /https?:\/\/\S+/.test(topic);
      const systemPrompt = buildResearchSystemPrompt(hasUrl);

      const userPrompt = conversationContext
        ? `## Context\n${conversationContext}\n\n---\n\n## Research Topic\n${topic}\n\nInvestigate and report findings.`
        : `## Research Topic\n${topic}\n\nInvestigate and report findings.`;

      try {
        const result = await generateText({
          model: runtime.model,
          system: systemPrompt,
          prompt: userPrompt,
          tools: allTools,
          stopWhen: stepCountIs(15),
          maxOutputTokens: 4096,
          temperature: 0.3,
          ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
          ...(signal ? { abortSignal: signal } : {}),
        });

        // CQ-04: When URL present, verify at least one browser tool was invoked
        if (hasUrl) {
          // Use result.toolCalls (flat array across all steps) — more reliably typed than steps[].toolCalls
          const browserUsed = (result.toolCalls ?? []).some(
            (tc) =>
              tc.toolName.includes("playwright") ||
              tc.toolName.includes("chrome"),
          );
          if (!browserUsed) {
            stats.calls++;
            return (
              result.text +
              "\n\n## Research Gap\n" +
              "- URL was present in topic but no browser tool was invoked. " +
              "Frontend findings unverified."
            );
          }
        }

        stats.calls++;
        return result.text;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return (
          `## Source Code Findings\n[Research failed: ${errMsg}]\n\n` +
          `## Internet Findings\n_Not performed._\n\n` +
          `## Frontend Findings (live)\n_Not performed._`
        );
      } finally {
        await mcpBundle?.close().catch(() => {});
      }
    },
  };
}

interface TracedGenerateArgs {
  phase: CouncilStatusPhase;
  label: string;
  detail?: string;
  role?: string;
  modelId: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Tick interval in ms. Default 1000. Set 0 to disable ticks. */
  tickIntervalMs?: number;
}

/**
 * Wraps `llm.generate` with start/tick/done status chunks so the UI can show
 * a live spinner row (e.g. `● Researching codebase... (12s)`).
 *
 * Returns the generated text via the AsyncGenerator return value.
 */
export async function* tracedGenerate(
  llm: CouncilLLM,
  args: TracedGenerateArgs,
): AsyncGenerator<StreamChunk, string, unknown> {
  const statusId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `status-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const start = Date.now();
  const tickInterval = args.tickIntervalMs ?? 1000;

  yield {
    type: "council_status",
    councilStatus: {
      statusId,
      state: "start",
      phase: args.phase,
      label: args.label,
      detail: args.detail,
      role: args.role,
      elapsedMs: 0,
    },
  };

  // Race generate vs ticks: drain ticks between generate slices using Promise.race.
  let resolved = false;
  let resultText = "";
  let resultErr: unknown = null;

  const generatePromise = (async () => {
    try {
      resultText = await llm.generate(args.modelId, args.system, args.prompt, args.maxTokens);
    } catch (err) {
      resultErr = err;
    } finally {
      resolved = true;
    }
  })();

  while (!resolved) {
    if (tickInterval <= 0) {
      await generatePromise;
      break;
    }
    const tickPromise = new Promise<void>((resolve) => setTimeout(resolve, tickInterval));
    await Promise.race([generatePromise, tickPromise]);
    if (resolved) break;
    yield {
      type: "council_status",
      councilStatus: {
        statusId,
        state: "tick",
        phase: args.phase,
        label: args.label,
        detail: args.detail,
        role: args.role,
        elapsedMs: Date.now() - start,
      },
    };
  }

  await generatePromise;

  if (resultErr) {
    const errMsg = resultErr instanceof Error ? resultErr.message : String(resultErr);
    yield {
      type: "council_status",
      councilStatus: {
        statusId,
        state: "error",
        phase: args.phase,
        label: args.label,
        detail: args.detail,
        role: args.role,
        elapsedMs: Date.now() - start,
        errorMessage: errMsg,
      },
    };
    throw resultErr;
  }

  yield {
    type: "council_status",
    councilStatus: {
      statusId,
      state: "done",
      phase: args.phase,
      label: args.label,
      detail: args.detail,
      role: args.role,
      elapsedMs: Date.now() - start,
    },
  };

  return resultText;
}

interface TracedAsyncArgs {
  phase: CouncilStatusPhase;
  label: string;
  detail?: string;
  role?: string;
  tickIntervalMs?: number;
}

/**
 * Generic version of {@link tracedGenerate} for arbitrary async work
 * (e.g. `llm.research`, `Promise.all` over multiple model calls).
 */
export async function* tracedAsync<T>(
  fn: () => Promise<T>,
  args: TracedAsyncArgs,
): AsyncGenerator<StreamChunk, T, unknown> {
  const statusId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `status-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const start = Date.now();
  const tickInterval = args.tickIntervalMs ?? 1000;

  yield {
    type: "council_status",
    councilStatus: {
      statusId,
      state: "start",
      phase: args.phase,
      label: args.label,
      detail: args.detail,
      role: args.role,
      elapsedMs: 0,
    },
  };

  let resolved = false;
  let result: T | undefined;
  let err: unknown = null;

  const work = (async () => {
    try {
      result = await fn();
    } catch (e) {
      err = e;
    } finally {
      resolved = true;
    }
  })();

  while (!resolved) {
    if (tickInterval <= 0) {
      await work;
      break;
    }
    const tick = new Promise<void>((resolve) => setTimeout(resolve, tickInterval));
    await Promise.race([work, tick]);
    if (resolved) break;
    yield {
      type: "council_status",
      councilStatus: {
        statusId,
        state: "tick",
        phase: args.phase,
        label: args.label,
        detail: args.detail,
        role: args.role,
        elapsedMs: Date.now() - start,
      },
    };
  }

  await work;

  if (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    yield {
      type: "council_status",
      councilStatus: {
        statusId,
        state: "error",
        phase: args.phase,
        label: args.label,
        detail: args.detail,
        role: args.role,
        elapsedMs: Date.now() - start,
        errorMessage: errMsg,
      },
    };
    throw err;
  }

  yield {
    type: "council_status",
    councilStatus: {
      statusId,
      state: "done",
      phase: args.phase,
      label: args.label,
      detail: args.detail,
      role: args.role,
      elapsedMs: Date.now() - start,
    },
  };

  return result as T;
}
