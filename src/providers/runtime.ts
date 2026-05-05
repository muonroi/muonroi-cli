import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOllama } from "ollama-ai-provider-v2";
import { getModelInfo } from "../models/registry.js";
import type { ModelInfo } from "../types/index.js";
import type { ProviderId } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderFactory = ((modelId: string) => any) & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responses?: (modelId: string) => any;
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
}

const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  siliconflow: "https://api.siliconflow.com/v1",
  xai: "https://api.x.ai/v1",
};

export function createProviderFactory(
  id: ProviderId,
  opts: { apiKey?: string; baseURL?: string },
): ProviderFactoryResult {
  switch (id) {
    case "anthropic": {
      const p = createAnthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      const factory: ProviderFactory = (modelId: string) => p(modelId);
      factory.responses = (modelId: string) => (p as any).responses(modelId);
      return { id, factory };
    }
    case "openai": {
      const p = createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      return { id, factory: (modelId: string) => p(modelId) };
    }
    case "google": {
      const p = createGoogleGenerativeAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      return { id, factory: (modelId: string) => p(modelId) };
    }
    case "deepseek":
    case "siliconflow":
    case "xai": {
      const p = createOpenAICompatible({
        name: id,
        baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS[id],
        apiKey: opts.apiKey,
      });
      return { id, factory: (modelId: string) => p(modelId) };
    }
    case "ollama": {
      const p = createOllama({ baseURL: opts.baseURL ?? "http://localhost:11434/api" });
      return { id, factory: (modelId: string) => p(modelId) };
    }
  }
}

export function resolveModelRuntime(
  factory: ProviderFactory,
  modelId: string,
): ResolvedModelRuntime {
  const model = factory(modelId);
  const modelInfo = getModelInfo(modelId);

  let providerOptions: Record<string, unknown> | undefined;

  if (modelInfo?.thinkingType === "adaptive") {
    providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 10_000 } } };
  } else if (modelInfo?.thinkingType === "enabled") {
    providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 8_000 } } };
  }

  if (modelInfo?.provider === "xai" && modelInfo.supportsReasoningEffort) {
    providerOptions = {
      ...providerOptions,
      xai: { reasoningEffort: modelInfo.defaultReasoningEffort ?? "medium" },
    };
  }

  return { model, modelId, modelInfo, providerOptions };
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
  if (id.startsWith("gemini") || id.startsWith("models/gemini")) return "google";
  if (id.startsWith("grok")) return "xai";
  if (id.includes("qwen") || id.includes("glm") || id.includes("internlm")) return "siliconflow";
  if (id.startsWith("llama") || id.startsWith("mistral") || id.startsWith("phi-")) return "ollama";
  return "anthropic";
}
