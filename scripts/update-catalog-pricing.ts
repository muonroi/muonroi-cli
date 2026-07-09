/**
 * scripts/update-catalog-pricing.ts
 *
 * Fetches pricing from provider official/API sources, compares with current
 * src/models/catalog.json, and optionally applies updates.
 *
 * Usage:
 *   bun run scripts/update-catalog-pricing.ts          # dry-run: show diff only
 *   bun run scripts/update-catalog-pricing.ts --apply   # write changes to catalog.json
 *   bun run scripts/update-catalog-pricing.ts --diff    # explicit dry-run
 *
 * Providers covered:
 *   - DeepSeek native  → api.deepseek.com (models endpoint + known pricing)
 *   - SiliconFlow       → api.siliconflow.com/v1/models
 *   - OpenAI (OAuth)    → subscription-billed, price stays 0
 *   - Google/Agy        → no public pricing API; verify via known table
 *   - xAI (Grok)        → known pricing table
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── paths ────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.resolve(__dirname, "../src/models/catalog.json");

// ── types ────────────────────────────────────────────────────────────────
interface CatalogModel {
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
  default_reasoning_effort?: string | null;
  description: string;
  aliases?: string[];
  supports_vision?: boolean;
}

interface CatalogResponse {
  version: string;
  updated_at: string;
  description: string;
  models: CatalogModel[];
}

/** Source-of-truth provider IDs we expect */
const _ALL_PROVIDERS = new Set(["deepseek", "siliconflow", "openai", "google", "xai"]);

// ── known pricing tables (fallback when no API available) ────────────────

interface KnownPricing {
  input: number; // $ per 1M tokens
  output: number; // $ per 1M tokens
  cachedInput?: number;
  cacheWrite?: number;
}

/** Known pricing for models where no live API is accessible.
 *  Updated 2026-06. Verified against official docs. */
const KNOWN_PRICING: Record<string, KnownPricing> = {
  // ── DeepSeek native (api.deepseek.com) ──
  "deepseek-v4-flash": { input: 0.27, output: 1.1, cachedInput: 0.027 },
  "deepseek-v4-pro": { input: 0.55, output: 2.19, cachedInput: 0.055 },

  // ── SiliconFlow models not returned by their API or with no pricing in response ──
  // (most SF models are fetched live — see fetchSiliconFlowPricing)

  // ── OpenAI OAuth (subscription-billed — $0 per-token placeholder) ──
  // All gpt-* models under "openai" provider use $0/$0.

  // ── Google / Agy OAuth (no public pricing API) ──
  // Pricing sourced from Cloud Code pricing page + agy CLI model list.
  "gemini-3.5-flash-high": { input: 0.5, output: 3.0 },
  "gemini-3.5-flash-medium": { input: 0.5, output: 3.0 },
  "gemini-3.5-flash-low": { input: 0.5, output: 3.0 },
  "gemini-3.1-pro-high": { input: 2.0, output: 12.0 },
  "gemini-3.1-pro-low": { input: 2.0, output: 12.0 },
  "gemini-3-flash": { input: 0.3, output: 2.0 },
  "claude-sonnet-4.6-thinking": { input: 3.0, output: 15.0 },
  "claude-opus-4.6-thinking": { input: 15.0, output: 75.0 },
  "gpt-oss-120b-medium": { input: 0.2, output: 0.8 },

  // ── xAI (Grok) — verified docs.x.ai / Grok CLI catalog 2026-07-09 ──
  "grok-4.5": { input: 2.0, output: 6.0, cachedInput: 0.5 },
  "grok-composer-2.5-fast": { input: 3.0, output: 15.0 },
};

// ── helpers ──────────────────────────────────────────────────────────────

function fmtP(v: number): string {
  return `$${v.toFixed(4)}`.replace(/\.?0+$/, ""); // $0.5, $0.27, $0.027
}

function pricesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.00001;
}

function loadCatalog(): CatalogResponse {
  const raw = fs.readFileSync(CATALOG_PATH, "utf-8");
  return JSON.parse(raw) as CatalogResponse;
}

function saveCatalog(catalog: CatalogResponse): void {
  fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf-8");
}

// ── API fetchers ─────────────────────────────────────────────────────────

interface PriceOverride {
  modelId: string;
  input_price_per_million: number;
  output_price_per_million: number;
  cached_input_price_per_million?: number;
  cache_write_price_per_million?: number;
  context_window?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  supports_effort?: boolean;
  description?: string;
}

