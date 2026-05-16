import { createHash } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOllama } from "ollama-ai-provider-v2";
import { getModelInfo } from "../models/registry.js";
import type { ModelInfo } from "../types/index.js";
import { getReasoningEffortForModel } from "../utils/settings.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "./endpoints.js";
import type { ProviderId } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderFactory = ((modelId: string) => any) & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responses?: (modelId: string) => any;
  /** Provider-level options to merge into providerOptions[<provider>] on every call. */
  defaultProviderOptions?: Record<string, unknown>;
  /** AI SDK top-level call params to strip (backend doesn't accept them). */
  unsupportedParams?: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP">;
};

export interface ProviderFactoryResult {
  id: ProviderId;
  factory: ProviderFactory;
}

export interface ResolvedModelRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  modelId: string;
  modelInfo?: ModelInfo;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: any;
  /** Top-level streamText params to omit (backend doesn't accept them). */
  unsupportedParams?: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP">;
}

export function createProviderFactory(
  id: ProviderId,
  opts: { apiKey?: string; baseURL?: string; headers?: Record<string, string> },
): ProviderFactoryResult {
  switch (id) {
    case "anthropic": {
      const p = createAnthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      const factory: ProviderFactory = (modelId: string) => p(modelId);
      factory.responses = (modelId: string) => (p as any).responses(modelId);
      return { id, factory };
    }
    case "openai": {
      // OAuth subscription tokens cannot call api.openai.com — they must hit
      // ChatGPT's backend (https://chatgpt.com/backend-api/codex) using the
      // Responses API, not Chat Completions.
      const isOAuth = !!opts.headers;
      const p = isOAuth
        ? createOpenAI({
            apiKey: opts.apiKey ?? "oauth",
            baseURL: opts.baseURL ?? "https://chatgpt.com/backend-api/codex",
            headers: opts.headers,
          })
        : createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      const factory: ProviderFactory = isOAuth
        ? // biome-ignore lint/suspicious/noExplicitAny: ai-sdk responses() typed any
          (modelId: string) => (p as any).responses(modelId)
        : (modelId: string) => p(modelId);
      // biome-ignore lint/suspicious/noExplicitAny: ai-sdk responses() typed any
      factory.responses = (modelId: string) => (p as any).responses(modelId);
      return { id, factory };
    }
    case "google": {
      const p = opts.headers
        ? createGoogleGenerativeAI({
            apiKey: opts.apiKey ?? "oauth", // placeholder when using OAuth headers
            baseURL: opts.baseURL,
            headers: opts.headers,
          })
        : createGoogleGenerativeAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      return { id, factory: (modelId: string) => p(modelId) };
    }
    case "deepseek":
    case "siliconflow":
    case "xai": {
      const p = createOpenAICompatible({
        name: id,
        baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS[id],
        apiKey: opts.apiKey,
      });
      return { id, factory: (modelId: string) => p(modelId) };
    }
    case "ollama": {
      const p = createOllama({ baseURL: opts.baseURL ?? "http://localhost:11434/api" });
      return { id, factory: (modelId: string) => p(modelId) };
    }
  }
}

/**
 * Async variant of createProviderFactory.
 * For OpenAI: loads stored OAuth tokens (auto-refreshing if expiring) and injects
 * them as Authorization / ChatGPT-Account-ID headers so subscription-backed
 * ChatGPT Plus/Pro accounts work without an API key.
 * For Google: loads stored Gemini OAuth tokens and injects Authorization header
 * so users can authenticate via their Google account without a GOOGLE_API_KEY.
 * Falls back to API-key path when no tokens are stored.
 * All other providers: identical to createProviderFactory.
 */
