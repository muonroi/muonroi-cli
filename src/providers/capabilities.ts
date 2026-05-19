/**
 * src/providers/capabilities.ts
 *
 * Per-provider capability flags. Each provider quirks differently:
 *   - DeepSeek / SiliconFlow models leak `<｜DSML｜>` control tokens into
 *     JSON tool inputs, breaking Zod validation for plain-text schemas.
 *   - OpenAI / Anthropic / Google handle structured tool calls reliably.
 *   - Local Ollama models vary wildly per checkpoint — treat conservatively.
 *
 * The PIL Layer 6 output module queries these flags before offering a
 * `respond_<task>` response tool to the LLM. When a flag returns false the
 * tool is dropped and the orchestrator falls back to the OUTPUT RULES
 * suffix instead — same UX, zero parser failures.
 *
 * To add a new quirk:
 *   1. Add a method to ProviderCapabilities.
 *   2. Default it on the base class to the "reliable" answer.
 *   3. Override on the specific provider's subclass.
 *   4. Wire any call sites that need the new flag.
 *
 * To add a new provider:
 *   1. Create a new subclass extending one of the bases below (or
 *      ProviderCapabilitiesBase directly).
 *   2. Register a singleton instance in CAPABILITIES.
 *   3. Add the ProviderId to src/providers/types.ts if not already present.
 */

import type { ProviderId } from "./types.js";

/**
 * The contract every provider exposes for capability queries.
 * Add methods here as new quirks are discovered — keep the base class
 * defaults aligned with the most reliable provider so new providers
 * "just work" until proven otherwise.
 */
export interface ProviderCapabilities {
  /**
   * True when the provider can reliably emit Zod-validated tool-call input
   * for a `respond_<taskType>` tool. False forces PIL Layer 6 to drop the
   * tool and rely on plain-text output rules instead.
   */
  supportsResponseTool(taskType: string): boolean;
}

/**
 * Default capability set — the "reliable provider" answers. Subclasses
 * override individual methods when the provider has a known quirk.
 */
class ReliableProviderCapabilities implements ProviderCapabilities {
  supportsResponseTool(_taskType: string): boolean {
    return true;
  }
}

/**
 * DeepSeek / SiliconFlow quirk: special tokens like `<｜DSML｜>` leak into
 * tool-call JSON bodies, failing Zod validation. Plain-text schemas
 * (`respond_general`) are hit hardest because the model can't recover
 * from a malformed string field. Structured schemas (`respond_plan`,
 * `respond_debug`) survive because the JSON contains nested keys that
 * keep the model on rails.
 *
 * Empirical evidence: session 528ffe653f16 — 8 retries of
 * `respond_general` all returned `{"response": "</｜DSML｜inv..."}` style
 * malformed bodies before the model fell back to free-form text.
 */
class DeepSeekProviderCapabilities extends ReliableProviderCapabilities {
  override supportsResponseTool(taskType: string): boolean {
    if (taskType === "general") return false;
    return true;
  }
}

/**
 * Local Ollama models are heterogeneous; some emit clean tool JSON, some
 * don't. Treat conservatively until per-checkpoint capability detection
 * is added (Phase 24 candidate).
 */
class OllamaProviderCapabilities extends ReliableProviderCapabilities {
  override supportsResponseTool(taskType: string): boolean {
    if (taskType === "general") return false;
    return true;
  }
}

const CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  anthropic: new ReliableProviderCapabilities(),
  openai: new ReliableProviderCapabilities(),
  google: new ReliableProviderCapabilities(),
  xai: new ReliableProviderCapabilities(),
  deepseek: new DeepSeekProviderCapabilities(),
  siliconflow: new DeepSeekProviderCapabilities(),
  ollama: new OllamaProviderCapabilities(),
};

/**
 * Singleton resolver — returns the capability instance for a given
 * provider id. Falls back to the reliable defaults when the id is
 * unknown so new providers don't accidentally inherit a quirk override.
 */
export function getProviderCapabilities(providerId: ProviderId | string): ProviderCapabilities {
  return CAPABILITIES[providerId as ProviderId] ?? new ReliableProviderCapabilities();
}
