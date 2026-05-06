import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  cached_input_price_per_million?: number;
  reasoning: boolean;
  thinking_type?: string | null;
  supports_effort?: boolean;
  description: string;
  aliases?: string[];
  default_reasoning_effort?: string | null;
  supports_vision?: boolean;
}

interface CatalogResponse {
  version: string;
  updated_at: string;
  models: CatalogModel[];
}

let cachedModels: CatalogModel[] | null = null;
let cacheTimestamp = 0;

/**
 * Try to load catalog.json from a given directory using createRequire.
 */
function tryLoadCatalogViaRequire(dirUrl: string): CatalogResponse | null {
  try {
    const req = createRequire(dirUrl);
    return req("./catalog.json") as CatalogResponse;
  } catch {
    return null;
  }
}

/**
 * Try to load catalog.json by reading the file directly (fs).
 */
function tryLoadCatalogViaFS(filePath: string): CatalogResponse | null {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as CatalogResponse;
    }
  } catch {
    // ignore
  }
  return null;
}

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

  // Fallback: try multiple paths to find static catalog.json
  // Priority order: dist/models/ -> src/models/
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  const searchPaths = [
    // 1. Same directory as the built JS (dist/models/)
    moduleDir,
    // 2. src/models/ (for bun run dev from source)
    path.resolve(moduleDir, "../src/models"),
  ];

  for (const dir of searchPaths) {
    // Try createRequire first (works in both bundled and module contexts)
    const viaRequire = tryLoadCatalogViaRequire(dir);
    if (viaRequire) {
      cachedModels = viaRequire.models;
      cacheTimestamp = Date.now();
      return cachedModels;
    }

    // Try direct file read (more reliable in edge cases)
    const viaFS = tryLoadCatalogViaFS(path.join(dir, "catalog.json"));
    if (viaFS) {
      cachedModels = viaFS.models;
      cacheTimestamp = Date.now();
      return cachedModels;
    }
  }

  throw new Error(
    "Cannot find catalog.json. The package may be installed incorrectly. " +
    "Try reinstalling or setting MUONROI_API_KEY if you haven't already.",
  );
}

export function catalogModelToModelInfo(m: CatalogModel): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.context_window,
    inputPrice: m.input_price_per_million,
    outputPrice: m.output_price_per_million,
    cachedInputPrice: m.cached_input_price_per_million,
    reasoning: m.reasoning,
    description: m.description,
    tier: m.tier as ModelTier | undefined,
    provider: m.provider,
    aliases: m.aliases,
    supportsReasoningEffort: m.supports_effort ?? false,
    defaultReasoningEffort: (m.default_reasoning_effort as ReasoningEffort) ?? undefined,
    thinkingType: m.thinking_type as ModelInfo["thinkingType"],
    supportsVision: m.supports_vision ?? true,
  };
}