export async function createProviderFactoryAsync(
  id: ProviderId,
  opts: { apiKey?: string; baseURL?: string },
): Promise<ProviderFactoryResult> {
  try {
    const { getOAuthProviderConfig } = await import("./auth/registry.js");
    const cfg = await getOAuthProviderConfig(id);
    if (cfg) {
      const tokens = await cfg.loadTokensWithRefresh().catch(() => null);
      if (tokens) {
        const headers = cfg.provider.authHeaders(tokens);
        // OAuth subscription tokens may need a different base URL than the
        // provider's API-key endpoint (e.g. OpenAI's ChatGPT backend).
        const baseURL = opts.baseURL ?? cfg.baseURL;
        const result = createProviderFactory(id, { ...opts, baseURL, headers });
        // Attach provider-level OAuth-only defaults so downstream code can merge them.
        if (cfg.defaultProviderOptions) {
          result.factory.defaultProviderOptions = cfg.defaultProviderOptions;
        }
        if (cfg.unsupportedParams) {
          result.factory.unsupportedParams = cfg.unsupportedParams;
        }
        return result;
      }
    }
  } catch {
    /* registry unavailable or token load failed — fall through to API key */
  }

  return createProviderFactory(id, opts);
}

/**
 * Test-harness hook: when `globalThis.__muonroiMockModel` is set, swap in a
 * mock LanguageModelV3 and skip the real provider factory entirely. The
 * providerOptions and unsupportedParams branches below run as usual so
 * cost-leak specs can verify the merged shape that streamText receives.
 * See src/agent-harness/mock-model.ts for the install helper.
 */
interface MockRuntimeGlobals {
  __muonroiMockModel?: unknown;
  __muonroiMockUnsupportedParams?: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP">;
  __muonroiMockDefaultProviderOptions?: Record<string, unknown>;
}

export function resolveModelRuntime(factory: ProviderFactory, modelId: string): ResolvedModelRuntime {
  // Resolve aliases (e.g. "deepseek-v4-flash") to the provider-native id
  // (e.g. "deepseek-ai/DeepSeek-V4-Flash") BEFORE invoking the factory.
  // Without this, SiliconFlow / DeepSeek / xAI reject the request because
  // the alias is not a valid model id on their API.
  const modelInfo = getModelInfo(modelId);
  const canonicalId = modelInfo?.id ?? modelId;

  const mockGlobals = globalThis as MockRuntimeGlobals;
  const mockModel = mockGlobals.__muonroiMockModel;

  // Determine the language model + unsupportedParams + provider-level defaults.
  // Test path: mockModel is a MockLanguageModelV3 from ai/test. Overrides for
  // unsupportedParams / defaultProviderOptions simulate OAuth registry state.
  // Prod path: factory builds the real provider model (api-key or OAuth).
  // biome-ignore lint/suspicious/noExplicitAny: ai-sdk model shape is provider-specific
  let model: any;
  let unsupportedParams: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP"> | undefined;
  let providerLevelDefaults: Record<string, unknown> | undefined;

  if (mockModel) {
    model = mockModel;
    unsupportedParams = mockGlobals.__muonroiMockUnsupportedParams;
    providerLevelDefaults = mockGlobals.__muonroiMockDefaultProviderOptions;
  } else {
    // G1 fix: OpenAI reasoning models (gpt-5.x, o1, o3, o4) require the
    // Responses API even on the API-key path. The chat-completions endpoint
    // accepts the request but returns an empty assistant message, which AI
    // SDK then surfaces as "AI_NoOutputGeneratedError" → "Task failed: No
    // output generated". The OAuth path already routes through .responses()
    // when the factory is constructed (see createProviderFactory), but the
    // API-key path used plain chat completions.
    const needsResponsesApi =
      modelInfo?.responsesOnly === true || (modelInfo?.provider === "openai" && modelInfo?.reasoning === true);
    model = needsResponsesApi && factory.responses ? factory.responses(canonicalId) : factory(canonicalId);
    unsupportedParams = factory.unsupportedParams;
    providerLevelDefaults = factory.defaultProviderOptions;
  }

  let providerOptions: Record<string, unknown> | undefined;

  // `thinking` is an Anthropic-specific provider option. Setting it on
  // non-Anthropic models was dead-code (AI SDK silently strips wrong-provider
  // keys) but masked the actual issue when debugging.
  if (modelInfo?.provider === "anthropic") {
    if (modelInfo.thinkingType === "adaptive") {
      providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 10_000 } } };
    } else if (modelInfo.thinkingType === "enabled") {
      providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 8_000 } } };
    }
  }

  const userEffort = getReasoningEffortForModel(modelId);

  if (modelInfo?.provider === "xai" && modelInfo.supportsReasoningEffort) {
    providerOptions = {
      ...providerOptions,
      xai: { reasoningEffort: userEffort ?? modelInfo.defaultReasoningEffort ?? "medium" },
    };
  }

  // Forward reasoning effort generically for any provider whose catalog entry
  // declares `supportsReasoningEffort`. AI SDK accepts "low"|"medium"|"high"|"xhigh"
  // for openai (matching Codex CLI's UI labels) and similar for other providers.
  if (modelInfo?.provider === "openai" && modelInfo.supportsReasoningEffort) {
    providerOptions = {
      ...providerOptions,
      openai: {
        ...(providerOptions?.openai as Record<string, unknown> | undefined),
        reasoningEffort: userEffort ?? modelInfo.defaultReasoningEffort ?? "medium",
      },
    };
  }

  // Merge provider-level defaults from the factory (e.g. OAuth backends inject
  // `instructions` + `store: false` for the ChatGPT Codex API). This keeps
  // backend-specific quirks centralized in src/providers/auth/registry.ts.
  // In the mock path `providerLevelDefaults` is the test-supplied override.
  if (providerLevelDefaults && modelInfo?.provider) {
    const key = modelInfo.provider;
    providerOptions = {
      ...providerOptions,
      [key]: {
        ...providerLevelDefaults,
        ...((providerOptions?.[key] as Record<string, unknown> | undefined) ?? {}),
      },
    };
  }

  return { model, modelId, modelInfo, providerOptions, unsupportedParams };
}

