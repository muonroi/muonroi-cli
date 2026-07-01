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

import { createHash } from "node:crypto";
import type { ModelInfo } from "../types/index.js";
import { consoleUrlFor } from "./endpoints.js";
import type { ProviderId } from "./types.js";

/**
 * Context passed to `buildProviderOptions`. Each provider picks the fields it
 * needs (anthropic.thinking budget is model-only; openai.promptCacheKey wants
 * `sessionId`; reasoningEffort is the user-resolved value or undefined).
 */
export interface BuildProviderOptionsCtx {
  model: ModelInfo | undefined;
  /**
   * Session id used to derive a stable OpenAI promptCacheKey. Omitted at
   * `resolveModelRuntime` time (no session known yet) and supplied later by
   * `buildTurnProviderOptions` in runtime.ts.
   */
  sessionId?: string;
  /** Resolved reasoning effort from user settings (overrides model default). */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

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
  /**
   * True when the model accepts client-supplied tool schemas in the request.
   * False forces the orchestrator to drop tools (empty ToolSet) and rely on
   * plain-text output for that model. Mirrors the catalog flag
   * `ModelInfo.supportsClientTools` (default true unless explicitly false).
   */
  supportsClientTools(model: ModelInfo | undefined): boolean;
  /**
   * True when the model can only be invoked via the provider's "responses"
   * endpoint (vs chat-completions). Mirrors `ModelInfo.responsesOnly`.
   * OpenAI reasoning routing is fully handled by `OpenAIProviderCapabilities`
   * — `runtime.ts` is a thin dispatcher that delegates here.
   */
  usesResponsesAPI(model: ModelInfo | undefined): boolean;
  /**
   * True when the provider accepts the given top-level streamText param for
   * this model. False signals the orchestrator (and `shouldDropParam`) to
   * omit the field from the request body.
   *   - "maxOutputTokens" mirrors `ModelInfo.supportsMaxOutputTokens`.
   *   - "temperature" / "topP" return false for reasoning models, which
   *     silently ignore them on the provider side.
   */
  acceptsParam(param: "maxOutputTokens" | "temperature" | "topP", model: ModelInfo | undefined): boolean;
  /**
   * Transform conversation history before sending to the provider. Default is
   * identity (returns input by reference). Providers override when they
   * reject specific message parts — e.g. SiliconFlow's DeepSeek thinking-mode
   * endpoint returns HTTP 400 code 20015 when assistant `reasoning` parts are
   * present, because @ai-sdk/openai-compatible does not serialize them as the
   * `reasoning_content` field SiliconFlow expects.
   */
  sanitizeHistory<T>(messages: readonly T[]): readonly T[];
  /**
   * Build provider-specific options object (AI SDK `providerOptions` shape).
   * Returns undefined when no options needed. Each provider handles its own
   * keys (anthropic.thinking, openai.promptCacheKey/reasoningEffort,
   * xai.reasoningEffort, etc.). Centralizes the branch logic that used to
   * live inline in resolveModelRuntime + orchestrator.processMessage.
   *
   * Phase 12.2-G3 — invoked twice:
   *   1. At resolve time without sessionId → produces stable bits (thinking,
   *      reasoningEffort) attached to ResolvedModelRuntime.providerOptions.
   *   2. Per turn via `buildTurnProviderOptions` with sessionId → adds
   *      openai.promptCacheKey on top of the resolve-time bits.
   */
  buildProviderOptions(ctx: BuildProviderOptionsCtx): Record<string, unknown> | undefined;
  /**
   * URL to the provider's signup / console page where the user can issue an
   * API key. Shown by the wizard and by the no-key error messages in
   * src/index.ts. Phase 12.2-G5: replaces inlined `consoleUrlFor("anthropic")`
   * literals.
   */
  consoleSignupURL(): string;
  /**
   * Describes how this provider reports prompt-cache reads in the AI SDK
   * `usage` object. `readField` is the property name (`cachedInputTokens` for
   * most providers, `promptCacheHitTokens` for DeepSeek-shaped APIs).
   * `creationSupported` is true only when the provider also emits cache
   * creation tokens (currently anthropic only — see C1 in cost-forensics).
   */
  cacheMetricLayout(): { readField: string; creationSupported: boolean };
  /**
   * Style of the system-prompt the orchestrator builds for this provider.
   * `"anthropic"` keeps the native tools section; `"openai"` and `"generic"`
   * strip the tools section and append the NON_ANTHROPIC_TOOL_PREAMBLE so
   * non-Anthropic tokenizers handle tool routing the same way.
   */
  systemPromptStyle(): "anthropic" | "openai" | "generic";
}

