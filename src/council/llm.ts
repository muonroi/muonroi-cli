import { generateText, stepCountIs } from "ai";
import { loadKeyForProvider } from "../providers/keychain.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../providers/runtime.js";
import { createBuiltinTools as createTools } from "../tools/registry.js";
import type { BashTool } from "../tools/bash.js";
import type { AgentMode } from "../types/index.js";
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
