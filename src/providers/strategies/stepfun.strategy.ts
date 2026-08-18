/**
 * StepFun strategy via its documented OpenAI-compatible Chat Completions API.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "../endpoints.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class StepFunStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "stepfun";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("stepfun");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const provider = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS.stepfun,
      apiKey: opts.apiKey,
    });
    return (modelId: string) => provider(modelId);
  }
}
