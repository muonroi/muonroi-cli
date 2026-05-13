import * as fs from "node:fs";
import type { ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import { getDefaultEEClient } from "../ee/intercept.js";
import { emitMatches } from "../ee/render.js";
import type { McpToolBundle } from "../mcp/runtime.js";
import { buildMcpToolSet } from "../mcp/runtime.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../providers/runtime.js";
import type { BashTool } from "../tools/bash.js";
import { createBuiltinTools as createTools } from "../tools/registry.js";
import type { AgentMode, CouncilStatusPhase, StreamChunk } from "../types/index.js";
import { appendCostLog } from "../usage/cost-log.js";
import { projectCostUSD } from "../usage/estimator.js";
import { loadMcpServers } from "../utils/settings.js";
import { buildResearchSystemPrompt } from "./prompts.js";
import type { CouncilLLM, CouncilStats, ToolTraceEmitter, UsageCallback } from "./types.js";

// ── Debug logging (off unless MUONROI_COUNCIL_DEBUG_LOG points at a writable file) ──
//
// Writes a JSONL record per llm.{generate,debate,research} call with full input
// sizes, output text, reasoning text, finish reason, usage tokens, and errors.
// Used by scripts/e2e-council-debug.ts to confirm WHY a turn returned empty —
// e.g. reasoning model exhausting maxTokens on thinking-only output.

interface DebugCallRecord {
  ts: string;
  kind: "generate" | "debate" | "research";
  modelId: string;
  resolvedModelId?: string;
  provider?: string;
  systemChars: number;
  promptChars: number;
  maxTokens?: number;
  durationMs: number;
  ok: boolean;
  textChars: number;
  textHead: string;
  reasoningChars?: number;
  reasoningHead?: string;
  finishReason?: string;
  toolCallCount?: number;
  toolNames?: string[];
  usage?: unknown;
  error?: string;
}

function getDebugLogPath(): string | null {
  const p = process.env.MUONROI_COUNCIL_DEBUG_LOG;
  return p && p.length > 0 ? p : null;
}

function writeDebugRecord(rec: DebugCallRecord): void {
  const path = getDebugLogPath();
  if (!path) return;
  try {
    fs.appendFileSync(path, JSON.stringify(rec) + "\n", "utf-8");
  } catch {
    // Logging must never break the council run.
  }
}

function head(s: unknown, n = 300): string {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  return str.length > n ? str.slice(0, n) + "…" : str;
}

// ── Tool trace helpers (CQ-22) ────────────────────────────────────────────────

const TRACE_ARG_LIMIT = 2048;

function truncate(value: unknown): string {
  const s = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return s.length > TRACE_ARG_LIMIT ? s.slice(0, TRACE_ARG_LIMIT) + "…[truncated]" : s;
}

function emitToolTrace(toolName: string, args: unknown, result: unknown, persistTrace?: ToolTraceEmitter): void {
  if (!persistTrace) return;
  const traceText = `[Council Tool Trace] tool=${toolName} ` + `args=${truncate(args)} ` + `result=${truncate(result)}`;
  persistTrace(traceText);
}

/**
 * Maximum size (in characters) of any single tool result that we feed back to
 * the model between debate steps. Without this cap a single grep / web-fetch
 * can put 100s of KB into the next step's context, and with stepCountIs(4)
 * the per-call message stack inflates quadratically across rounds — the root
 * cause of "Request Entity Too Large" and 3M-token-against-1M-limit errors
 * we observed in real sessions.
 *
 * 8KB per tool result × 4 steps × N participants × rounds keeps the worst
 * case in the hundreds-of-KB range instead of the multi-MB range, while
 * preserving enough content for evidence-based debate.
 */
const TOOL_RESULT_CAP_CHARS = 8000;

function capToolResult(result: unknown): unknown {
  if (result == null) return result;
  if (typeof result === "string") {
    return result.length > TOOL_RESULT_CAP_CHARS
      ? result.slice(0, TOOL_RESULT_CAP_CHARS) +
          `\n…[truncated to ${TOOL_RESULT_CAP_CHARS} chars by council to protect context]`
      : result;
  }
  try {
    const serialized = JSON.stringify(result);
    if (serialized.length <= TOOL_RESULT_CAP_CHARS) return result;
    // Object too large — fall back to a string summary so the model still has
    // a usable, smaller payload instead of the raw blob.
    return {
      _truncated: true,
      _originalSize: serialized.length,
      preview: serialized.slice(0, TOOL_RESULT_CAP_CHARS) + "…",
    };
  } catch {
    return result;
  }
}

/**
 * Wrap each tool in the set with EE PreToolUse intercept check AND cap the
 * result size that flows back into the LLM between steps. Both behaviors are
 * applied for every debate-time tool call.
 */
function wrapToolsWithEeCheck(tools: ToolSet, tenantId: string): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof (tool as { execute?: unknown }).execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (args: unknown, opts: unknown) => {
        // Fire EE PreToolUse intercept (non-blocking, fail-open)
        try {
          const client = getDefaultEEClient();
          const resp = await client.intercept({
            toolName: name,
            toolInput: args,
            cwd: process.cwd(),
            tenantId,
            scope: { kind: "global" },
          });
          emitMatches(resp?.matches);
        } catch {
          /* fail-open — tool must execute regardless */
        }
        const raw = await (tool as { execute: (args: unknown, opts: unknown) => unknown }).execute(args, opts);
        return capToolResult(raw);
      },
    };
  }
  return wrapped;
}

