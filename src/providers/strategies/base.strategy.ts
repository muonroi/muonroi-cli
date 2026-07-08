/**
 * src/providers/strategies/base.strategy.ts
 *
 * Phase 12.2-G4: Per-provider strategy aggregating SDK client factory,
 * model resolution, and capability metadata. Each provider's quirks
 * (Responses API gating, OAuth header injection, providerOptions assembly,
 * history sanitization) live in exactly one strategy subclass — runtime.ts
 * becomes a thin dispatcher over the strategy registry.
 *
 * To add a new provider:
 *   1. Subclass `BaseProviderStrategy` in a new file under this folder.
 *   2. Implement `createFactory` (and override `resolve` only if truly different).
 *   3. Register the singleton in `strategies/registry.ts`.
 *   4. Add the ProviderId to `src/providers/types.ts` if not already present.
 */

import type { ModelInfo } from "../../types/index.js";
import type { ProviderCapabilities } from "../capabilities.js";
import type { ProviderFactory, ResolvedModelRuntime } from "../runtime.js";
import type { ProviderId } from "../types.js";

/**
 * Catalog ids for models reached through the OpenCode Go (Console Go) gateway
 * carry an `opencode/` routing prefix (e.g. `opencode/deepseek-v4-flash`). That
 * prefix is a *routing* marker, not part of the wire model name any upstream
 * accepts — the gateway itself strips it before forwarding (see
 * OpenCodeGoStrategy.createFactory). When a task sub-model resolved from that
 * catalog id is run through a DIFFERENT provider's factory (e.g. the compaction
 * proposer reusing the parent's native DeepSeek factory), the raw prefixed id
 * would otherwise be POSTed to api.deepseek.com and rejected with HTTP 400
 * "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but
 * you passed opencode/deepseek-v4-flash". Stripping here — the single chokepoint
 * every provider's resolve() flows through — makes the wire name always native.
 * The returned `modelId` keeps the catalog id so usage/pricing attribution is
 * unchanged; only the id handed to factory() is normalized.
 */
export function toWireModelId(modelId: string): string {
  return modelId.startsWith("opencode/") ? modelId.slice("opencode/".length) : modelId;
}

export interface CreateFactoryOpts {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export interface ResolveModelOpts {
  factory: ProviderFactory;
  modelId: string;
  modelInfo: ModelInfo | undefined;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

/**
 * Per-provider strategy aggregating: SDK client factory, model resolution,
 * and capability metadata.
 */
export interface ProviderStrategy {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  /** Build AI SDK provider client. */
  createFactory(opts: CreateFactoryOpts): ProviderFactory;

  /** Resolve a model to a runtime instance (model handle + options). */
  resolve(opts: ResolveModelOpts): ResolvedModelRuntime;
}

/**
 * Shared base — most providers want the same `resolve` body. Subclasses
 * override only when truly different.
 */
export abstract class BaseProviderStrategy implements ProviderStrategy {
  abstract readonly id: ProviderId;
  abstract readonly capabilities: ProviderCapabilities;

  abstract createFactory(opts: CreateFactoryOpts): ProviderFactory;

  resolve(opts: ResolveModelOpts): ResolvedModelRuntime {
    const { factory, modelId, modelInfo, reasoningEffort } = opts;
    const useResponsesApi = this.capabilities.usesResponsesAPI(modelInfo);
    // Normalize the wire model name (strip the `opencode/` routing prefix) so a
    // native provider factory never receives a gateway-routed id. See
    // toWireModelId above. `modelId` (catalog id) is still returned below for
    // attribution — only the id passed to factory() is normalized.
    const wireModelId = toWireModelId(modelId);
    const model = useResponsesApi && factory.responses ? factory.responses(wireModelId) : factory(wireModelId);
    const providerOptions = this.capabilities.buildProviderOptions({
      model: modelInfo,
      reasoningEffort,
    });
    return {
      model,
      modelId,
      modelInfo,
      providerOptions,
      unsupportedParams: factory.unsupportedParams,
    };
  }
}
