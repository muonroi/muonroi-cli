import { createRequire } from "node:module";
import type { ModelInfo, ModelTier, ReasoningEffort } from "../types/index.js";

const CP_CATALOG_URL = "https://cp.muonroi.com/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  tier: string;
  context_window: number;
  max_output_tokens: number;
  input_price_per_million: number;
  output_price_per_million: number;
  reasoning: boolean;
  thinking_type?: string | null;
  supports_effort?: boolean;
  description: string;
  aliases?: string[];
  default_reasoning_effort?: string | null;
}

interface CatalogResponse {
  version: string;
  updated_at: string;
  models: CatalogModel[];
}

let cachedModels: CatalogModel[] | null = null;
let cacheTimestamp = 0;

export async function fetchCatalog(): Promise<CatalogModel[]> {
  // Return cache if fresh
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  // Try CP endpoint with 3s timeout
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(CP_CATALOG_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as CatalogResponse;
      cachedModels = data.models;
      cacheTimestamp = Date.now();
      return cachedModels;
    }
  } catch {
    // CP unreachable — fall through to static
  }

  // Fallback: read static catalog.json
  const require = createRequire(import.meta.url);
  const staticCatalog = require("./catalog.json") as CatalogResponse;
  cachedModels = staticCatalog.models;
  cacheTimestamp = Date.now();
  return cachedModels;
}

export function catalogModelToModelInfo(m: CatalogModel): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.context_window,
    inputPrice: m.input_price_per_million,
    outputPrice: m.output_price_per_million,
    reasoning: m.reasoning,
    description: m.description,
    tier: m.tier as ModelTier | undefined,
    provider: m.provider,
    aliases: m.aliases,
    supportsReasoningEffort: m.supports_effort ?? false,
    defaultReasoningEffort: (m.default_reasoning_effort as ReasoningEffort) ?? undefined,
    thinkingType: m.thinking_type as ModelInfo["thinkingType"],
  };
}
