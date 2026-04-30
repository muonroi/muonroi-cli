/**
 * Pass 1: Decision/fact/constraint extraction from messages.
 *
 * Deterministic regex-based extraction — no LLM dependency.
 * Scans for "Decision:", "Decided:", "Fact:", "Constraint:" patterns
 * and content inside <!-- preserve --> blocks.
 */

import type { ModelMessage } from "ai";
import { serializeConversation } from "../../orchestrator/compaction.js";
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
 * Scans serialized conversation text for:
 * - Lines matching "Decision:" or "Decided:" -> decisions
 * - Lines matching "Fact:" -> facts
 * - Lines matching "Constraint:" -> constraints
 * - All content inside <!-- preserve --> blocks -> decisions (verbatim)
 */
export function extractDecisions(messages: ModelMessage[]): ExtractedDecisions {
  if (messages.length === 0) {
    return { decisions: [], facts: [], constraints: [] };
  }

  const serialized = serializeConversation(messages);

  // Extract preserved blocks as decisions
  const { blocks } = extractPreservedBlocks(serialized);
  const preservedDecisions = blocks.map((b) => b.content);

  // Pattern-match for explicit markers
  const decisions = [
    ...matchAll(serialized, DECISION_RE),
    ...preservedDecisions,
  ];
  const facts = matchAll(serialized, FACT_RE);
  const constraints = matchAll(serialized, CONSTRAINT_RE);

  return { decisions, facts, constraints };
}