/**
 * Default capability set — the "reliable provider" answers. Subclasses
 * override individual methods when the provider has a known quirk.
 */
class ReliableProviderCapabilities implements ProviderCapabilities {
  supportsResponseTool(_taskType: string): boolean {
    return true;
  }
  supportsClientTools(model: ModelInfo | undefined): boolean {
    return model?.supportsClientTools !== false;
  }
  usesResponsesAPI(model: ModelInfo | undefined): boolean {
    return model?.responsesOnly === true;
  }
  acceptsParam(param: "maxOutputTokens" | "temperature" | "topP", model: ModelInfo | undefined): boolean {
    if (param === "maxOutputTokens") {
      return model?.supportsMaxOutputTokens !== false;
    }
    if (param === "temperature" || param === "topP") {
      return model?.reasoning !== true;
    }
    return true;
  }
  sanitizeHistory<T>(messages: readonly T[]): readonly T[] {
    return messages;
  }
  buildProviderOptions(_ctx: BuildProviderOptionsCtx): Record<string, unknown> | undefined {
    return undefined;
  }
  consoleSignupURL(): string {
    return "https://console.anthropic.com/settings/keys";
  }
  cacheMetricLayout(): { readField: string; creationSupported: boolean } {
    return { readField: "cachedInputTokens", creationSupported: false };
  }
  systemPromptStyle(): "anthropic" | "openai" | "generic" {
    return "generic";
  }
}

/**
 * F1: derive a stable OpenAI prompt-cache key from the session id.
 * Identical hash logic as runtime.ts:computePromptCacheKey — kept here to
 * avoid a runtime->capabilities import cycle. Both functions MUST stay in
 * sync (the F1 cost-leak spec is the canary).
 */
