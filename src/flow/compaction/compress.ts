/**
 * Pass 2: Token-budget chat compression using existing compaction engine.
 *
 * Serializes messages, extracts preserved blocks, compresses if over budget,
 * then restores preserved blocks into the output.
 */

import type { ModelMessage } from "ai";
import { serializeConversation } from "../../orchestrator/compaction.js";
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
 * 4. If over budget, truncate/compress and restore preserved blocks.
 */
export async function compressChat(
  messages: ModelMessage[],
  _systemPrompt: string,
  tokenBudget: number,
  _provider?: unknown,
  _modelId?: string,
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

  // Over budget — truncate to fit budget while keeping preserved blocks
  // Calculate space taken by preserved blocks
  const preservedTokens = blocks.reduce((sum, b) => sum + Math.ceil(b.content.length / 4), 0);
  const availableTokens = Math.max(0, tokenBudget - preservedTokens);
  const availableChars = availableTokens * 4;

  // Truncate the cleaned text to fit
  const truncated =
    cleaned.length > availableChars
      ? `${cleaned.slice(0, availableChars)}\n\n[... ${cleaned.length - availableChars} characters truncated]`
      : cleaned;

  const restored = restorePreservedBlocks(truncated, blocks);
  return {
    summary: restored,
    preservedBlocks: blocks,
    tokensAfter: Math.ceil(restored.length / 4),
  };
}
