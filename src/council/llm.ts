import * as fs from "node:fs";
import type { LanguageModel, ToolSet } from "ai";
import { generateText, stepCountIs, streamText } from "ai";
import { getDefaultEEClient } from "../ee/intercept.js";
import { emitMatches } from "../ee/render.js";
import { getMcpKey } from "../mcp/mcp-keychain.js";
import type { McpToolBundle } from "../mcp/runtime.js";
import { buildMcpToolSet } from "../mcp/runtime.js";
import { getModelInfo } from "../models/registry.js";
import { getProviderCapabilities, resolveTemperature } from "../providers/capabilities.js";
import { loadKeyForProvider, ProviderKeyMissingError } from "../providers/keychain.js";
import {
  createProviderFactoryAsync,
  detectProviderForModel,
  type ResolvedModelRuntime,
  resolveModelRuntime,
  shouldDropParam,
} from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { wireDebug } from "../providers/wire-debug.js";
import { statusBarStore } from "../state/status-bar-store.js";
import { recordUsageEvent } from "../storage/index.js";
import type { BashTool } from "../tools/bash.js";
import { createBuiltinTools as createTools } from "../tools/registry.js";
import type { AgentMode, CouncilStatusPhase, StreamChunk } from "../types/index.js";
import { appendCostLog } from "../usage/cost-log.js";
import { projectCostUSD } from "../usage/estimator.js";
import { withDeadlineRace, withTimeoutSignal } from "../utils/llm-deadline.js";
import { logger } from "../utils/logger.js";
import { loadMcpServers } from "../utils/settings.js";
import { withVisibleRetry } from "../utils/visible-retry.js";
import { buildResearchSystemPrompt } from "./prompts.js";
import { stripThinkBlocks } from "./strip-think.js";
import type { CouncilLLM, CouncilStats, ToolTraceEmitter, UsageCallback } from "./types.js";

/**
 * Register a provider factory for a council sub-call, OAuth-aware.
 *
 * A council roster routes stances to providers the session itself never built,
 * so their factory must exist in the registry before `resolveModelRuntime` can
 * derive it from the model id.
 *
 * The council reachability gate (`isProviderReachable` in leader.ts) counts
 * OAuth-authenticated providers as usable (via `getConfiguredProviders`), so a
 * multi-provider roster can route a stance to an OAuth-only provider such as
 * xai/grok. `loadKeyForProvider` is API-key-only and throws
 * `ProviderKeyMissingError` for those — which previously surfaced as
 * "[Error: No API key found for provider 'xai'.]" on every call of that stance,
 * even though the provider was fully authenticated. Mirror the main
 * orchestrator path: fall back to `createProviderFactoryAsync`, which loads +
 * refreshes the stored OAuth bearer token. Only the expected missing-key case
 * is swallowed; unexpected errors propagate.
 */
async function ensureCouncilFactory(providerId: ProviderId): Promise<void> {
  let apiKey: string | undefined;
  try {
    apiKey = await loadKeyForProvider(providerId);
  } catch (err) {
    if (!(err instanceof ProviderKeyMissingError)) throw err;
    // OAuth-only provider — createProviderFactoryAsync injects the bearer token.
  }
  await createProviderFactoryAsync(providerId, apiKey ? { apiKey } : {});
}

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
    fs.appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf-8");
  } catch {
    // Logging must never break the council run.
  }
}