function computePromptCacheKey(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/**
 * Anthropic thinking is a provider-specific option. Budget tokens depend on
 * the model's catalog flag (`adaptive` → larger budget; `enabled` → smaller).
 * Note: the orchestrator further mutates this object per task type at the
 * call site (see processMessage taskType branch); that override remains in
 * the orchestrator because it depends on PIL task-type context.
 */
class AnthropicProviderCapabilities extends ReliableProviderCapabilities {
  override buildProviderOptions(ctx: BuildProviderOptionsCtx): Record<string, unknown> | undefined {
    const m = ctx.model;
    if (m?.thinkingType === "adaptive") {
      return { anthropic: { thinking: { type: "enabled", budgetTokens: 10_000 } } };
    }
    if (m?.thinkingType === "enabled") {
      return { anthropic: { thinking: { type: "enabled", budgetTokens: 8_000 } } };
    }
    return undefined;
  }
  override consoleSignupURL(): string {
    return consoleUrlFor("anthropic");
  }
  override cacheMetricLayout(): { readField: string; creationSupported: boolean } {
    return { readField: "cachedInputTokens", creationSupported: true };
  }
  override systemPromptStyle(): "anthropic" | "openai" | "generic" {
    return "anthropic";
  }
}

/**
 * OpenAI: reasoning models require the Responses API (was hardcoded in
 * runtime.ts:185 — now centralized). Provider options merge reasoningEffort
 * (resolve-time, no session needed) with promptCacheKey (per-turn, derived
 * from sessionId — see F1 in src/providers/runtime.ts).
 */
class OpenAIProviderCapabilities extends ReliableProviderCapabilities {
  override usesResponsesAPI(model: ModelInfo | undefined): boolean {
    return model?.responsesOnly === true || model?.reasoning === true;
  }
  override buildProviderOptions(ctx: BuildProviderOptionsCtx): Record<string, unknown> | undefined {
    const m = ctx.model;
    const openai: Record<string, unknown> = {};
    if (m?.supportsReasoningEffort) {
      openai.reasoningEffort = ctx.reasoningEffort ?? m.defaultReasoningEffort ?? "medium";
    }
    if (ctx.sessionId) {
      const key = computePromptCacheKey(ctx.sessionId);
      if (key) openai.promptCacheKey = key;
    }
    return Object.keys(openai).length > 0 ? { openai } : undefined;
  }
  override consoleSignupURL(): string {
    return consoleUrlFor("openai");
  }
  override systemPromptStyle(): "anthropic" | "openai" | "generic" {
    return "openai";
  }
}

/**
 * xAI Grok supports OpenAI-style reasoning effort via the `xai` namespace.
 */
class XAIProviderCapabilities extends ReliableProviderCapabilities {
  override buildProviderOptions(ctx: BuildProviderOptionsCtx): Record<string, unknown> | undefined {
    const m = ctx.model;
    if (m?.supportsReasoningEffort) {
      return { xai: { reasoningEffort: ctx.reasoningEffort ?? m.defaultReasoningEffort ?? "medium" } };
    }
    return undefined;
  }
  override consoleSignupURL(): string {
    return consoleUrlFor("xai");
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
  /** Namespace used for openai-compatible providerOptions merge. Overridden by SiliconFlow. */
  protected providerNamespace(): string {
    return "deepseek";
  }
  override supportsResponseTool(taskType: string): boolean {
    if (taskType === "general") return false;
    return true;
  }
  override consoleSignupURL(): string {
    return consoleUrlFor("deepseek");
  }
  override cacheMetricLayout(): { readField: string; creationSupported: boolean } {
    // DeepSeek emits cache reads only — never cache_creation_tokens (see C1
    // in src/cli/cost-forensics.ts).
    return { readField: "promptCacheHitTokens", creationSupported: false };
  }
  // `@ai-sdk/openai-compatible@2.0.42` serializes assistant reasoning parts as
  // `reasoning_content` on the wire — BUT only for turns that actually carry a
  // reasoning part. In a multi-step tool loop some assistant turns make a tool
  // call with NO reasoning (e.g. a quick todo_write), and those serialize
  // WITHOUT a `reasoning_content` key. SiliconFlow's thinking-mode validator
  // then rejects the whole request (HTTP 400 / code 20015, verified on a live
  // wire body). The native round-trip is therefore necessary but NOT
  // sufficient. The real fix lives in the provider strategies'
  // `transformRequestBody` (see strategies/thinking-mode.ts): backfill
  // `reasoning_content: ""` onto every assistant turn (default), or disable
  // thinking via MUONROI_DEEPSEEK_DISABLE_THINKING=1 (fallback B).
  //
  // buildProviderOptions/sanitizeHistory inherit reliable no-op defaults.
}

/**
 * SiliconFlow shares DeepSeek's `<｜DSML｜>` tool-call quirk; everything else
 * (cache metric layout, signup URL pointer) differs only by namespace.
 */
class SiliconflowProviderCapabilities extends DeepSeekProviderCapabilities {
  protected override providerNamespace(): string {
    return "siliconflow";
  }
  override consoleSignupURL(): string {
    return consoleUrlFor("siliconflow");
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
  override consoleSignupURL(): string {
    return consoleUrlFor("ollama");
  }
}

/**
 * Google Gemini — defaults are reliable; only the console URL differs.
 */
class GoogleProviderCapabilities extends ReliableProviderCapabilities {
  override consoleSignupURL(): string {
    return consoleUrlFor("google");
  }
}

/**
 * Z.ai — defaults are reliable; only the console URL differs.
 */
class ZaiProviderCapabilities extends ReliableProviderCapabilities {
  override consoleSignupURL(): string {
    return consoleUrlFor("zai");
  }
}

const CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  anthropic: new AnthropicProviderCapabilities(),
  openai: new OpenAIProviderCapabilities(),
  google: new GoogleProviderCapabilities(),
  xai: new XAIProviderCapabilities(),
  deepseek: new DeepSeekProviderCapabilities(),
  siliconflow: new SiliconflowProviderCapabilities(),
  ollama: new OllamaProviderCapabilities(),
  zai: new ZaiProviderCapabilities(),
};

/**
 * Singleton resolver — returns the capability instance for a given
 * provider id. Falls back to the reliable defaults when the id is
 * unknown so new providers don't accidentally inherit a quirk override.
 */
export function getProviderCapabilities(providerId: ProviderId | string): ProviderCapabilities {
  return CAPABILITIES[providerId as ProviderId] ?? new ReliableProviderCapabilities();
}
