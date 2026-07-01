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

/** One peak window within a provider's local timezone (end_hour exclusive). */
export interface CatalogPeakHourWindow {
  start_hour: number;
  end_hour: number;
}

/** Peak-hour rule for a provider — sourced from vendor docs via catalog API. */
export interface CatalogProviderPeakHour {
  source_url: string;
  source_verified_at?: string;
  timezone: string;
  /** Single window — used when `windows` is absent (e.g. Z.ai 14–18). */
  start_hour?: number;
  end_hour?: number;
  /** Multiple peak windows (e.g. DeepSeek official: 09–12 and 14–18 UTC+8). */
  windows?: CatalogPeakHourWindow[];
  sensitive_model_ids: string[];
  fallback_model_id: string;
  switch_fallback_providers?: string[];
  peak_quota_multiplier?: number;
  off_peak_quota_multiplier?: number;
  policy_basis?: "official" | "heuristic";
  policy_note?: string;
}

export interface CatalogProviderPolicy {
  peak_hour?: CatalogProviderPeakHour;
}

export interface CatalogRouting {
  switch_provider_order?: string[];
}

export interface CatalogDocument {
  version: string;
  updated_at: string;
  description?: string;
  models: CatalogModel[];
  routing?: CatalogRouting;
  provider_policies?: Record<string, CatalogProviderPolicy>;
}

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
  /** Additional tiers for automatic routing (primary tier remains `tier`). */
  routing_tiers?: string[];
}

// ─── Schema validation (catalog drift / corruption guard) ───────────────────
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
    routing_tiers: z.array(z.string()).optional(),
  })
  .loose();

const CatalogPeakHourWindowSchema = z.object({
  start_hour: z.number().int().min(0).max(23),
  end_hour: z.number().int().min(1).max(24),
});

const CatalogProviderPeakHourSchema = z
  .object({
    source_url: z.string().min(1),
    source_verified_at: z.string().optional(),
    timezone: z.string().min(1),
    start_hour: z.number().int().min(0).max(23).optional(),
    end_hour: z.number().int().min(1).max(24).optional(),
    windows: z.array(CatalogPeakHourWindowSchema).min(1).optional(),
    sensitive_model_ids: z.array(z.string().min(1)).min(1),
    fallback_model_id: z.string().min(1),
    switch_fallback_providers: z.array(z.string().min(1)).optional(),
    peak_quota_multiplier: z.number().optional(),
    off_peak_quota_multiplier: z.number().optional(),
    policy_basis: z.enum(["official", "heuristic"]).optional(),
    policy_note: z.string().optional(),
  })
  .refine((d) => (d.windows?.length ?? 0) > 0 || (d.start_hour != null && d.end_hour != null), {
    message: "peak_hour requires windows or start_hour+end_hour",
  })
  .loose();

const CatalogResponseSchema = z
  .object({
    version: z.string(),
    updated_at: z.string(),
    description: z.string().optional(),
    models: z.array(CatalogModelSchema).min(1),
    routing: z
      .object({
        switch_provider_order: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    provider_policies: z
      .record(
        z.string(),
        z
          .object({
            peak_hour: CatalogProviderPeakHourSchema.optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

/**
 * Best-effort validation for the REMOTE catalog: a transient bad response must
 * never break the CLI, so an invalid payload returns null and the caller falls
 * through to the trusted bundled catalog.
 */
export function safeValidateCatalogDocument(raw: unknown): CatalogDocument | null {
  const parsed = CatalogResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data as CatalogDocument;
}

/** @deprecated Use safeValidateCatalogDocument — kept for callers that only need models. */
export function safeValidateCatalog(raw: unknown): CatalogModel[] | null {
  return safeValidateCatalogDocument(raw)?.models ?? null;
}

/**
 * Strict validation for a STATIC (bundled) catalog that is present on disk: a
 * malformed bundled file is a build defect, not a runtime condition, so we
 * throw loudly with the validation issues rather than silently skipping it
 * (which would mask the defect as a confusing "cannot find catalog" later).
 */
export function validateStaticCatalogDocument(raw: unknown, source: string): CatalogDocument {
  const parsed = CatalogResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Malformed catalog at ${source}: ${issues}`);
  }
  return parsed.data as CatalogDocument;
}

export function validateStaticCatalog(raw: unknown, source: string): CatalogModel[] {
  return validateStaticCatalogDocument(raw, source).models;
}

let cachedDocument: CatalogDocument | null = null;
let cacheTimestamp = 0;

/**
 * Try to load catalog.json from a given directory using createRequire.
 */
function tryLoadCatalogViaRequire(dirUrl: string): unknown | null {
  try {
    const req = createRequire(dirUrl);
    return req("./catalog.json");
  } catch {
    return null;
  }
}

/**
 * Try to load catalog.json by reading the file directly (fs).
 */
function tryLoadCatalogViaFS(filePath: string): unknown | null {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as unknown;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function fetchCatalogDocument(): Promise<CatalogDocument> {
  if (cachedDocument && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedDocument;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(getCatalogUrl(), { signal: controller.signal, headers: getCatalogHeaders() });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      const doc = safeValidateCatalogDocument(data);
      if (doc) {
        cachedDocument = doc;
        cacheTimestamp = Date.now();
        return cachedDocument;
      }
    }
  } catch {
    // remote unreachable — fall through to static
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const searchPaths = [moduleDir, path.resolve(moduleDir, "../src/models")];

  for (const dir of searchPaths) {
    const viaRequire = tryLoadCatalogViaRequire(dir);
    if (viaRequire) {
      cachedDocument = validateStaticCatalogDocument(viaRequire, path.join(dir, "catalog.json"));
      cacheTimestamp = Date.now();
      return cachedDocument;
    }

    const filePath = path.join(dir, "catalog.json");
    const viaFS = tryLoadCatalogViaFS(filePath);
    if (viaFS) {
      cachedDocument = validateStaticCatalogDocument(viaFS, filePath);
      cacheTimestamp = Date.now();
      return cachedDocument;
    }
  }

  throw new Error(
    "Cannot find catalog.json. The package may be installed incorrectly. " +
      "Try reinstalling or setting MUONROI_API_KEY if you haven't already.",
  );
}

export async function fetchCatalog(): Promise<CatalogModel[]> {
  return (await fetchCatalogDocument()).models;
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
    routingTiers: m.routing_tiers as ModelInfo["routingTiers"],
  };
}
