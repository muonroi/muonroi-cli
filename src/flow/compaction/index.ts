/**
 * Two-pass compaction orchestrator.
 *
 * Pass 1: Extract decisions/facts/constraints to decisions.md (deterministic).
 * Pass 2: Compress chat within token budget, preserving verbatim blocks.
 * Snapshot full chat to history/<timestamp>.md before compressing.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ModelMessage } from "ai";
import { recordArtifact } from "../../ee/artifact-cache.js";
import { getDefaultEEClient } from "../../ee/intercept.js";
import { estimateConversationTokens, serializeConversation } from "../../orchestrator/compaction.js";
import { atomicWriteText } from "../../storage/atomic-io.js";
import { logger } from "../../utils/logger.js";
import { readArtifact, writeArtifact } from "../artifact-io.js";
import { compressChat } from "./compress.js";
import { extractDecisions } from "./extract.js";

/**
 * Anti-mù for the deliberate (/compact) path — parity with the auto/tool-loop
 * compaction which persists every elided tool output via persistArtifact.
 *
 * deliberateCompact rewrites the whole history into a prose summary, so without
 * this the model loses the ability to `ee_query "tool-artifact id=<id>"` a
 * specific tool result after /compact. We record each tool result into the
 * in-process + disk artifact cache (the tier ee_query reads FIRST, before EE),
 * and fire a best-effort EE extract so cross-session rehydrate also survives.
 * Fail-open: a cache/EE hiccup never blocks the compaction.
 */
export function recordToolArtifactsForRehydrate(messages: ModelMessage[], projectPath: string): number {
  let recorded = 0;
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as Array<Record<string, unknown>>) {
      if (part?.type !== "tool-result") continue;
      const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
      if (!toolCallId) continue;
      const toolName = typeof part.toolName === "string" ? part.toolName : "";
      // AI SDK v5 tool-result payloads live under `output` (typed) or `result`.
      const payload = part.output ?? part.result;
      const content =
        typeof payload === "string"
          ? payload
          : payload == null
            ? ""
            : (() => {
                try {
                  return JSON.stringify(payload);
                } catch {
                  return String(payload);
                }
              })();
      if (!content) continue;
      try {
        recordArtifact(toolCallId, toolName, content);
        recorded++;
        getDefaultEEClient()
          .extract(
            {
              transcript: content.slice(0, 8000),
              projectPath,
              meta: { source: "tool-artifact", toolCallId, toolName, reason: "deliberate-compact" },
            },
            AbortSignal.timeout(700),
          )
          .catch(() => {});
      } catch (err) {
        logger.error("orchestrator", "deliberate-compact artifact record failed", {
          toolCallId,
          message: (err as Error)?.message,
        });
      }
    }
  }
  return recorded;
}

export interface CompactionResult {
  decisionsExtracted: number;
  tokensBeforeCompress: number;
  tokensAfterCompress: number;
  historyPath: string;
  summary: string;
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
  modelId?: string,
  customInstructions?: string,
): Promise<CompactionResult> {
  // Anti-mù parity: persist every tool result to the artifact cache (+ EE)
  // BEFORE we summarize the history away, so the model can still rehydrate a
  // specific tool output via ee_query "tool-artifact id=<id>" after /compact.
  recordToolArtifactsForRehydrate(messages, flowDir);

  // Pass 1: Extract decisions/facts/constraints
  const extracted = await extractDecisions(messages, modelId, customInstructions);
  const totalExtracted = extracted.decisions.length + extracted.facts.length + extracted.constraints.length;

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
      existing!.sections.set(heading, current ? `${current}\n${newContent}` : newContent);
    };

    appendItems("Decisions", extracted.decisions);
    appendItems("Facts", extracted.facts);
    appendItems("Constraints", extracted.constraints);

    await writeArtifact(flowDir, "decisions.md", existing, ["Decisions", "Facts", "Constraints"]);
  }

  // Snapshot full chat to history/
  const historyDir = path.join(flowDir, "history");
  await fs.mkdir(historyDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const historyPath = path.join(historyDir, `${timestamp}.md`);
  const fullSerialized = serializeConversation(messages);
  await atomicWriteText(historyPath, fullSerialized);

  // Save full JSON history next to the md file for exact expand/restore
  const jsonPath = path.join(historyDir, `${timestamp}.json`);
  await atomicWriteText(jsonPath, JSON.stringify(messages, null, 2));

  // Token estimation before
  const tokensBefore = estimateConversationTokens(systemPrompt, messages);

  // Pass 2: Compress
  const compressed = await compressChat(messages, systemPrompt, tokenBudget, modelId, customInstructions);

  return {
    decisionsExtracted: totalExtracted,
    tokensBeforeCompress: tokensBefore,
    tokensAfterCompress: compressed.tokensAfter,
    historyPath,
    summary: compressed.summary,
  };
}
