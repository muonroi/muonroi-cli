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
import { OpenCodeGoStrategy } from "./opencode-go.strategy.js";
import { SiliconflowStrategy } from "./siliconflow.strategy.js";
import { XAIStrategy } from "./xai.strategy.js";
import { ZaiStrategy } from "./zai.strategy.js";

const STRATEGIES: Record<ProviderId, ProviderStrategy> = {
  anthropic: new AnthropicStrategy(),
  openai: new OpenAIStrategy(),
  google: new GoogleStrategy(),
  deepseek: new DeepSeekStrategy(),
  siliconflow: new SiliconflowStrategy(),
  xai: new XAIStrategy(),
  ollama: new OllamaStrategy(),
  zai: new ZaiStrategy(),
  "opencode-go": new OpenCodeGoStrategy(),
};

/**
 * Returns the strategy singleton for a given provider id. Throws on unknown
 * ids — silent fallback can mask a desynced registry (e.g. a new ProviderId
 * added to `types.ts` without a matching strategy entry here).
 */
export function getProviderStrategy(id: ProviderId | string): ProviderStrategy {
  const strategy = STRATEGIES[id as ProviderId];
  if (!strategy) {
    throw new Error(
      `No provider strategy registered for '${id}'. ` +
        `Add an entry to src/providers/strategies/registry.ts (STRATEGIES record). ` +
        `Known providers: ${Object.keys(STRATEGIES).join(", ")}.`,
    );
  }
  return strategy;
}
