/**
 * src/providers/strategies/google.strategy.ts
 *
 * Phase 12.2-G4 — Google Gemini strategy. Supports both API-key and OAuth
 * (Google account headers) paths.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class GoogleStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "google";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("google");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = opts.headers
      ? createGoogleGenerativeAI({
          apiKey: opts.apiKey ?? "oauth", // placeholder when using OAuth headers
          baseURL: opts.baseURL,
          headers: opts.headers,
        })
      : createGoogleGenerativeAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    return (modelId: string) => p(modelId);
  }
}
