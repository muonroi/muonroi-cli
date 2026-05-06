import { generateText, stepCountIs } from "ai";
import { loadKeyForProvider } from "../providers/keychain.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../providers/runtime.js";
import { createBuiltinTools as createTools } from "../tools/registry.js";
import type { BashTool } from "../tools/bash.js";
import type { AgentMode, CouncilStatusPhase, StreamChunk } from "../types/index.js";
import type { CouncilLLM, CouncilStats } from "./types.js";

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

    async research(modelId: string, topic: string, conversationContext: string, signal?: AbortSignal): Promise<string> {
      const providerId = detectProviderForModel(modelId);
      const key = await loadKeyForProvider(providerId);
      const { factory } = createProviderFactory(providerId, { apiKey: key });
      const runtime = resolveModelRuntime(factory, modelId);

      const researchTools = createTools(bash, mode);

      const systemPrompt =
        `You are a research specialist. Your job is to gather FACTS about the topic below.\n\n` +
        `## Instructions\n` +
        `- Use available tools (bash, read_file, grep) to investigate the codebase and find relevant files, code, or configurations\n` +
        `- Search for existing patterns, implementations, or decisions related to the topic\n` +
        `- Report EXACT findings: file paths, function names, error messages, code snippets\n` +
        `- Do NOT make assumptions or speculate — only report what you find\n` +
        `- If you can't find anything relevant, say so explicitly\n\n` +
        `## Output Format\n` +
        `After your investigation, produce a research report with:\n` +
        `## Research Findings\n` +
        `- [fact 1 with source]\n` +
        `- [fact 2 with source]\n\n` +
        `## Key Evidence\n` +
        `- [code snippets or file paths that are most relevant]\n\n` +
        `## Gaps\n` +
        `- [what we don't know yet or couldn't verify]\n`;

      const userPrompt = conversationContext
        ? `## Context\n${conversationContext}\n\n---\n\n## Research Topic\n${topic}\n\nInvestigate the codebase and report your findings.`
        : `## Research Topic\n${topic}\n\nInvestigate the codebase and report your findings.`;

      try {
        const { text } = await generateText({
          model: runtime.model,
          system: systemPrompt,
          prompt: userPrompt,
          tools: researchTools,
          stopWhen: stepCountIs(10),
          maxOutputTokens: 4096,
          temperature: 0.3,
          ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
          ...(signal ? { abortSignal: signal } : {}),
        });
        stats.calls++;
        return text;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return `## Research Findings\n[Research failed: ${errMsg}]\n\n## Gaps\n- Could not complete research due to error`;
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
