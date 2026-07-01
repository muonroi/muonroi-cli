import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ModelInfo, ModelTier, ReasoningEffort } from "../types/index.js";

// Shared catalog API (services/catalog-api, deployed at catalog.muonroi.com).
// Overridable for self-hosting / local dev via MUONROI_CATALOG_URL.
// NOTE: the old default (cp.muonroi.com/api/v1/models) never existed server-side
// — the control-plane only serves a *rule* catalog — so the remote fetch always
// 404'd and the CLI silently used the bundled static catalog. This points at the
// real catalog service.
const DEFAULT_CATALOG_URL = "https://catalog.muonroi.com/api/v1/models";

export function getCatalogUrl(): string {
  const override = process.env.MUONROI_CATALOG_URL?.trim();
  return override && override.length > 0 ? override : DEFAULT_CATALOG_URL;
}

/**
 * Build request headers for the catalog fetch. Attaches the shared API key
 * (anti-spam) from MUONROI_CATALOG_API_KEY when present. When absent, the
 * request goes out keyless — fine for a self-hosted catalog with no key set,
 * and a 401 from a key-protected catalog simply triggers the static fallback.
 */
export function getCatalogHeaders(): Record<string, string> {
  const key = process.env.MUONROI_CATALOG_API_KEY?.trim();
  return key && key.length > 0 ? { "X-API-Key": key } : {};
}

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
  cache_write_price_per_million?: number;
  reasoning: boolean;
  thinking_type?: string | null;
  supports_effort?: boolean;
  description: string;
  aliases?: string[];
  default_reasoning_effort?: string | null;
  supports_vision?: boolean;
  /** When false, model is selectable via -m but skipped by tier routing. */
  tier_routing?: boolean;
}

interface CatalogResponse {
  version: string;
  updated_at: string;
  models: CatalogModel[];
}

// ─── Schema validation (catalog drift / corruption guard) ───────────────────
// The catalog is the single source of truth for model + provider routing. A
// silently-malformed catalog (truncated remote response, drifted bundled file,
// hand-edit dropping a required price field) would otherwise poison every
// tier→model resolution downstream. Validate the SHAPE we actually depend on;
// unknown future fields are ignored (forward-compatible), not rejected.
const CatalogModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.string().min(1),
    tier: z.string().min(1),
    context_window: z.number(),
    max_output_tokens: z.number(),
    input_price_per_million: z.number(),
    output_price_per_million: z.number(),
    cached_input_price_per_million: z.number().optional(),
    cache_write_price_per_million: z.number().optional(),
    reasoning: z.boolean(),
    thinking_type: z.string().nullable().optional(),
    supports_effort: z.boolean().optional(),
    description: z.string(),
    aliases: z.array(z.string()).optional(),
    default_reasoning_effort: z.string().nullable().optional(),
    supports_vision: z.boolean().optional(),
    tier_routing: z.boolean().optional(),
  })
  .loose();

const CatalogResponseSchema = z.object({
  version: z.string(),
  updated_at: z.string(),
  models: z.array(CatalogModelSchema).min(1),
});

/**
 * Best-effort validation for the REMOTE catalog: a transient bad response must
 * never break the CLI, so an invalid payload returns null and the caller falls
 * through to the trusted bundled catalog.
 */
export function safeValidateCatalog(raw: unknown): CatalogModel[] | null {
  const parsed = CatalogResponseSchema.safeParse(raw);
  return parsed.success ? (parsed.data.models as CatalogModel[]) : null;
}

/**
 * Strict validation for a STATIC (bundled) catalog that is present on disk: a
 * malformed bundled file is a build defect, not a runtime condition, so we
 * throw loudly with the validation issues rather than silently skipping it
 * (which would mask the defect as a confusing "cannot find catalog" later).
 */
export function validateStaticCatalog(raw: unknown, source: string): CatalogModel[] {
  const parsed = CatalogResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Malformed catalog at ${source}: ${issues}`);
  }
  return parsed.data.models as CatalogModel[];
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
    const res = await fetch(getCatalogUrl(), { signal: controller.signal, headers: getCatalogHeaders() });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      // Validate the remote payload before trusting it. An invalid/truncated
      // response falls through to the bundled catalog rather than caching junk.
      const models = safeValidateCatalog(data);
      if (models) {
        cachedModels = models;
        cacheTimestamp = Date.now();
        return cachedModels;
      }
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
      cachedModels = validateStaticCatalog(viaRequire, path.join(dir, "catalog.json"));
      cacheTimestamp = Date.now();
      return cachedModels;
    }

    // Try direct file read (more reliable in edge cases)
    const filePath = path.join(dir, "catalog.json");
    const viaFS = tryLoadCatalogViaFS(filePath);
    if (viaFS) {
      cachedModels = validateStaticCatalog(viaFS, filePath);
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
    cacheWritePrice: m.cache_write_price_per_million,
    reasoning: m.reasoning,
    description: m.description,
    tier: m.tier as ModelTier | undefined,
    provider: m.provider,
    aliases: m.aliases,
    supportsReasoningEffort: m.supports_effort ?? false,
    defaultReasoningEffort: (m.default_reasoning_effort as ReasoningEffort) ?? undefined,
    thinkingType: m.thinking_type as ModelInfo["thinkingType"],
    supportsVision: m.supports_vision ?? true,
    tierRouting: m.tier_routing ?? true,
  };
}