/**
 * Extract token counts from an AI SDK `generateText` result.usage object.
 * Defensive — different providers expose slightly different field names.
 */
function extractUsage(raw: unknown): { inputTokens: number; outputTokens: number; cachedInputTokens: number } {
  const u = (raw ?? {}) as Record<string, unknown>;
  const details = (u.inputTokenDetails ?? {}) as Record<string, unknown>;
  const rawNested = (u.raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.inputTokens) || num(u.promptTokens),
    outputTokens: num(u.outputTokens) || num(u.completionTokens),
    cachedInputTokens:
      num(u.cachedInputTokens) || num(details.cacheReadTokens) || num(rawNested.prompt_cache_hit_tokens),
  };
}

/**
 * Best-effort cost-log append for council LLM calls. Failures are swallowed.
 * Returns the parsed usage so callers can forward it via an onUsage callback
 * (sprint-runner uses this to commit with real token counts, not chars/4).
 */
function logCouncilCost(args: {
  callsite: string;
  role?: string;
  provider: string;
  modelId: string;
  rawUsage: unknown;
  systemChars: number;
  promptChars: number;
  durationMs: number;
  stepCount?: number;
}): { inputTokens: number; outputTokens: number; cachedInputTokens: number } {
  const usage = extractUsage(args.rawUsage);
  appendCostLog({
    ts: Date.now() - args.durationMs,
    provider: args.provider,
    model: args.modelId,
    estimatedUsd: projectCostUSD(args.provider, args.modelId, usage.inputTokens, usage.outputTokens),
    callsite: args.callsite,
    role: args.role,
    phase: "council",
    systemChars: args.systemChars,
    promptChars: args.promptChars,
    actualInputTokens: usage.inputTokens,
    actualOutputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    stepCount: args.stepCount,
    durationMs: args.durationMs,
  }).catch(() => undefined);
  return usage;
}

