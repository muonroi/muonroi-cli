/**
 * Two-pass compaction orchestrator.
 *
 * Pass 1: Extract decisions/facts/constraints to decisions.md (deterministic).
 * Pass 2: Compress chat within token budget, preserving verbatim blocks.
 * Snapshot full chat to history/<timestamp>.md before compressing.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { ModelMessage } from "ai";
import { serializeConversation, estimateConversationTokens } from "../../orchestrator/compaction.js";
import { atomicWriteText } from "../../storage/atomic-io.js";
import { readArtifact, writeArtifact } from "../artifact-io.js";
import { extractDecisions } from "./extract.js";
import { compressChat } from "./compress.js";

export interface CompactionResult {
  decisionsExtracted: number;
  tokensBeforeCompress: number;
  tokensAfterCompress: number;
  historyPath: string;
}

/**
 * Orchestrate two-pass deliberate compaction.
 *
 * 1. Pass 1: extractDecisions -> append to decisions.md
 * 2. Snapshot: full chat -> history/<ISO-timestamp>.md
 * 3. Pass 2: compressChat -> compressed output
 * 4. Return metrics
 */
export async function deliberateCompact(
  flowDir: string,
  messages: ModelMessage[],
  systemPrompt: string,
  tokenBudget: number,
  provider?: unknown,
  modelId?: string,
): Promise<CompactionResult> {
  // Pass 1: Extract decisions/facts/constraints
  const extracted = extractDecisions(messages);
  const totalExtracted =
    extracted.decisions.length +
    extracted.facts.length +
    extracted.constraints.length;

  // Append to decisions.md
  if (totalExtracted > 0) {
    let existing = await readArtifact(flowDir, "decisions.md");
    if (!existing) {
      existing = { preamble: "", sections: new Map() };
    }

    const appendItems = (heading: string, items: string[]) => {
      if (items.length === 0) return;
      const current = existing!.sections.get(heading) ?? "";
      const newContent = items.map((i) => `- ${i}`).join("\n");
      existing!.sections.set(
        heading,
        current ? `${current}\n${newContent}` : newContent,
      );
    };

    appendItems("Decisions", extracted.decisions);
    appendItems("Facts", extracted.facts);
    appendItems("Constraints", extracted.constraints);

    await writeArtifact(flowDir, "decisions.md", existing, [
      "Decisions",
      "Facts",
      "Constraints",
    ]);
  }

  // Snapshot full chat to history/
  const historyDir = path.join(flowDir, "history");
  await fs.mkdir(historyDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const historyPath = path.join(historyDir, `${timestamp}.md`);
  const fullSerialized = serializeConversation(messages);
  await atomicWriteText(historyPath, fullSerialized);

  // Token estimation before
  const tokensBefore = estimateConversationTokens(systemPrompt, messages);

  // Pass 2: Compress
  const compressed = await compressChat(
    messages,
    systemPrompt,
    tokenBudget,
    provider,
    modelId,
  );

  return {
    decisionsExtracted: totalExtracted,
    tokensBeforeCompress: tokensBefore,
    tokensAfterCompress: compressed.tokensAfter,
    historyPath,
  };
}