function head(s: unknown, n = 300): string {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// ── Tool trace helpers (CQ-22) ────────────────────────────────────────────────

const TRACE_ARG_LIMIT = 2048;

function truncate(value: unknown): string {
  const s = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return s.length > TRACE_ARG_LIMIT ? `${s.slice(0, TRACE_ARG_LIMIT)}…[truncated]` : s;
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
      preview: `${serialized.slice(0, TOOL_RESULT_CAP_CHARS)}…`,
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

/**
 * Record a council LLM call into the `usage_events` table with source="council".
 *
 * This is the SINGLE source of truth for council usage accounting: it fires from
 * inside every council generate/debate/research call so ALL council entry points
 * (the /council slash path, auto-council, and every /ideal phase — clarifier,
 * research, generate, sprint) land in usage_events. Before this existed, only
 * the loop-driver's `runDebate` call site externally wrapped usage recording, so
 * `runCouncilV2` (/council + auto-council) and the non-debate /ideal phases never
 * recorded — their token cost was invisible to session totals, the StatusBar,
 * `usage forensics`, and the cost caps (root cause of session f24c28b6dcb3:
 * council ran but produced 0 source="council" usage_events).
 *
 * Best-effort: a null sessionId (no chat session FK) or a DB failure must never
 * break the council run, but per the No-Silent-Catch rule we log the failure.
 */
export function recordCouncilUsage(
  sessionId: string | undefined,
  modelId: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): void {
  if (!sessionId) return;
  try {
    recordUsageEvent(sessionId, "council", modelId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedInputTokens,
    });

    // Mirror council billing into the live StatusBar so cache-hit% / tokens /
    // cost reflect the WHOLE session (council calls have ~0 cache; excluding
    // them overstated the message-only cache ratio — session f24c28b6dcb3).
    // ONLY the five cumulative billing counters — NEVER ctx_tokens/ctx_pct/
    // model/provider, which describe the current MAIN-conversation call and
    // would be clobbered by a small council sub-call.
    const totalInput = usage.inputTokens;
    const output = usage.outputTokens;
    const cacheRead = usage.cachedInputTokens;
    const info = getModelInfo(modelId);
    const priceIn = info?.inputPrice ?? 0;
    const priceCached = info?.cachedInputPrice ?? priceIn * 0.1;
    const priceOut = info?.outputPrice ?? 0;
    const nonCachedInput = Math.max(0, totalInput - cacheRead);
    const turnCostMicros = nonCachedInput * priceIn + cacheRead * priceCached + output * priceOut;
    const prev = statusBarStore.getState();
    statusBarStore.setState({
      in_tokens: prev.in_tokens + totalInput,
      out_tokens: prev.out_tokens + output,
      cache_read_tokens: (prev.cache_read_tokens ?? 0) + cacheRead,
      session_usd: prev.session_usd + turnCostMicros / 1_000_000,
    });
  } catch (err) {
    logger.error("storage", "recordUsageEvent(council) failed — token cost not accounted", {
      sessionId,
      modelId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Mock-LLM bypass (agent harness / E2E tests) ──────────────────────────────
//
// When `globalThis.__muonroiMockLlm` is set (injected by --mock-llm startup),
// council LLM calls are short-circuited through the mock fixture rather than
// hitting a real provider.  This mirrors the hook already present in
// src/providers/adapter.ts for the streaming path.

declare global {
  // biome-ignore lint/suspicious/noExplicitAny: intentionally untyped global
  var __muonroiMockLlm: any;
}

function getMockLlm(): { complete(req: { prompt: string }): Promise<{ text: string }> } | null {
  // biome-ignore lint/suspicious/noExplicitAny: intentionally untyped global access
  return (globalThis as any).__muonroiMockLlm ?? null;
}

/**
 * Per-LLM-call deadline. Without this, a stuck TCP connection to a provider
 * (e.g. api.deepseek.com going silent mid-stream) makes a single generateText
 * call hang forever. `runDebate` uses Promise.all per round so one stuck pair
 * freezes the whole round and the TUI shows "composing…" indefinitely.
 *
 * Range 60_000–1_800_000 ms. Default 300_000 (5 minutes) — generous enough
 * for reasoning models that take 2-3 min on long prompts, tight enough that
 * a truly dead socket fails fast and `debateWithRetry` can fall back.
 */
const COUNCIL_LLM_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.MUONROI_COUNCIL_LLM_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 60_000 && raw <= 1_800_000) return raw;
  return 300_000;
})();

// withTimeoutSignal + withDeadlineRace moved to ../utils/llm-deadline.js so all
// pre-flight LLM call sites (council, debate-planner, scope-ceiling) share one
// implementation. Imported at the top of this file.

/**
 * Run a single-shot LLM call over the STREAMING transport and collect the full
 * result, returning a `generateText`-shaped object ({ text, usage, finishReason,
 * reasoningText }).
 *
 * Why stream a one-shot generate? The OpenAI codex/oauth endpoint
 * (chatgpt.com/backend-api/codex/responses, used by gpt-5.*-codex subscription
 * auth) HARD-REJECTS non-streaming requests with 400 `{"detail":"Stream must be
 * set to true"}`. `generateText` issues a non-stream POST, so every council
 * sub-task that ran through it (leader round evaluation, clarify, spec
 * synthesis, running summary) failed on a codex session — surfacing to the user
 * as the opaque "Decision: evaluation unavailable" round card (diagnosed from
 * session 8191ecaee149: gpt-5.4-mini → codex/responses → "Stream must be set to
 * true"). The panel debate never hit this because it streams. Streaming is the
 * universal transport (every provider + the whole TUI already use it), so
 * collecting a streamed result fixes codex without special-casing it.
 *
 * A provider `error` part is re-thrown so the caller's retry / cross-provider
 * fallback treats it as a failure exactly as a thrown `generateText` did.
 *
 * Also used by `debate()` (the panel pair turns) with the tiny verification
 * toolset: pass `tools`/`stopWhen`/`prepareStep` and the collected `toolCalls`
 * (toolName + input + matched result) come back in the same shape the old
 * `generateText` result exposed. A debater on the codex/oauth endpoint hit the
 * exact same non-stream 400 as the eval path — streaming fixes it uniformly.
 */
/**
 * Spread for the `maxOutputTokens` param, omitted when the resolved runtime
 * rejects it. The ChatGPT Codex OAuth endpoint (chatgpt.com/backend-api/codex/
 * responses) 400s with `{"detail":"Unsupported parameter: max_output_tokens"}`
 * on EVERY council sub-call (clarify / debate / research) — every council
 * generate on a Codex-OAuth session was failing wholesale. Mirrors the
 * orchestrator + classify paths, which already gate this param via
 * `shouldDropParam`.
 */
function maxOutSpread(runtime: ResolvedModelRuntime, n: number): { maxOutputTokens?: number } {
  return shouldDropParam(runtime, "maxOutputTokens") ? {} : { maxOutputTokens: n };
}

/**
 * Push-based stream liveness — module-level because the only readers
 * (`tracedAsync` wrappers in debate.ts) sit OUTSIDE the `CouncilLLM` interface
 * and cannot reach the in-flight `collectStreamText` any other way.
 *
 * Why it exists. `tracedAsync`'s 1s tick only materializes when the CONSUMER
 * pulls `.next()`; a round that awaits its pairs via `Promise.all` stops
 * pumping the tick generator, so `elapsedMs` FREEZES and a slow-but-alive run
 * is indistinguishable from a hung one (observed: tick frozen at 33142ms for
 * 8+ minutes while status was still "tick"). Token deltas are PUSHED here as
 * they arrive, so liveness survives any back-pressure on the generator.
 */
let councilStreamedCharsTotal = 0;
let councilLastDeltaAt = 0;

/** Record `chars` of streamed output (text OR reasoning) against the live window. */
export function noteCouncilStreamDelta(chars: number): void {
  if (chars <= 0) return;
  councilStreamedCharsTotal += chars;
  councilLastDeltaAt = Date.now();
}

/**
 * Open a liveness window and return a reader for it.
 *
 * `streamedChars` counts only what streamed SINCE the window opened, and
 * `lastDeltaAgeMs` is measured from the window's own start until the first
 * delta lands — so a cold stall reads as an age growing from 0, never as a
 * bogus epoch-sized number. Reasoning-delta counts toward both: a reasoning
 * model emits reasoning tokens for minutes before any text, and that is
 * exactly the window an operator must not mistake for a hang.
 */
export function councilStreamLivenessReader(): () => { streamedChars: number; lastDeltaAgeMs: number } {
  const baseChars = councilStreamedCharsTotal;
  const windowStart = Date.now();
  return () => ({
    streamedChars: councilStreamedCharsTotal - baseChars,
    lastDeltaAgeMs: Date.now() - (councilLastDeltaAt > windowStart ? councilLastDeltaAt : windowStart),
  });
}

async function collectStreamText(args: {
  model: LanguageModel;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  tools?: ToolSet;
  stopWhen?: ReturnType<typeof stepCountIs>;
  prepareStep?: (opts: { stepNumber: number; messages: readonly unknown[] }) => unknown;
  /** Called with the char length of every text/reasoning delta as it arrives. */
  onDelta?: (chars: number) => void;
}): Promise<{
  text: string;
  usage?: unknown;
  finishReason?: string;
  reasoningText?: string;
  toolCalls: Array<{ toolName: string; input?: unknown; result?: unknown }>;
}> {
  const hasTools = !!args.tools && Object.keys(args.tools).length > 0;
  const result = streamText({
    model: args.model,
    system: args.system,
    prompt: args.prompt,
    ...(args.maxOutputTokens === undefined ? {} : { maxOutputTokens: args.maxOutputTokens }),
    maxRetries: 0,
    ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
    ...(args.providerOptions ? { providerOptions: args.providerOptions as never } : {}),
    ...(hasTools ? { tools: args.tools, stopWhen: args.stopWhen, prepareStep: args.prepareStep as never } : {}),
    abortSignal: args.abortSignal,
  });
  let text = "";
  let reasoningText = "";
  let usage: unknown;
  let finishReason: string | undefined;
  const toolCalls: Array<{ toolName: string; input?: unknown; result?: unknown }> = [];
  const byId = new Map<string, { toolName: string; input?: unknown; result?: unknown }>();
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta": {
        const d = (part as { text?: string }).text ?? "";
        text += d;
        args.onDelta?.(d.length);
        break;
      }
      case "reasoning-delta": {
        // Reasoning deltas count as liveness: a reasoning model streams these
        // for minutes before its first text-delta, and that silent-on-text
        // window is precisely what gets misread as a hang.
        const d = (part as { text?: string }).text ?? "";
        reasoningText += d;
        args.onDelta?.(d.length);
        break;
      }
      case "tool-call": {
        const p = part as { toolCallId: string; toolName: string; input?: unknown };
        const tc = { toolName: p.toolName, input: p.input };
        byId.set(p.toolCallId, tc);
        toolCalls.push(tc);
        break;
      }
      case "tool-result": {
        const p = part as { toolCallId: string; output?: unknown };
        const tc = byId.get(p.toolCallId);
        if (tc) tc.result = p.output;
        break;
      }
      case "finish":
        usage = (part as { totalUsage?: unknown; usage?: unknown }).totalUsage ?? (part as { usage?: unknown }).usage;
        finishReason = (part as { finishReason?: string }).finishReason;
        break;
      case "error": {
        const raw = (part as { error?: unknown }).error;
        throw raw instanceof Error ? raw : new Error(String(raw));
      }
      default:
        break;
    }
  }
  return { text, usage, finishReason, reasoningText: reasoningText || undefined, toolCalls };
}