export function createCouncilLLM(
  bash: BashTool,
  mode: AgentMode,
  sessionId: string | undefined,
  stats: CouncilStats,
): CouncilLLM {
  return {
    async generate(
      modelId: string,
      system: string,
      prompt: string,
      maxTokens = 4096,
      onUsage?: UsageCallback,
    ): Promise<string> {
      const providerId = detectProviderForModel(modelId);
      const key = await loadKeyForProvider(providerId);
      const { factory } = createProviderFactory(providerId, { apiKey: key });
      const runtime = resolveModelRuntime(factory, modelId);
      const t0 = Date.now();
      try {
        const result = await generateText({
          model: runtime.model,
          system,
          prompt,
          maxOutputTokens: maxTokens,
          temperature: 0.7,
          // AI SDK default is 2 retries (3 attempts). SiliconFlow's per-key
          // rate limit on DeepSeek V4 fires bursty 429s during council debate
          // (parallel pairs + leader-eval + summary calls). Bumping to 5 with
          // the SDK's default exponential backoff (2,4,8,16,32s) absorbs most
          // short-window limits — session 9229af5db247 hit "Failed after 3
          // attempts. Last error: Too Many Requests" on the leader research-
          // need eval after the parallel debate burst.
          maxRetries: 5,
          ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
        });
        stats.calls++;
        const durMs = Date.now() - t0;
        const callUsage = logCouncilCost({
          callsite: "council.generate",
          provider: providerId,
          modelId,
          rawUsage: (result as { usage?: unknown }).usage,
          systemChars: system.length,
          promptChars: prompt.length,
          durationMs: durMs,
        });
        onUsage?.(callUsage);
        writeDebugRecord({
          ts: new Date().toISOString(),
          kind: "generate",
          modelId,
          resolvedModelId: runtime.modelInfo?.id,
          provider: providerId,
          systemChars: system.length,
          promptChars: prompt.length,
          maxTokens,
          durationMs: durMs,
          ok: true,
          textChars: (result.text ?? "").length,
          textHead: head(result.text),
          reasoningChars: (result as { reasoningText?: string }).reasoningText?.length,
          reasoningHead: head((result as { reasoningText?: string }).reasoningText ?? ""),
          finishReason: (result as { finishReason?: string }).finishReason,
          usage: (result as { usage?: unknown }).usage,
        });
        return result.text;
      } catch (err) {
        writeDebugRecord({
          ts: new Date().toISOString(),
          kind: "generate",
          modelId,
          resolvedModelId: runtime.modelInfo?.id,
          provider: providerId,
          systemChars: system.length,
          promptChars: prompt.length,
          maxTokens,
          durationMs: Date.now() - t0,
          ok: false,
          textChars: 0,
          textHead: "",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },

    async debate(
      modelId: string,
      system: string,
      prompt: string,
      signal?: AbortSignal,
      persistTrace?: ToolTraceEmitter,
      options?: { enableVerificationTools?: boolean },
      onUsage?: UsageCallback,
    ): Promise<{ text: string; toolCalls: Array<{ toolName: string; result?: unknown }> }> {
      const providerId = detectProviderForModel(modelId);
      const key = await loadKeyForProvider(providerId);
      const { factory } = createProviderFactory(providerId, { apiKey: key });
      const runtime = resolveModelRuntime(factory, modelId);

      // Verification tools — re-introduced after the no-tools fix (session
      // a7a5690d2049). The original failure was stepCountIs(4) + full toolset
      // letting reasoning models exhaust steps on exploratory tool chains and
      // return text="" finishReason="tool-calls". We now expose a TINY
      // read-only set (grep, read_file) under stepCountIs(2) — at most one
      // verification call, then forced text. Tier gate: only balanced/premium
      // models get tools (fast/reasoning-heavy Flash variants skip them).
      let verificationTools: ToolSet | undefined;
      let mcpBundleForDebate: McpToolBundle | null = null;
      if (options?.enableVerificationTools) {
        try {
          const builtins = createTools(bash, mode);
          // Strict allowlist — NO bash/edit/write/task in debate verification.
          const ALLOWED = new Set(["grep", "read_file"]);
          const filtered: ToolSet = {};
          for (const [name, tool] of Object.entries(builtins)) {
            if (ALLOWED.has(name)) filtered[name] = tool;
          }
          // Optional MCP read-only tools (web_fetch / web_search / context7).
          try {
            mcpBundleForDebate = await buildMcpToolSet(loadMcpServers());
            if (mcpBundleForDebate?.tools) {
              for (const [name, tool] of Object.entries(mcpBundleForDebate.tools)) {
                if (/tavily|web[_-]?fetch|web[_-]?search|context7|firecrawl|exa/i.test(name)) {
                  filtered[name] = tool;
                }
              }
            }
          } catch {
            /* MCP optional — debate continues with builtins only */
          }
          verificationTools = wrapToolsWithEeCheck(filtered, sessionId ?? "council-debate");
        } catch {
          /* fail-open: no tools */
        }
      }

      const t0 = Date.now();
      try {
        const result = await generateText({
          model: runtime.model,
          system,
          prompt,
          ...(verificationTools && Object.keys(verificationTools).length > 0
            ? { tools: verificationTools, stopWhen: stepCountIs(2) }
            : {}),
          // Reasoning models (deepseek-v4-*, anthropic thinking) consume part
          // of this budget on reasoning_tokens before producing user-visible
          // text. E2E showed 2048 caused finishReason=length on 3KB debate
          // prompts. 6144 leaves ~4000 tokens for text after typical reasoning
          // overhead and avoids cuts mid-thought.
          maxOutputTokens: 6144,
          temperature: 0.7,
          // See generate() note — debate fires several pairs concurrently;
          // 5 retries with SDK exponential backoff (2,4,8,16,32s) survive
          // SiliconFlow's short-window 429s without escalating to user.
          maxRetries: 5,
          ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
          ...(signal ? { abortSignal: signal } : {}),
        });
        stats.calls++;
        // No tool calls expected, but the AI SDK shape still has the field —
        // pass through for type compatibility.
        const toolCalls = (result.toolCalls ?? []) as Array<{
          toolName: string;
          args?: unknown;
          input?: unknown;
          result?: unknown;
        }>;
        for (const tc of toolCalls) {
          emitToolTrace(tc.toolName, tc.args ?? tc.input ?? {}, tc.result, persistTrace);
        }
        const debateUsage = logCouncilCost({
          callsite: "council.debate",
          role: "debater",
          provider: providerId,
          modelId,
          rawUsage: (result as { usage?: unknown }).usage,
          systemChars: system.length,
          promptChars: prompt.length,
          durationMs: Date.now() - t0,
          stepCount: toolCalls.length,
        });
        onUsage?.(debateUsage);
        writeDebugRecord({
          ts: new Date().toISOString(),
          kind: "debate",
          modelId,
          resolvedModelId: runtime.modelInfo?.id,
          provider: providerId,
          systemChars: system.length,
          promptChars: prompt.length,
          maxTokens: 6144,
          durationMs: Date.now() - t0,
          ok: true,
          textChars: (result.text ?? "").length,
          textHead: head(result.text),
          reasoningChars: (result as { reasoningText?: string }).reasoningText?.length,
          reasoningHead: head((result as { reasoningText?: string }).reasoningText ?? ""),
          finishReason: (result as { finishReason?: string }).finishReason,
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map((t) => t.toolName),
          usage: (result as { usage?: unknown }).usage,
        });
        return {
          text: result.text,
          toolCalls: toolCalls as Array<{ toolName: string; result?: unknown }>,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeDebugRecord({
          ts: new Date().toISOString(),
          kind: "debate",
          modelId,
          resolvedModelId: runtime.modelInfo?.id,
          provider: providerId,
          systemChars: system.length,
          promptChars: prompt.length,
          maxTokens: 6144,
          durationMs: Date.now() - t0,
          ok: false,
          textChars: 0,
          textHead: "",
          error: errMsg,
        });
        return { text: `[debate failed: ${errMsg}]`, toolCalls: [] };
      } finally {
        await mcpBundleForDebate?.close().catch(() => {});
      }
    },

    async research(
      modelId: string,
      topic: string,
      conversationContext: string,
      signal?: AbortSignal,
      persistTrace?: ToolTraceEmitter,
      options?: { internetFirst?: boolean },
      onUsage?: UsageCallback,
    ): Promise<string> {
      const providerId = detectProviderForModel(modelId);
      const key = await loadKeyForProvider(providerId);
      const { factory } = createProviderFactory(providerId, { apiKey: key });
      const runtime = resolveModelRuntime(factory, modelId);

      const builtinTools = createTools(bash, mode);

      // CQ-03: Lazy MCP bundle per research call — fail-open so builtins remain available
      let mcpBundle: McpToolBundle | null = null;
      try {
        mcpBundle = await buildMcpToolSet(loadMcpServers());
      } catch {
        // MCP spawn failed — research continues with builtin tools only
      }

      const mergedResearchTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };
      const allTools: ToolSet = wrapToolsWithEeCheck(mergedResearchTools, sessionId ?? "council-research");

      // CQ-04: Detect URL in topic — inject mandatory browser instruction into system prompt
      const hasUrl = /https?:\/\/\S+/.test(topic);
      const internetFirst = options?.internetFirst === true;
      const systemPrompt = buildResearchSystemPrompt(hasUrl, internetFirst);

      // Warn early if internet-first mode is requested but no internet/browser tools are loaded.
      const internetToolAvailable = Object.keys(allTools).some((n) =>
        /tavily|web[_-]?fetch|web[_-]?search|playwright|chrome|context7|firecrawl|exa/i.test(n),
      );
      const internetGapWarning =
        internetFirst && !internetToolAvailable
          ? `\n\n## Research Gap\n- Internet-first mode requested but no browser/search tool ` +
            `(tavily, web-fetch, playwright, chrome-devtools, context7) is available. ` +
            `Findings will be limited to what the model already knows.`
          : "";

      const userPrompt = conversationContext
        ? `## Context\n${conversationContext}\n\n---\n\n## Research Topic\n${topic}\n\nInvestigate and report findings.`
        : `## Research Topic\n${topic}\n\nInvestigate and report findings.`;

      const t0 = Date.now();
      try {
        const result = await generateText({
          model: runtime.model,
          system: systemPrompt,
          prompt: userPrompt,
          tools: allTools,
          stopWhen: stepCountIs(15),
          maxOutputTokens: 4096,
          temperature: 0.3,
          // See generate() note — research can fire after a heavy debate burst
          // and hit the same SiliconFlow short-window 429s.
          maxRetries: 5,
          ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
          ...(signal ? { abortSignal: signal } : {}),
        });
        const researchUsage = logCouncilCost({
          callsite: "council.research",
          role: "researcher",
          provider: providerId,
          modelId,
          rawUsage: (result as { usage?: unknown }).usage,
          systemChars: systemPrompt.length,
          promptChars: userPrompt.length,
          durationMs: Date.now() - t0,
          stepCount: (result.toolCalls ?? []).length,
        });
        onUsage?.(researchUsage);
        writeDebugRecord({
          ts: new Date().toISOString(),
          kind: "research",
          modelId,
          resolvedModelId: runtime.modelInfo?.id,
          provider: providerId,
          systemChars: systemPrompt.length,
          promptChars: userPrompt.length,
          maxTokens: 4096,
          durationMs: Date.now() - t0,
          ok: true,
          textChars: (result.text ?? "").length,
          textHead: head(result.text),
          reasoningChars: (result as { reasoningText?: string }).reasoningText?.length,
          reasoningHead: head((result as { reasoningText?: string }).reasoningText ?? ""),
          finishReason: (result as { finishReason?: string }).finishReason,
          toolCallCount: (result.toolCalls ?? []).length,
          toolNames: (result.toolCalls ?? []).map((t) => (t as { toolName: string }).toolName),
          usage: (result as { usage?: unknown }).usage,
        });

        // Emit tool traces (CQ-22)
        const researchToolCalls = (result.toolCalls ?? []) as Array<{
          toolName: string;
          args?: unknown;
          input?: unknown;
          result?: unknown;
        }>;
        for (const tc of researchToolCalls) {
          emitToolTrace(tc.toolName, tc.args ?? tc.input ?? {}, tc.result, persistTrace);
        }

        // CQ-04: When URL present, verify at least one browser tool was invoked
        if (hasUrl) {
          // Use result.toolCalls (flat array across all steps) — more reliably typed than steps[].toolCalls
          const browserUsed = researchToolCalls.some(
            (tc) => tc.toolName.includes("playwright") || tc.toolName.includes("chrome"),
          );
          if (!browserUsed) {
            stats.calls++;
            return (
              result.text +
              "\n\n## Research Gap\n" +
              "- URL was present in topic but no browser tool was invoked. " +
              "Frontend findings unverified."
            );
          }
        }

        stats.calls++;
        return result.text + internetGapWarning;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeDebugRecord({
          ts: new Date().toISOString(),
          kind: "research",
          modelId,
          resolvedModelId: runtime.modelInfo?.id,
          provider: providerId,
          systemChars: systemPrompt.length,
          promptChars: userPrompt.length,
          maxTokens: 4096,
          durationMs: Date.now() - t0,
          ok: false,
          textChars: 0,
          textHead: "",
          error: errMsg,
        });
        return (
          `## Source Code Findings\n[Research failed: ${errMsg}]\n\n` +
          `## Internet Findings\n_Not performed._\n\n` +
          `## Frontend Findings (live)\n_Not performed._`
        );
      } finally {
        await mcpBundle?.close().catch(() => {});
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
