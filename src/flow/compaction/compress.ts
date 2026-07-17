/**
 * Pass 2: Token-budget chat compression using existing compaction engine.
 *
 * Serializes messages, extracts preserved blocks, compresses if over budget,
 * then restores preserved blocks into the output.
 */

import { type ModelMessage, streamText } from "ai";
import { serializeConversation } from "../../orchestrator/compaction.js";
import { resolveModelRuntime, resolveTemperatureParam } from "../../providers/runtime.js";
import { logger } from "../../utils/logger.js";
import { capCompactionInput } from "./input-guard.js";
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
 * 4. If over budget, compress via LLM (if modelId given) or truncate, and restore blocks.
 */
export async function compressChat(
  messages: ModelMessage[],
  _systemPrompt: string,
  tokenBudget: number,
  modelId?: string,
  customInstructions?: string,
  onFraction?: (fraction: number) => void,
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

  if (modelId) {
    try {
      const runtime = resolveModelRuntime(modelId);
      const extraPrompt = customInstructions ? `\n\nUSER FOCUS/INSTRUCTIONS:\n${customInstructions}\n` : "";
      // Guard the compaction INPUT against the model's own context window —
      // compaction fires when history is large, which is exactly when the full
      // serialized text can overflow the summarizer. Keep head + tail.
      const guardedInput = capCompactionInput(cleaned, runtime.modelInfo?.contextWindow ?? 0);
      // Streamed rather than awaited whole so the caller can report real
      // progress: this pass is the bulk of a /compact's wall-clock, and a bar
      // that freezes for a minute reads as a hang. The summary text is still
      // only used once complete.
      const result = streamText({
        model: runtime.model,
        system:
          "You are an AI context compaction agent. Your job is to heavily summarize a chat history. Keep the core outcomes, the final state, and the technical context. Remove verbose pleasantries, step-by-step thinking, and irrelevant intermediate steps. Do NOT wrap in markdown unless it's code.",
        prompt: `The following conversation exceeds the token budget. Please summarize it concisely, maintaining the essence of what was discussed, what code was written, and what decisions were reached:${extraPrompt}\n\n${guardedInput}`,
        ...resolveTemperatureParam(runtime, 0.1),
      });
      let streamed = "";
      for await (const delta of result.textStream) {
        streamed += delta;
        // availableChars is the size the model was ASKED to fit under, so it is
        // the only honest denominator available — a concise summary finishes
        // early and the caller jumps the bar to done rather than overshooting.
        if (onFraction && availableChars > 0) onFraction(Math.min(1, streamed.length / availableChars));
      }
      compressedContent = streamed.trim();
      usedLLM = true;
    } catch (e) {
      // Fall back to deterministic truncation below, but do NOT swallow the
      // reason — a hidden compaction-LLM failure (auth, overflow, provider
      // 400) is exactly what makes "why did compaction do nothing" undebuggable.
      logger.error("orchestrator", "compressChat LLM summarize failed — falling back to truncation", {
        modelId,
        inputChars: cleaned.length,
        message: (e as Error)?.message,
        stack: (e as Error)?.stack?.split("\n").slice(0, 3),
      });
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
