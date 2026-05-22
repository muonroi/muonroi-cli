import { createHash } from "node:crypto";
import { getModelInfo } from "../models/registry.js";
import type { ModelInfo } from "../types/index.js";
import { getReasoningEffortForModel } from "../utils/settings.js";
import { getProviderCapabilities } from "./capabilities.js";
import { getProviderStrategy } from "./strategies/registry.js";
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

/**
 * Phase 12.2-G4: thin dispatcher delegating to the provider strategy registry.
 * Each provider's SDK wiring + `factory.responses` + `defaultProviderOptions`
 * baseline lives in `src/providers/strategies/<provider>.strategy.ts`.
 */
export function createProviderFactory(
  id: ProviderId,
  opts: { apiKey?: string; baseURL?: string; headers?: Record<string, string> },
): ProviderFactoryResult {
  const strategy = getProviderStrategy(id);
  return { id, factory: strategy.createFactory(opts) };
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
  const mockGlobals = globalThis as MockRuntimeGlobals;
  const modelInfo = getModelInfo(modelId);
  const canonicalId = modelInfo?.id ?? modelId;
  const providerId = modelInfo?.provider as ProviderId | undefined;
  if (!providerId && !mockGlobals.__muonroiMockModel) {
    throw new Error(`Model "${modelId}" not found in catalog — cannot determine provider.`);
  }
  const userEffort = getReasoningEffortForModel(modelId);
  const mockModel = mockGlobals.__muonroiMockModel;

  // Determine the language model + unsupportedParams + provider-level defaults.
  // Test path: mockModel is a MockLanguageModelV3 from ai/test. Overrides for
  // unsupportedParams / defaultProviderOptions simulate OAuth registry state.
  // Prod path: delegate to the per-provider strategy which knows how to
  // route via factory.responses vs factory(modelId).
  let resolved: ResolvedModelRuntime;
  let providerLevelDefaults: Record<string, unknown> | undefined;

  if (mockModel) {
    const mockProviderId = providerId ?? detectProviderForModel(modelId);
    const caps = getProviderCapabilities(mockProviderId);
    const providerOptions = caps.buildProviderOptions({
      model: modelInfo,
      reasoningEffort: userEffort,
    });
    resolved = {
      model: mockModel,
      modelId: canonicalId,
      modelInfo,
      providerOptions,
      unsupportedParams: mockGlobals.__muonroiMockUnsupportedParams,
    };
    providerLevelDefaults = mockGlobals.__muonroiMockDefaultProviderOptions;
  } else {
    const strategy = getProviderStrategy(providerId!);
    resolved = strategy.resolve({
      factory,
      modelId: canonicalId,
      modelInfo,
      reasoningEffort: userEffort,
    });
    providerLevelDefaults = factory.defaultProviderOptions;
  }

  // Merge provider-level defaults from the factory (e.g. OAuth backends inject
  // `instructions` + `store: false` for the ChatGPT Codex API). This keeps
  // backend-specific quirks centralized in src/providers/auth/registry.ts.
  // In the mock path `providerLevelDefaults` is the test-supplied override.
  // OpenAIStrategy.createFactory also seeds `{ store: true }` here on the
  // API-key path (orchestrator policy migrated in G4).
  if (providerLevelDefaults && modelInfo?.provider) {
    const key = modelInfo.provider;
    const existingForProvider = (resolved.providerOptions?.[key] as Record<string, unknown> | undefined) ?? {};
    resolved.providerOptions = {
      ...resolved.providerOptions,
      [key]: {
        ...providerLevelDefaults,
        ...existingForProvider,
      },
    };
  }

  return resolved;
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
 * G3: Build providerOptions with full per-turn context (e.g. sessionId for
 * openai.promptCacheKey). Called by orchestrator per-turn instead of at
 * resolve time, because sessionId isn't known when the model is first
 * resolved. Merges:
 *   1. Capability output (anthropic.thinking, openai/xai reasoningEffort,
 *      openai.promptCacheKey) — driven by `caps.buildProviderOptions`.
 *   2. Factory-level provider defaults (e.g. OAuth `store: false` for
 *      ChatGPT Codex backend) — same merge precedence as resolveModelRuntime.
 *
 * The merge order mirrors resolveModelRuntime: provider-level defaults are
 * applied UNDER capability output (`...defaults, ...capabilityKeys`) so
 * capability values win on conflict.
 *
 * Returns undefined when neither source produced options.
 */
export function buildTurnProviderOptions(
  runtime: ResolvedModelRuntime,
  ctx: { sessionId?: string },
): Record<string, unknown> | undefined {
  const provider = runtime.modelInfo?.provider as ProviderId | undefined;
  if (!provider)
    throw new Error(`Cannot build provider options — model "${runtime.modelId}" has no provider in catalog.`);
  const caps = getProviderCapabilities(provider);
  const userEffort = getReasoningEffortForModel(runtime.modelId);
  const fromCaps = caps.buildProviderOptions({
    model: runtime.modelInfo,
    sessionId: ctx.sessionId,
    reasoningEffort: userEffort,
  });

  // No factory-level defaults captured on ResolvedModelRuntime — at resolve
  // time those were already merged into `runtime.providerOptions`. To preserve
  // them per-turn we re-merge over the capability output using the resolved
  // values as the baseline for the same provider key.
  let merged: Record<string, unknown> | undefined = fromCaps;
  if (provider && runtime.providerOptions) {
    const resolved = runtime.providerOptions as Record<string, unknown>;
    const resolvedForProvider = resolved[provider] as Record<string, unknown> | undefined;
    const capsForProvider = (fromCaps?.[provider] as Record<string, unknown> | undefined) ?? undefined;
    if (resolvedForProvider || capsForProvider) {
      merged = {
        ...resolved,
        ...fromCaps,
        [provider]: {
          ...(resolvedForProvider ?? {}),
          ...(capsForProvider ?? {}),
        },
      };
    } else {
      merged = { ...resolved, ...fromCaps };
    }
  }

  return merged;
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
  // Delegate the model-side rule to the provider capability layer:
  //   - acceptsParam("maxOutputTokens") mirrors supportsMaxOutputTokens.
  //   - acceptsParam("temperature"/"topP") returns false for reasoning models
  //     (OpenAI Responses API emits a warning and silently ignores them; we
  //     drop at the source so no future strict-mode provider hard-errors).
  // See ProviderCapabilities in src/providers/capabilities.ts.
  const provider = runtime.modelInfo?.provider;
  if (!provider)
    throw new Error(`Cannot check param "${param}" — model "${runtime.modelId}" has no provider in catalog.`);
  const caps = getProviderCapabilities(provider as ProviderId);
  if (!caps.acceptsParam(param, runtime.modelInfo)) {
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
  if (id.startsWith("claude")) return "anthropic";
  throw new Error(
    `Cannot detect provider for model "${modelId}" — not in catalog and no prefix match. Add it to catalog.json.`,
  );
}

export function requireRuntimeProvider(runtime: ResolvedModelRuntime): ProviderId {
  const p = runtime.modelInfo?.provider;
  if (!p) throw new Error(`Model "${runtime.modelId}" has no provider in catalog.`);
  return p as ProviderId;
}
