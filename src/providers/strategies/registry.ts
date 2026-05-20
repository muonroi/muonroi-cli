/**
 * src/providers/strategies/registry.ts
 *
 * Phase 12.2-G4 — Singleton registry of per-provider strategies. Replaces the
 * switch-case dispatch that used to live in `runtime.ts:createProviderFactory`.
 */

import type { ProviderId } from "../types.js";
import { AnthropicStrategy } from "./anthropic.strategy.js";
import type { ProviderStrategy } from "./base.strategy.js";
import { DeepSeekStrategy } from "./deepseek.strategy.js";
import { GoogleStrategy } from "./google.strategy.js";
import { OllamaStrategy } from "./ollama.strategy.js";
import { OpenAIStrategy } from "./openai.strategy.js";
import { SiliconflowStrategy } from "./siliconflow.strategy.js";
import { XAIStrategy } from "./xai.strategy.js";

const STRATEGIES: Record<ProviderId, ProviderStrategy> = {
  anthropic: new AnthropicStrategy(),
  openai: new OpenAIStrategy(),
  google: new GoogleStrategy(),
  deepseek: new DeepSeekStrategy(),
  siliconflow: new SiliconflowStrategy(),
  xai: new XAIStrategy(),
  ollama: new OllamaStrategy(),
};

/**
 * Returns the strategy singleton for a given provider id. Falls back to the
 * Anthropic strategy when the id is unknown — keeps the dispatcher
 * exhaustive without a thrown error path.
 */
export function getProviderStrategy(id: ProviderId | string): ProviderStrategy {
  return STRATEGIES[id as ProviderId] ?? STRATEGIES.anthropic;
}