/**
 * F1: derive a stable OpenAI prompt-cache key from the session id.
 *
 * The AI SDK's agentic streamText loop sends one OpenAI call per tool round.
 * Without a stable `promptCacheKey`, OpenAI auto-hashes prompt content — so
 * the moment any later message changes (which always happens between rounds),
 * the cache is busted. Hashing session.id gives every round in the same
 * session the same key, so the unchanging system + early-message prefix
 * keeps hitting the cache. Cache TTL is short (minutes) but covers a turn.
 *
 * Returns undefined when there is no session id (e.g. headless one-shot
 * requests with no persistence) — callers must skip setting the field.
 */
export function computePromptCacheKey(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/**
 * Returns true when a top-level streamText param should be omitted because
 * either (a) the model catalog explicitly marks it unsupported, or (b) the
 * OAuth provider registry attached `unsupportedParams` to the factory
 * (e.g. ChatGPT Codex rejects `max_output_tokens` with HTTP 400 — see G1).
 *
 * Centralizes the dropParam test so the orchestrator's sub-agent path,
 * top-level path, and cost-leak specs cannot drift apart.
 */
export function shouldDropParam(
  runtime: ResolvedModelRuntime,
  param: "maxOutputTokens" | "temperature" | "topP",
): boolean {
  if (param === "maxOutputTokens" && runtime.modelInfo?.supportsMaxOutputTokens === false) {
    return true;
  }
  // Reasoning models (gpt-5.x, o1/o3/o4, deepseek-r1, claude reasoning, etc.)
  // reject `temperature` and `topP` at the provider — OpenAI Responses API
  // emits an AI SDK warning and the param is silently ignored. Drop them at
  // the source so the warning stops and no future strict-mode provider
  // surfaces a hard error. G2 — sibling of G1 (maxOutputTokens drop).
  if ((param === "temperature" || param === "topP") && runtime.modelInfo?.reasoning === true) {
    return true;
  }
  return runtime.unsupportedParams?.includes(param) ?? false;
}

export function detectProviderForModel(modelId: string): ProviderId {
  const info = getModelInfo(modelId);
  if (info?.provider) {
    return info.provider as ProviderId;
  }
  // Prefix-based fallback for models not in the static catalog
  const id = modelId.toLowerCase();
  if (id.startsWith("deepseek")) return "deepseek";
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return "openai";
  if (id.startsWith("gemini") || id.startsWith("models/gemini")) return "google";
  if (id.startsWith("grok")) return "xai";
  if (id.includes("qwen") || id.includes("glm") || id.includes("internlm")) return "siliconflow";
  if (id.startsWith("llama") || id.startsWith("mistral") || id.startsWith("phi-")) return "ollama";
  return "anthropic";
}
