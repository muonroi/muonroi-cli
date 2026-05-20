import { generateText, type ModelMessage } from "ai";
import { getProviderCapabilities } from "../providers/capabilities.js";
import type { ProviderFactory as LegacyProvider } from "../providers/runtime.js";
import { resolveModelRuntime } from "../providers/runtime.js";
import { containsEncryptedReasoning } from "./reasoning";
import { countTokens } from "./token-counter.js";

export interface CompactionSettings {
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface CutPointResult {
  firstKeptIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

export interface PreparedCompaction {
  previousSummary?: string;
  messagesToSummarize: ModelMessage[];
  turnPrefixMessages: ModelMessage[];
  keptMessages: ModelMessage[];
  firstKeptIndex: number;
  isSplitTurn: boolean;
  tokensBefore: number;
  settings: CompactionSettings;
}

const TOOL_RESULT_MAX_CHARS = 8000;
const MIN_KEPT_TOKENS_ON_RETRY = 4000;

export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const POST_TURN_MIN_TOKENS = 2_000;
export const COMPACTION_MAX_OUTPUT_TOKENS = 4_096;
export const TOOL_RESULT_MAX_CHARS_CONFIGURABLE = 8000;
export const COMPACTION_SUMMARY_HEADER = "[Context checkpoint summary]";

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant.

Do not continue the conversation. Do not answer any questions from the conversation.
Only output a structured checkpoint summary that another coding agent can use to continue the work.

CRITICAL: The agent reading this summary must NEVER redo completed work. Mark completed items clearly.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this exact format:

## Goal
[What the user is trying to accomplish]

## Active Plan
- **Plan file**: [path to PLAN.md or plan document being followed, or "(none)" if no explicit plan]
- **Plan step**: [current step number and description, e.g. "Step 3/7: implement layer6-output.ts", or "(none)"]
- **Plan source**: [e.g. "/gsd:execute-phase", "/gsd:quick", "manual", or "(none)"]

## Constraints & Preferences
- [Requirements, preferences, or constraints]
- [(none) if none were mentioned]

## Progress
### ✅ DONE — DO NOT REDO
- [x] [Completed work — be specific: file changed, test passed, command ran]

### 🔄 In Progress (resume here)
- [ ] [Current work with exact state: e.g. "editing src/foo.ts — halfway through refactor"]

### ❌ Blocked
- [Any active blockers with root cause if known]

## Session Notes
- [Important observations, warnings, or gotchas discovered during the session]
- [(none) if not applicable]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [The very next action to take — be specific enough that the agent can act without re-reading the conversation]

## Critical Context
- [Important details needed to continue]
- [(none) if not applicable]

## Critical Data
- **File paths mentioned**: [list all file paths exactly as they appear]
- **Function/method names**: [list all function/method names]
- **Error messages**: [copy verbatim any error messages]
- **Key numbers/results**: [list important numbers, query results, or metrics]

Keep it concise, but preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are new conversation messages to incorporate into the existing summary provided below.

Update the existing structured summary with new information. Rules:
- Preserve still-relevant information from the previous summary
- Add new progress, decisions, and critical context
- Move completed items from "In Progress" to "Done" (✅ DONE — DO NOT REDO) when appropriate
- Update "Active Plan" step if the current step has advanced
- Update "Next Steps" based on the current state
- Append new observations to "Session Notes"
- Preserve exact file paths, function names, and error messages

## Critical Data
- Preserve exact file paths, function names, error messages (verbatim), and key numbers/results

Use the exact same section structure as the existing summary format.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the early prefix of a single turn that was too large to keep in full. The recent suffix is still available.

Summarize only what is needed so another coding agent can understand the retained suffix.
CRITICAL: List all completed steps explicitly so the agent does not redo them.

Use this exact format:

## Original Request
[What the user asked for in this turn]

## Early Progress — COMPLETED (DO NOT REDO)
- [x] [Each completed step before the suffix — be specific: file edited, test ran, etc.]

## Current State
- [Exact state at the cut point: what was just done, what variable/file is mid-edit]

## Context For Suffix
- [Information needed to understand the kept recent messages]`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      if (!containsEncryptedReasoning(part.text)) {
        parts.push(part.text);
      }
      continue;
    }
    if (part.type === "reasoning" && typeof part.reasoning === "string") {
      if (!containsEncryptedReasoning(part.reasoning)) {
        parts.push(part.reasoning);
      }
    }
  }
  return parts;
}

function stringifyForSummary(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateForSummary(text: string, maxChars = TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  // Keep head + tail. Errors, exit codes, and summaries usually live at the end of long
  // tool outputs; head-only truncation routinely drops the most diagnostic lines.
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const omitted = text.length - maxChars;
  return `${text.slice(0, headChars)}\n\n[... ${omitted} more characters truncated ...]\n\n${text.slice(-tailChars)}`;
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

const DEDUP_MIN_CHARS = 500;

/**
 * Dedup identical tool-result payloads inside a slice destined for summarization.
 * Repeated reads of an unchanged file inflate the summarize prompt with
 * (truncated) duplicates that cost tokens and add zero new context.
 */
function dedupToolResultsWithState(messages: ModelMessage[], seenHashes: Set<string>): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;
    const parts = msg.content as unknown[];
    const newContent = parts.map((part) => {
      if (!isRecord(part) || part.type !== "tool-result") return part;
      const serialized = stringifyForSummary((part as Record<string, unknown>).output);
      if (serialized.length < DEDUP_MIN_CHARS) return part;
      const hash = hashString(serialized);
      if (seenHashes.has(hash)) {
        const toolName =
          typeof (part as Record<string, unknown>).toolName === "string"
            ? ((part as Record<string, unknown>).toolName as string)
            : "tool";
        return {
          ...(part as Record<string, unknown>),
          output: `[Identical to earlier ${toolName} result; ${serialized.length} chars elided]`,
        };
      }
      seenHashes.add(hash);
      return part;
    });
    return { ...msg, content: newContent as typeof msg.content };
  });
}

export function extractUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "image") {
      parts.push("[Image]");
      continue;
    }
    if (part.type === "file") {
      const filename = typeof part.filename === "string" ? part.filename : null;
      parts.push(filename ? `[File: ${filename}]` : "[File]");
    }
  }
  return parts.join("\n");
}

function extractAssistantText(content: unknown): string {
  return getTextParts(content).join("\n");
}

function extractToolCallText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const toolCalls: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool-call") continue;
    const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
    const input = isRecord(part.input) ? part.input : {};
    const args = Object.entries(input)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    toolCalls.push(`${toolName}(${args})`);
  }
  return toolCalls;
}

function extractToolResultText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const toolResults: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool-result") continue;
    toolResults.push(truncateForSummary(stringifyForSummary(part.output)));
  }
  return toolResults;
}

export function createCompactionSummaryMessage(summary: string): ModelMessage {
  return {
    role: "system",
    content: `${COMPACTION_SUMMARY_HEADER}\n${summary.trim()}`,
  };
}

export function isCompactionSummaryMessage(message: ModelMessage | undefined): boolean {
  return message?.role === "system" && typeof message.content === "string"
    ? message.content.startsWith(COMPACTION_SUMMARY_HEADER)
    : false;
}

export function getCompactionSummaryText(message: ModelMessage | undefined): string | null {
  if (!isCompactionSummaryMessage(message) || typeof message?.content !== "string") {
    return null;
  }
  return message.content.slice(COMPACTION_SUMMARY_HEADER.length).trim();
}

function messageToString(message: ModelMessage): string {
  switch (message.role) {
    case "user":
      return extractUserContent(message.content);
    case "assistant": {
      const text = extractAssistantText(message.content);
      const toolCalls = extractToolCallText(message.content).join("; ");
      return toolCalls ? `${text}\n${toolCalls}` : text;
    }
    case "tool":
      return extractToolResultText(message.content).join("\n");
    case "system":
      return typeof message.content === "string" ? message.content : getTextParts(message.content).join("\n");
    default:
      return stringifyForSummary((message as { content?: unknown }).content);
  }
}

export function estimateMessageTokens(message: ModelMessage): number {
  return countTokens(messageToString(message));
}

export function estimateConversationTokens(systemPrompt: string, messages: ModelMessage[], inFlightText = ""): number {
  const systemTokens = countTokens(systemPrompt) + (inFlightText ? countTokens(inFlightText) : 0);
  return systemTokens + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function shouldCompactContext(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  return contextTokens > contextWindow - settings.reserveTokens;
}

function isValidCutPoint(message: ModelMessage): boolean {
  return message.role !== "tool";
}

function findTurnStartIndex(messages: ModelMessage[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return -1;
}

export function findCutPoint(messages: ModelMessage[], startIndex: number, keepRecentTokens: number): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    if (isValidCutPoint(messages[i])) {
      cutPoints.push(i);
    }
  }

  if (cutPoints.length === 0) {
    return { firstKeptIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];

  for (let i = messages.length - 1; i >= startIndex; i--) {
    accumulatedTokens += estimateMessageTokens(messages[i]);
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex = cutPoints.find((index) => index >= i) ?? cutPoints[cutPoints.length - 1];
      break;
    }
  }

  const cutMessage = messages[cutIndex];
  const isUserMessage = cutMessage?.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(messages, cutIndex, startIndex);

  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

export function prepareCompaction(
  messages: ModelMessage[],
  systemPrompt: string,
  settings: CompactionSettings,
): PreparedCompaction | null {
  const previousSummary = getCompactionSummaryText(messages[0]) ?? undefined;
  const boundaryStart = previousSummary ? 1 : 0;
  if (boundaryStart >= messages.length) {
    return null;
  }

  const cutPoint = findCutPoint(messages, boundaryStart, settings.keepRecentTokens);
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptIndex;
  const rawHistory = messages.slice(boundaryStart, Math.max(boundaryStart, historyEnd));
  const rawTurnPrefix = cutPoint.isSplitTurn ? messages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex) : [];
  // Shared dedup state — second occurrence of a duplicate tool-result gets stubbed
  // even when the first occurrence is in the history slice and the second in the prefix.
  const dedupState = new Set<string>();
  const messagesToSummarize = dedupToolResultsWithState(rawHistory, dedupState);
  const turnPrefixMessages = dedupToolResultsWithState(rawTurnPrefix, dedupState);
  // keptMessages stay verbatim — they live in the active conversation, not the summarize prompt.
  const keptMessages = messages.slice(cutPoint.firstKeptIndex);
  const tokensBefore = estimateConversationTokens(systemPrompt, messages);

  if (keptMessages.length === 0) {
    return null;
  }

  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return null;
  }

  return {
    previousSummary,
    messagesToSummarize,
    turnPrefixMessages,
    keptMessages,
    firstKeptIndex: cutPoint.firstKeptIndex,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    settings,
  };
}

export function relaxCompactionSettings(settings: CompactionSettings): CompactionSettings {
  return {
    ...settings,
    keepRecentTokens: Math.max(MIN_KEPT_TOKENS_ON_RETRY, Math.floor(settings.keepRecentTokens / 2)),
  };
}

export function serializeConversation(messages: ModelMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (isCompactionSummaryMessage(message)) {
      const summary = getCompactionSummaryText(message);
      if (summary) {
        parts.push(`[Previous summary]: ${summary}`);
      }
      continue;
    }

    if (message.role === "user") {
      const content = extractUserContent(message.content).trim();
      if (content) parts.push(`[User]: ${content}`);
      continue;
    }

    if (message.role === "assistant") {
      const text = extractAssistantText(message.content).trim();
      const toolCalls = extractToolCallText(message.content);
      if (text) parts.push(`[Assistant response]: ${text}`);
      if (toolCalls.length > 0) parts.push(`[Tool call]: ${toolCalls.join("; ")}`);
      continue;
    }

    if (message.role === "tool") {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!isRecord(part)) continue;
          const r = part as Record<string, unknown>;
          if (r.type !== "tool-result") continue;
          const toolName = typeof r.toolName === "string" ? r.toolName : "unknown";
          const result = truncateForSummary(stringifyForSummary(r.output));
          if (result.trim()) parts.push(`[Tool result from ${toolName}]: ${result}`);
        }
      } else {
        // Fallback for string content
        const text = String(message.content).trim();
        if (text) parts.push(`[Tool result]: ${text}`);
      }
      continue;
    }

    if (message.role === "system") {
      const content =
        typeof message.content === "string" ? message.content.trim() : getTextParts(message.content).join("\n").trim();
      if (content) parts.push(`[System]: ${content}`);
    }
  }

  return parts.join("\n\n");
}

export interface CompactionUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompactionSummaryResult {
  summary: string;
  usage: CompactionUsage;
}

function readUsage(usage: unknown): CompactionUsage {
  if (!isRecord(usage)) return { promptTokens: 0, completionTokens: 0 };
  const prompt =
    typeof usage.inputTokens === "number"
      ? usage.inputTokens
      : typeof (usage as Record<string, unknown>).promptTokens === "number"
        ? (usage as { promptTokens: number }).promptTokens
        : 0;
  const completion =
    typeof usage.outputTokens === "number"
      ? usage.outputTokens
      : typeof (usage as Record<string, unknown>).completionTokens === "number"
        ? (usage as { completionTokens: number }).completionTokens
        : 0;
  return { promptTokens: prompt, completionTokens: completion };
}

async function summarizeConversation(
  provider: LegacyProvider,
  modelId: string,
  messages: ModelMessage[],
  reserveTokens: number,
  customInstructions?: string,
  previousSummary?: string,
  promptOverride?: string,
  signal?: AbortSignal,
): Promise<CompactionSummaryResult> {
  const serialized = serializeConversation(messages);
  const promptParts = [serialized];

  if (previousSummary) {
    promptParts.push(`Existing summary:\n${previousSummary}`);
  }

  const basePrompt = promptOverride ?? (previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
  promptParts.push(basePrompt);

  if (customInstructions?.trim()) {
    promptParts.push(`Additional focus: ${customInstructions.trim()}`);
  }

  const runtime = resolveModelRuntime(provider, modelId);
  const compactCaps = getProviderCapabilities(runtime.modelInfo?.provider ?? "anthropic");
  const result = await generateText({
    model: runtime.model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    prompt: promptParts.filter(Boolean).join("\n\n"),
    abortSignal: signal,
    maxRetries: 0,
    temperature: 0.2,
    ...(!compactCaps.acceptsParam("maxOutputTokens", runtime.modelInfo)
      ? {}
      : { maxOutputTokens: Math.min(COMPACTION_MAX_OUTPUT_TOKENS, Math.max(512, Math.floor(reserveTokens * 0.8))) }),
    ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
  });

  return { summary: result.text.trim(), usage: readUsage(result.usage) };
}

function emptyUsage(): CompactionUsage {
  return { promptTokens: 0, completionTokens: 0 };
}

function addUsage(a: CompactionUsage, b: CompactionUsage): CompactionUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  };
}

export async function generateCompactionSummary(
  provider: LegacyProvider,
  modelId: string,
  preparation: PreparedCompaction,
  customInstructions?: string,
  signal?: AbortSignal,
): Promise<CompactionSummaryResult> {
  const { messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary, settings } = preparation;

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const [historyResult, prefixResult] = await Promise.all([
      messagesToSummarize.length > 0
        ? summarizeConversation(
            provider,
            modelId,
            messagesToSummarize,
            settings.reserveTokens,
            customInstructions,
            previousSummary,
            undefined,
            signal,
          )
        : Promise.resolve<CompactionSummaryResult>({ summary: previousSummary?.trim() || "", usage: emptyUsage() }),
      summarizeConversation(
        provider,
        modelId,
        turnPrefixMessages,
        settings.reserveTokens,
        undefined,
        undefined,
        TURN_PREFIX_SUMMARIZATION_PROMPT,
        signal,
      ),
    ]);

    const usage = addUsage(historyResult.usage, prefixResult.usage);
    if (historyResult.summary && prefixResult.summary) {
      return { summary: `${historyResult.summary}\n\n---\n\n${prefixResult.summary}`, usage };
    }
    return { summary: (historyResult.summary || prefixResult.summary).trim(), usage };
  }

  return summarizeConversation(
    provider,
    modelId,
    messagesToSummarize,
    settings.reserveTokens,
    customInstructions,
    previousSummary,
    undefined,
    signal,
  );
}