/**
 * Fetch model listing from SiliconFlow API.
 * Response includes model id, context_window, and pricing fields.
 */
async function fetchSiliconFlowPricing(): Promise<PriceOverride[]> {
  const results: PriceOverride[] = [];
  try {
    const key = process.env.SILICONFLOW_API_KEY ?? process.env.MUONROI_SILICONFLOW_API_KEY;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;

    const res = await fetch("https://api.siliconflow.com/v1/models", {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`  [SF] API returned ${res.status} — skipping live fetch`);
      return results;
    }
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };

    // SF returns { data: [ { id, object, created_by, owned_by, ... } ] }
    // Many fields are null for non-owners; extract what we can.
    const models = body.data ?? [];
    for (const raw of models) {
      const id = raw.id as string | undefined;
      if (!id) continue;

      // Pricing and context_window may be absent in public listing;
      // if absent we'll fall through to known table or keep current.
      const inpPrice = raw.input_price_per_million as number | undefined;
      const outPrice = raw.output_price_per_million as number | undefined;
      const ctx = raw.context_window as number | undefined;

      if (inpPrice == null) continue; // no pricing data from this response

      const override: PriceOverride = {
        modelId: id,
        input_price_per_million: inpPrice,
        output_price_per_million: outPrice ?? 0,
      };
      if (ctx != null) override.context_window = ctx;
      const cached = raw.cached_input_price_per_million as number | undefined;
      if (cached != null) override.cached_input_price_per_million = cached;
      results.push(override);
    }
    console.log(`  [SF] Fetched ${results.length} models with pricing`);
  } catch (err) {
    console.warn(`  [SF] Fetch failed: ${(err as Error)?.message ?? err}`);
  }
  return results;
}

/**
 * Fetch model pricing from DeepSeek API.
 * DeepSeek's v1/models returns model list but not pricing;
 * we use their known pricing table and only check that models exist.
 */
