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
    const model = useResponsesApi && factory.responses ? factory.responses(modelId) : factory(modelId);
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
