import { createHash } from "node:crypto";
import { getModelInfo } from "../models/registry.js";
import type { ModelInfo } from "../types/index.js";
import { logger } from "../utils/logger.js";
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
  /**
   * The provider this factory talks to. Stamped by createProviderFactory so a
   * caller that blindly reuses one provider's factory with a model from a
   * DIFFERENT provider can be detected and auto-corrected in resolveModelRuntime
   * (see the factory registry below) — otherwise the request would hit the wrong
   * endpoint (e.g. a gateway-routed model POSTed straight to a native API,
   * bypassing the configured gateway).
   */
  providerId?: ProviderId;
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
 * Session-scoped registry of the most-recently-built factory per provider.
 * resolveModelRuntime consults this to auto-correct a factory/model provider
 * mismatch: when a caller reuses provider A's factory to run a model that
 * belongs to provider B (a real hazard in sub-task paths like compaction that
 * inherit the parent session's factory), we substitute B's real factory if one
 * was built this session. Single-orchestrator invariant (v1, see CQ-16a) makes
 * a module-level map safe. Last-built wins, so a /model key change that rebuilds
 * a provider's factory transparently refreshes the entry.
 */
const providerFactoryRegistry = new Map<ProviderId, ProviderFactory>();

/** Test seam: clear the registry between cases so entries never leak across specs. */
export function __resetProviderFactoryRegistry(): void {
  providerFactoryRegistry.clear();
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
  const factory = strategy.createFactory(opts);
  factory.providerId = id;
  providerFactoryRegistry.set(id, factory);
  return { id, factory };
}

/**
 * Async variant of createProviderFactory.
 * For OpenAI: loads stored OAuth tokens (auto-refreshing if expiring) and injects
 * them as Authorization / ChatGPT-Account-ID headers so subscription-backed
 * ChatGPT Plus/Pro accounts work without an API key.
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
        // OAuth subscription tokens are only valid against the provider's OAuth
        // backend (e.g. OpenAI's ChatGPT Codex backend), NOT its API-key
        // endpoint. cfg.baseURL is therefore authoritative and MUST take
        // precedence: callers (index.ts) always pass opts.baseURL = getBaseURL()
        // (the api-key endpoint, e.g. api.openai.com), which would otherwise
        // override the OAuth backend and produce a 401 "Missing scopes:
        // api.responses.write" when the subscription token hits the platform
        // API. Fall back to opts.baseURL only when the OAuth provider declares
        // no dedicated backend (cfg.baseURL undefined).
        //
        // However, a user-specified baseURL in settings (e.g. switching to a
        // different backend after an OAuth provider is killed) MUST override
        // the hardcoded OAuth default. This lets users migrate to a new
        // proxy/backend without modifying source.
        const { loadUserSettings } = await import("../utils/settings.js");
        const userSettings = loadUserSettings();
        const userBaseURL = userSettings?.providers?.[id]?.baseURL;
        const baseURL = userBaseURL ?? cfg.baseURL ?? opts.baseURL;
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
  __muonroiMockModelInfo?: ModelInfo;
}

export function resolveModelRuntime(factory: ProviderFactory, modelId: string): ResolvedModelRuntime {
  // Resolve aliases (e.g. "deepseek-v4-flash") to the provider-native id
  // (e.g. "deepseek-v4-flash") BEFORE invoking the factory.
  // Without this, DeepSeek / xAI reject the request because
  // the alias is not a valid model id on their API.
  const mockGlobals = globalThis as MockRuntimeGlobals;
  const modelInfo = getModelInfo(modelId);
  const canonicalId = modelInfo?.id ?? modelId;
  const providerId = modelInfo?.provider as ProviderId | undefined;
  if (!providerId && !mockGlobals.__muonroiMockModel) {
    throw new Error(`Model "${modelId}" not found in catalog — cannot determine provider.`);
  }

  // Factory/model provider guard (Layer 2). A caller that reuses one provider's
  // factory to run a model from another provider (e.g. compaction inheriting the
  // parent session's native factory for a gateway-routed model) would otherwise
  // POST to the wrong endpoint. If the passed factory is stamped for a different
  // provider AND we built the correct one this session, substitute it so the
  // request lands on the right backend; otherwise keep going (Part 3's wire-id
  // normalization keeps it valid) but log the mismatch so it is never silent.
  let effectiveFactory = factory;
  if (providerId && factory.providerId && factory.providerId !== providerId) {
    const correct = providerFactoryRegistry.get(providerId);
    if (correct) {
      effectiveFactory = correct;
      logger.debug("orchestrator", "Redirected model to its own provider factory", {
        modelId: canonicalId,
        modelProvider: providerId,
        factoryProvider: factory.providerId,
      });
    } else {
      logger.warn("orchestrator", "Factory/model provider mismatch; no factory for model's provider", {
        modelId: canonicalId,
        modelProvider: providerId,
        factoryProvider: factory.providerId,
      });
    }
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
    const mockModelInfo =
      modelInfo ?? mockGlobals.__muonroiMockModelInfo ?? ({ id: canonicalId, provider: mockProviderId } as ModelInfo);
    const caps = getProviderCapabilities(mockProviderId);
    const providerOptions = caps.buildProviderOptions({
      model: mockModelInfo,
      reasoningEffort: userEffort,
    });
    resolved = {
      model: mockModel,
      modelId: canonicalId,
      modelInfo: mockModelInfo,
      providerOptions,
      unsupportedParams: mockGlobals.__muonroiMockUnsupportedParams,
    };
    providerLevelDefaults = mockGlobals.__muonroiMockDefaultProviderOptions;
  } else {
    const strategy = getProviderStrategy(providerId!);
    resolved = strategy.resolve({
      factory: effectiveFactory,
      modelId: canonicalId,
      modelInfo,
      reasoningEffort: userEffort,
    });
    providerLevelDefaults = effectiveFactory.defaultProviderOptions;
  }

  // Merge provider-level defaults from the factory (e.g. OAuth backends inject
  // `instructions` + `store: false` for the ChatGPT Codex API). This keeps
  // backend-specific quirks centralized in src/providers/auth/registry.ts.
  // In the mock path `providerLevelDefaults` is the test-supplied override.
  // OpenAIStrategy.createFactory also seeds `{ store: true }` here on the
  // API-key path (orchestrator policy migrated in G4).
  if (providerLevelDefaults && resolved.modelInfo?.provider) {
    const key = resolved.modelInfo.provider;
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
  if (!provider) {
    return runtime.unsupportedParams?.includes(param) ?? false;
  }
  const caps = getProviderCapabilities(provider as ProviderId);
  if (!caps.acceptsParam(param, runtime.modelInfo)) {
    return true;
  }
  return runtime.unsupportedParams?.includes(param) ?? false;
}

/**
 * Resolve the `temperature` spread for a streamText/generateText call.
 *
 * Returns `{}` (omit the param) when the model does not accept temperature
 * (reasoning models, OAuth `unsupportedParams`), `{ temperature: <fixed> }`
 * when the catalog pins a `fixed_temperature` (e.g. Moonshot/Kimi via
 * opencode-go reject any value but `1` with "invalid temperature: only 1 is
 * allowed for this model"), otherwise `{ temperature: <desired> }`.
 *
 * Every orchestrator call site that sets a temperature MUST go through this
 * helper — inlining `temperature: 0.7` is what made every Kimi tool-loop turn
 * fail wholesale (mirrors `resolveTemperature` used in src/council/llm.ts).
 */
export function resolveTemperatureParam(runtime: ResolvedModelRuntime, desired: number): { temperature?: number } {
  if (shouldDropParam(runtime, "temperature")) return {};
  const fixed = runtime.modelInfo?.fixedTemperature;
  if (typeof fixed === "number") return { temperature: fixed };
  return { temperature: desired };
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
  if (id.startsWith("grok")) return "xai";
  if (id.includes("glm") || id.startsWith("z-ai") || id.startsWith("zai")) return "zai";
  if (id.startsWith("opencode")) return "opencode-go";
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
