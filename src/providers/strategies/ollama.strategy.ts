/**
 * src/providers/strategies/ollama.strategy.ts
 *
 * Phase 12.2-G4 — Ollama (local model) strategy via `ollama-ai-provider-v2`.
 * No API key needed; defaults baseURL to local daemon.
 */

import { createOllama } from "ollama-ai-provider-v2";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

export class OllamaStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "ollama";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("ollama");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    const p = createOllama({ baseURL: opts.baseURL ?? "http://localhost:11434/api" });
    return (modelId: string) => p(modelId);
  }
}
