/**
 * Pass 1: Decision/fact/constraint extraction from messages.
 *
 * Deterministic regex-based extraction — no LLM dependency.
 * Scans for "Decision:", "Decided:", "Fact:", "Constraint:" patterns
 * and content inside <!-- preserve --> blocks.
 */

import type { ModelMessage } from "ai";
import { generateTextStreamed } from "../../providers/streamed-generate.js";
import { serializeConversation } from "../../orchestrator/compaction.js";
import { resolveModelRuntime, resolveTemperatureParam } from "../../providers/runtime.js";
import { logger } from "../../utils/logger.js";
import { capCompactionInput } from "./input-guard.js";
import { extractPreservedBlocks } from "./preserve.js";

export interface ExtractedDecisions {
  decisions: string[];
  facts: string[];
  constraints: string[];
}

const DECISION_RE = /(?:Decision|Decided):\s*(.+)/gi;
const FACT_RE = /Fact:\s*(.+)/gi;
const CONSTRAINT_RE = /Constraint:\s*(.+)/gi;

function matchAll(text: string, re: RegExp): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex for safety
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

/**
 * Extract decisions, facts, and constraints from messages.
 *
 * Scans serialized conversation text for explicit markers, but if modelId is
 * given, it asks the LLM to intelligently extract them.
 */
export async function extractDecisions(
  messages: ModelMessage[],
  modelId?: string,
  customInstructions?: string,
): Promise<ExtractedDecisions> {
  if (messages.length === 0) {
    return { decisions: [], facts: [], constraints: [] };
  }

  const serialized = serializeConversation(messages);

  // Extract preserved blocks as decisions
  const { blocks } = extractPreservedBlocks(serialized);
  const preservedDecisions = blocks.map((b) => b.content);

  const decisions: string[] = [];
  const facts: string[] = [];
  const constraints: string[] = [];

  let usedLLM = false;

  if (modelId) {
    try {
      const runtime = resolveModelRuntime(modelId);
      const extraPrompt = customInstructions ? `\n\nUSER FOCUS/INSTRUCTIONS:\n${customInstructions}\n` : "";
      // Guard input against the summarizer's context window (see input-guard).
      const guardedInput = capCompactionInput(serialized, runtime.modelInfo?.contextWindow ?? 0);
      // Stream + collect (NOT generateText): codex/oauth 400s non-stream requests.
      const result = await generateTextStreamed({
        model: runtime.model,
        system:
          'You are an AI context compaction agent. Extract all core decisions, technical facts, and project constraints from this conversation. Return strict JSON with { "decisions": string[], "facts": string[], "constraints": string[] }.',
        prompt: `Current conversation messages:\n\n${guardedInput}\n\nExtract decisions, facts, and constraints.${extraPrompt} Return strict JSON ONLY.`,
        ...resolveTemperatureParam(runtime, 0.1),
      });

      const match = result.text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed.decisions)) decisions.push(...parsed.decisions);
        if (Array.isArray(parsed.facts)) facts.push(...parsed.facts);
        if (Array.isArray(parsed.constraints)) constraints.push(...parsed.constraints);
        usedLLM = true;
      }
    } catch (e) {
      // Fall back to regex extraction, but log the reason — a swallowed failure
      // here silently degrades /compact to marker-only extraction.
      logger.error("orchestrator", "extractDecisions LLM failed — falling back to regex", {
        modelId,
        message: (e as Error)?.message,
      });
    }
  }

  if (!usedLLM) {
    decisions.push(...matchAll(serialized, DECISION_RE));
    facts.push(...matchAll(serialized, FACT_RE));
    constraints.push(...matchAll(serialized, CONSTRAINT_RE));
  }

  decisions.push(...preservedDecisions);

  return { decisions, facts, constraints };
}