async function fetchDeepSeekPricing(): Promise<PriceOverride[]> {
  const results: PriceOverride[] = [];
  try {
    const key = process.env.DEEPSEEK_API_KEY ?? process.env.MUONROI_DEEPSEEK_API_KEY;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;

    const res = await fetch("https://api.deepseek.com/v1/models", {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`  [DeepSeek] API returned ${res.status} — using known pricing`);
      return results;
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const modelIds = new Set((body.data ?? []).map((m) => m.id));

    // Confirm our known models exist; emit warning if not found
    for (const knownId of Object.keys(KNOWN_PRICING).filter((k) => k.startsWith("deepseek-"))) {
      if (!modelIds.has(knownId)) {
        console.warn(`  [DeepSeek] Known model "${knownId}" not found in API listing — may be deprecated`);
      }
    }
    console.log(`  [DeepSeek] API returned ${modelIds.size} models, checked against known pricing`);
  } catch (err) {
    console.warn(`  [DeepSeek] Fetch failed: ${(err as Error)?.message ?? err} — using known pricing`);
  }
  return results;
}

// ── known-pricing table (no live API available) ─────────────────────────

function applyKnownPricing(): PriceOverride[] {
  const results: PriceOverride[] = [];
  for (const [modelId, p] of Object.entries(KNOWN_PRICING)) {
    results.push({
      modelId,
      input_price_per_million: p.input,
      output_price_per_million: p.output,
      ...(p.cachedInput != null ? { cached_input_price_per_million: p.cachedInput } : {}),
      ...(p.cacheWrite != null ? { cache_write_price_per_million: p.cacheWrite } : {}),
    });
  }
  return results;
}

// ── merge logic ──────────────────────────────────────────────────────────

interface DiffEntry {
  modelId: string;
  field: string;
  oldVal: unknown;
  newVal: unknown;
}

function mergePricing(
  catalog: CatalogResponse,
  overrides: PriceOverride[],
  sourceLabel: string,
  diffs: DiffEntry[],
): number {
  let changedCount = 0;

  for (const ov of overrides) {
    const existing = catalog.models.find((m) => m.id === ov.modelId);
    if (!existing) {
      // Model in override but not in catalog — we don't auto-add because
      // other fields (tier, description, aliases) would be missing.
      console.warn(`  [!] "${ov.modelId}" (from ${sourceLabel}) not in catalog — skip`);
      continue;
    }

    const check = (field: string, oldVal: number | undefined, newVal: number | undefined) => {
      if (oldVal == null || newVal == null) return;
      if (!pricesEqual(oldVal, newVal)) {
        diffs.push({ modelId: ov.modelId, field, oldVal, newVal });
        changedCount++;
      }
    };

    check("input_price_per_million", existing.input_price_per_million, ov.input_price_per_million);
    check("output_price_per_million", existing.output_price_per_million, ov.output_price_per_million);
    check("cached_input_price_per_million", existing.cached_input_price_per_million, ov.cached_input_price_per_million);
    check("cache_write_price_per_million", existing.cache_write_price_per_million, ov.cache_write_price_per_million);

    if (ov.context_window != null && ov.context_window !== existing.context_window) {
      diffs.push({
        modelId: ov.modelId,
        field: "context_window",
        oldVal: existing.context_window,
        newVal: ov.context_window,
      });
      changedCount++;
    }
  }
  return changedCount;
}

function applyDiffs(catalog: CatalogResponse, diffs: DiffEntry[]): number {
  let applied = 0;
  for (const d of diffs) {
    const model = catalog.models.find((m) => m.id === d.modelId);
    if (!model) continue;
    (model as Record<string, unknown>)[d.field] = d.newVal;
    applied++;
  }
  return applied;
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shouldApply = args.includes("--apply");
  const _shouldDiff = args.includes("--diff") || !shouldApply; // default: diff-only

  console.log(`Catalog: ${CATALOG_PATH}`);
  console.log("");

  const catalog = loadCatalog();
  const allDiffs: DiffEntry[] = [];

  // ── 1. SiliconFlow live API ──
  console.log("[1/4] Fetching SiliconFlow pricing...");
  const sfOverrides = await fetchSiliconFlowPricing();
  mergePricing(catalog, sfOverrides, "SiliconFlow API", allDiffs);

  // ── 2. DeepSeek live API ──
  console.log("[2/4] Fetching DeepSeek pricing...");
  const dsOverrides = await fetchDeepSeekPricing();
  mergePricing(catalog, dsOverrides, "DeepSeek API", allDiffs);

  // ── 3. Known pricing tables ──
  console.log("[3/4] Applying known pricing tables...");
  const knownOverrides = applyKnownPricing();

  // For known pricing, only apply if the model wasn't already updated by a live API
  const liveUpdatedIds = new Set([...sfOverrides, ...dsOverrides].map((o) => o.modelId));
  const filteredKnown = knownOverrides.filter((o) => !liveUpdatedIds.has(o.modelId));
  mergePricing(catalog, filteredKnown, "known pricing table", allDiffs);

  // ── 4. OpenAI OAuth: verify $0/$0 ──
  console.log("[4/4] Verifying OpenAI OAuth models...");
  for (const m of catalog.models) {
    if (m.provider === "openai") {
      if (m.input_price_per_million !== 0 || m.output_price_per_million !== 0) {
        // If non-zero, it might have been overridden — flag for review
        console.warn(
          `  [openai] "${m.id}" has non-zero pricing (in=${m.input_price_per_million}, out=${m.output_price_per_million}) — OAuth models should be $0`,
        );
      }
    }
  }

  // ── report ──
  console.log("");
  if (allDiffs.length === 0) {
    console.log("✅ All pricing matches current catalog — no changes needed.");
  } else {
    console.log(`📊 Found ${allDiffs.length} difference(s):`);
    for (const d of allDiffs) {
      console.log(`   ${d.modelId}.${d.field}: ${fmtP(d.oldVal as number)} → ${fmtP(d.newVal as number)}`);
    }

    if (shouldApply) {
      const applied = applyDiffs(catalog, allDiffs);
      catalog.version = bumpVersion(catalog.version);
      catalog.updated_at = new Date().toISOString().slice(0, 10);
      saveCatalog(catalog);
      console.log(`✅ Applied ${applied} change(s) and bumped version to ${catalog.version}`);
    } else {
      console.log(`ℹ️  Run with --apply to write changes (dry-run mode)`);
    }
  }
}

function bumpVersion(v: string): string {
  const parts = v.split(".").map(Number);
  if (parts.length === 2) {
    return `${parts[0]}.${(parts[1] ?? 0) + 1}`;
  }
  return `${(parts[0] ?? 2) + 1}.0`;
}

await main();