/**
 * Test-only handle on the private stream collector, so `onDelta` (the liveness
 * signal that tells a slow reasoning call from a hung one) is directly
 * assertable without standing up a full council run. Not for production use.
 * @internal
 */
export const __testCollectStreamText = collectStreamText;

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
      signal?: AbortSignal,
    ): Promise<string> {
      const mock = getMockLlm();
      if (mock) {
        stats.calls++;
        const result = await mock.complete({ prompt });
        return stripThinkBlocks(result.text);
      }
      const providerId = detectProviderForModel(modelId);
      await ensureCouncilFactory(providerId);
      const runtime = resolveModelRuntime(modelId);
      const t0 = Date.now();
      // Combine the user-abort signal (when threaded from runCouncil) with the
      // per-call wall-clock deadline. Without the parent signal, an Esc/Ctrl-C
      // during the longest generate calls (8192-token synthesis, clarify, leader
      // eval) was a no-op — the call ran to completion or hit the 5-min timeout.
      const { signal: timedSignal, cleanup: cleanupTimeout } = withTimeoutSignal(signal, COUNCIL_LLM_TIMEOUT_MS);
      try {
        const result = await withDeadlineRace(
          () =>
            withVisibleRetry(
              () =>
                // Stream + collect (NOT generateText). The codex/oauth endpoint
                // 400s on non-stream requests ("Stream must be set to true"),
                // which nulled every council eval/clarify/synthesis on a codex
                // session → the opaque "evaluation unavailable" card. See
                // collectStreamText's doc for the full diagnosis.
                collectStreamText({
                  model: runtime.model,
                  system,
                  prompt,
                  ...maxOutSpread(runtime, maxTokens),
                  // Never hardcode temperature: some upstreams (Moonshot/Kimi via
                  // opencode-go) reject any value but their pinned one, which
                  // failed every clarify/spec call on a Kimi session. resolveTemperature
                  // omits the field or clamps to the model's fixed value.
                  temperature: resolveTemperature(providerId, runtime.modelInfo, 0.7),
                  providerOptions: runtime.providerOptions as Record<string, unknown> | undefined,
                  abortSignal: timedSignal,
                  onDelta: noteCouncilStreamDelta,
                }),
              { label: "council.generate" },
            ),
          COUNCIL_LLM_TIMEOUT_MS + 5_000,
          "council.generate",
          signal,
        );
        cleanupTimeout();
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
        recordCouncilUsage(sessionId, modelId, callUsage);
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
        return stripThinkBlocks(result.text);
      } catch (err) {
        cleanupTimeout();
        // Capture the provider-side detail (status code + response body +
        // request param shape) that `err.message` alone drops — a generic
        // "Bad Request" on the council path was previously undiagnosable
        // because collectStreamText re-throws only the message. PII-safe,
        // no-op unless MUONROI_DEBUG_LLM_WIRE=1. (No-Silent-Catch.)
        wireDebug.logError(providerId, err);
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
      const mock = getMockLlm();
      if (mock) {
        stats.calls++;
        const result = await mock.complete({ prompt });
        return { text: stripThinkBlocks(result.text), toolCalls: [] };
      }
      const providerId = detectProviderForModel(modelId);
      await ensureCouncilFactory(providerId);
      const runtime = resolveModelRuntime(modelId);

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
          } catch (err) {
            // MCP is optional here — debate continues with builtins only — but a
            // silent swallow hid which server failed and why. (No-Silent-Catch.)
            console.error(
              `[council/llm] debate MCP tool discovery failed, continuing with builtins only: ${err instanceof Error ? err.message : String(err)}`,
              { modelId, provider: providerId },
            );
          }
          verificationTools = wrapToolsWithEeCheck(filtered, sessionId ?? "council-debate");
        } catch (err) {
          // fail-open: the debate turn still runs, just without verification tools.
          console.error(
            `[council/llm] debate verification toolset build failed, running without tools: ${err instanceof Error ? err.message : String(err)}`,
            { modelId, provider: providerId },
          );
        }
      }

      // sanitizeHistory is identity for every provider (kept as a hook for
      // future provider-specific quirks). Reasoning round-trips natively —
      // see src/providers/__tests__/reasoning-roundtrip.test.ts.
      const debateCaps = getProviderCapabilities(providerId);

      const t0 = Date.now();
      const { signal: timedSignal, cleanup: cleanupTimeout } = withTimeoutSignal(signal, COUNCIL_LLM_TIMEOUT_MS);
      try {
        const result = await withDeadlineRace(
          () =>
            withVisibleRetry(
              () =>
                // Stream + collect (NOT generateText). A debater on the codex/oauth
                // endpoint hits the same non-stream 400 ("Stream must be set to
                // true") that nulled the eval path; streaming is uniform across
                // providers. Tools (when the tier + circuit breaker allow) ride
                // through with stepCountIs(2) + the same sanitizeHistory prepareStep.
                collectStreamText({
                  model: runtime.model,
                  system,
                  prompt,
                  // Reasoning models (deepseek-v4-*, anthropic thinking) consume part
                  // of this budget on reasoning_tokens before producing user-visible
                  // text. E2E showed 2048 caused finishReason=length on 3KB debate
                  // prompts. 6144 leaves ~4000 tokens for text after typical reasoning
                  // overhead and avoids cuts mid-thought.
                  ...maxOutSpread(runtime, 6144),
                  // See generate(): capability-aware temperature (omit / clamp).
                  temperature: resolveTemperature(providerId, runtime.modelInfo, 0.7),
                  providerOptions: runtime.providerOptions as Record<string, unknown> | undefined,
                  abortSignal: timedSignal,
                  // Push liveness for the round wrapper: a debate turn on a
                  // reasoning model runs near the 5-min ceiling, and the tick
                  // generator is not being pumped while Promise.all awaits.
                  onDelta: noteCouncilStreamDelta,
                  ...(verificationTools && Object.keys(verificationTools).length > 0
                    ? {
                        tools: verificationTools,
                        stopWhen: stepCountIs(2),
                        prepareStep: ({ stepNumber, messages }) => {
                          if (stepNumber < 1) return {};
                          const stripped = debateCaps.sanitizeHistory(messages as never) as typeof messages;
                          return stripped === messages ? {} : { messages: stripped };
                        },
                      }
                    : {}),
                }),
              { label: "council.debate" },
            ),
          COUNCIL_LLM_TIMEOUT_MS + 5_000,
          "council.debate",
          signal,
        );
        cleanupTimeout();
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
        recordCouncilUsage(sessionId, modelId, debateUsage);
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
          text: stripThinkBlocks(result.text),
          toolCalls: toolCalls as Array<{ toolName: string; result?: unknown }>,
        };
      } catch (err: unknown) {
        cleanupTimeout();
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
      const mock = getMockLlm();
      if (mock) {
        stats.calls++;
        const result = await mock.complete({ prompt: topic });
        return stripThinkBlocks(result.text);
      }
      const providerId = detectProviderForModel(modelId);
      await ensureCouncilFactory(providerId);
      const runtime = resolveModelRuntime(modelId);

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

      // Warn early if internet-first mode is requested but no *working* web
      // research capability exists. The builtin `web_search`/`fetch_url` tools
      // are ALWAYS registered, so the old tool-NAME check was always true — even
      // when `web_search` will just return `ERROR no_tavily_key`, so the warning
      // never fired and internet-first research failed silently. Gate on real
      // capability: a Tavily key, or an MCP search/browser tool actually loaded
      // (builtins alone don't count — open-ended search needs the key).
      const hasTavilyKey = ((await getMcpKey("tavily")) || process.env.TAVILY_API_KEY || "").trim().length >= 10;
      const mcpSearchTool = Object.keys(mcpBundle?.tools ?? {}).some((n) =>
        /tavily|web[_-]?search|web[_-]?fetch|playwright|chrome|context7|firecrawl|exa|browser/i.test(n),
      );
      const internetToolAvailable = hasTavilyKey || mcpSearchTool;
      const internetGapWarning =
        internetFirst && !internetToolAvailable
          ? `\n\n## Research Gap\n- Internet-first mode requested but no working web-search capability ` +
            `(a Tavily API key or an MCP search/browser tool) is available. ` +
            `\`fetch_url\` still works for explicit URLs, but open-ended search is unavailable — ` +
            `findings will be limited to what the model already knows.`
          : "";

      const userPrompt = conversationContext
        ? `## Context\n${conversationContext}\n\n---\n\n## Research Topic\n${topic}\n\nInvestigate and report findings.`
        : `## Research Topic\n${topic}\n\nInvestigate and report findings.`;

      // sanitizeHistory hook (identity today) preserved for symmetry with
      // debate(). Reasoning round-trips natively across all 15 chained tool
      // steps — see src/providers/__tests__/reasoning-roundtrip.test.ts.
      const researchCaps = getProviderCapabilities(providerId);

      const t0 = Date.now();
      // Research is multi-step tool-using so give it 2x the standard deadline.
      const researchTimeoutMs = Math.min(COUNCIL_LLM_TIMEOUT_MS * 2, 1_800_000);
      const { signal: timedSignal, cleanup: cleanupTimeout } = withTimeoutSignal(signal, researchTimeoutMs);
      try {
        const result = await withDeadlineRace(
          () =>
            withVisibleRetry(
              () =>
                generateText({
                  model: runtime.model,
                  system: systemPrompt,
                  prompt: userPrompt,
                  tools: allTools,
                  stopWhen: stepCountIs(15),
                  prepareStep: ({ stepNumber, messages }) => {
                    if (stepNumber < 1) return {};
                    const stripped = researchCaps.sanitizeHistory(messages) as typeof messages;
                    return stripped === messages ? {} : { messages: stripped };
                  },
                  ...maxOutSpread(runtime, 4096),
                  // See generate(): capability-aware temperature (omit / clamp).
                  ...(() => {
                    const t = resolveTemperature(providerId, runtime.modelInfo, 0.3);
                    return t === undefined ? {} : { temperature: t };
                  })(),
                  // Visible retry (src/utils/visible-retry.ts) replaces SDK's silent
                  // exponential backoff (2,4,8,16,32s). When SiliconFlow rate-limits
                  // with 429, user now sees "[retry] rate-limited (429) — waiting Xs
                  // before attempt N/6" instead of a 62s blank window that looks hung.
                  maxRetries: 0,
                  ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
                  abortSignal: timedSignal,
                }),
              { label: "council.research" },
            ),
          researchTimeoutMs + 5_000,
          "council.research",
          signal,
        );
        cleanupTimeout();
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
        recordCouncilUsage(sessionId, modelId, researchUsage);
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
            (tc) => tc.toolName.includes("playwright") || tc.toolName.includes("chrome") || tc.toolName === "fetch_url",
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
        return stripThinkBlocks(result.text) + internetGapWarning;
      } catch (err: unknown) {
        cleanupTimeout();
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

/**
 * Run {@link tracedGenerate} across a list of models, returning the first
 * non-empty completion. A model that throws (e.g. a flaky proxy returning
 * "Upstream request failed") or yields only whitespace advances to the next
 * candidate; fallback attempts are labelled so the timeline shows the retry.
 * Returns null when every candidate fails — the caller decides the degraded
 * fallback (e.g. a single-criterion spec). Dedupes the model list in order.
 */
export async function* tracedGenerateWithFallback(
  llm: CouncilLLM,
  args: Omit<TracedGenerateArgs, "modelId"> & { models: string[] },
): AsyncGenerator<StreamChunk, string | null, unknown> {
  const seen = new Set<string>();
  const models = args.models.filter((m) => m && !seen.has(m) && (seen.add(m), true));
  for (let i = 0; i < models.length; i++) {
    try {
      const raw = yield* tracedGenerate(llm, {
        ...args,
        modelId: models[i],
        label: i > 0 ? `${args.label} (fallback: ${models[i]})` : args.label,
      });
      if (raw?.trim()) return raw;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

interface TracedAsyncArgs {
  phase: CouncilStatusPhase;
  label: string;
  detail?: string;
  role?: string;
  tickIntervalMs?: number;
  /**
   * Optional push-based stream liveness reader (see {@link councilStreamLivenessReader}).
   * When supplied, every tick/done carries the chars streamed inside this window
   * and the age of the last delta — so a frozen `elapsedMs` (generator not being
   * pumped) can still be told apart from a genuinely stuck call.
   */
  liveness?: () => { streamedChars: number; lastDeltaAgeMs: number };
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

  /** Never let a liveness read break the heartbeat it is meant to enrich. */
  const livenessFields = (): { streamedChars?: number; lastDeltaAgeMs?: number } => {
    if (!args.liveness) return {};
    try {
      const l = args.liveness();
      return { streamedChars: l.streamedChars, lastDeltaAgeMs: l.lastDeltaAgeMs };
    } catch (err) {
      console.error(
        `[council/llm] tracedAsync liveness read failed: ${err instanceof Error ? err.message : String(err)}`,
        { phase: args.phase, label: args.label },
      );
      return {};
    }
  };

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
        ...livenessFields(),
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
      ...livenessFields(),
    },
  };

  return result as T;
}
