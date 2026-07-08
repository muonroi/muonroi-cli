/**
 * Pass 2: Token-budget chat compression using existing compaction engine.
 *
 * Serializes messages, extracts preserved blocks, compresses if over budget,
 * then restores preserved blocks into the output.
 */

import { generateText, type ModelMessage } from "ai";
import { serializeConversation } from "../../orchestrator/compaction.js";
import {
  type ProviderFactory as LegacyProvider,
  resolveModelRuntime,
  resolveTemperatureParam,
} from "../../providers/runtime.js";
import { extractPreservedBlocks, type PreservedBlock, restorePreservedBlocks } from "./preserve.js";

export interface CompressResult {
  summary: string;
  preservedBlocks: PreservedBlock[];
  tokensAfter: number;
}

/**
 * Compress chat messages within a token budget.
 *
 * 1. Serialize messages via serializeConversation().
 * 2. Extract preserved blocks.
 * 3. If under budget, return as-is (with preserved blocks restored).
 * 4. If over budget, compress via LLM (if provider given) or truncate, and restore blocks.
 */
export async function compressChat(
  messages: ModelMessage[],
  _systemPrompt: string,
  tokenBudget: number,
  provider?: unknown,
  modelId?: string,
  customInstructions?: string,
): Promise<CompressResult> {
  const serialized = serializeConversation(messages);
  const { cleaned, blocks } = extractPreservedBlocks(serialized);

  // Estimate tokens of cleaned text
  const estimatedTokens = Math.ceil(cleaned.length / 4);

  if (estimatedTokens <= tokenBudget) {
    // Under budget — restore preserved blocks and return as-is
    const restored = restorePreservedBlocks(cleaned, blocks);
    return {
      summary: restored,
      preservedBlocks: blocks,
      tokensAfter: Math.ceil(restored.length / 4),
    };
  }

  // Calculate space taken by preserved blocks
  const preservedTokens = blocks.reduce((sum, b) => sum + Math.ceil(b.content.length / 4), 0);
  const availableTokens = Math.max(0, tokenBudget - preservedTokens);
  const availableChars = availableTokens * 4;

  let compressedContent = cleaned;
  let usedLLM = false;

  if (provider && modelId) {
    try {
      const runtime = resolveModelRuntime(provider as LegacyProvider, modelId);
      const extraPrompt = customInstructions ? `\n\nUSER FOCUS/INSTRUCTIONS:\n${customInstructions}\n` : "";
      const result = await generateText({
        model: runtime.model,
        system:
          "You are an AI context compaction agent. Your job is to heavily summarize a chat history. Keep the core outcomes, the final state, and the technical context. Remove verbose pleasantries, step-by-step thinking, and irrelevant intermediate steps. Do NOT wrap in markdown unless it's code.",
        prompt: `The following conversation exceeds the token budget. Please summarize it concisely, maintaining the essence of what was discussed, what code was written, and what decisions were reached:${extraPrompt}\n\n${cleaned}`,
        ...resolveTemperatureParam(runtime, 0.1),
      });
      compressedContent = result.text.trim();
      usedLLM = true;
    } catch (e) {
      // Fallback below
    }
  }

  if (!usedLLM) {
    // Over budget — truncate to fit budget while keeping preserved blocks
    compressedContent =
      cleaned.length > availableChars
        ? `${cleaned.slice(0, availableChars)}\n\n[... ${cleaned.length - availableChars} characters truncated]`
        : cleaned;
  }

  const restored = restorePreservedBlocks(compressedContent, blocks);
  return {
    summary: restored,
    preservedBlocks: blocks,
    tokensAfter: Math.ceil(restored.length / 4),
  };
}
