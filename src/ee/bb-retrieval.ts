/**
 * src/ee/bb-retrieval.ts
 *
 * BB-aware retrieval: fetches Building-Block context from the Experience Engine
 * for use in /ideal CB-1 council prompts.
 *
 * ## Marker contract (shared with src/pil/layer3-ee-injection.ts)
 * Injected BB context is stamped with `<!-- bb-context-injected:<sha16> -->` where
 * sha16 = sha256(content).slice(0,16). layer3-ee-injection.ts scans the pipeline
 * context string for this prefix before appending any EE hit — any hit whose sha
 * matches an already-present marker is skipped to prevent duplication when both
 * injection paths are active in the same pipeline run.
 *
 * ## Feature flag
 * Reads `userSettings.eeBBContext` (default true). When false, returns empty
 * immediately without any network call or telemetry.
 *
 * ## Graceful degrade
 * On network failure or 4xx/5xx, returns empty result and logs once to stderr.
 * Never blocks /ideal — the caller should treat an empty result as "no context".
 */

import { createHash } from "node:crypto";
import { loadUserSettings } from "../utils/settings.js";
import { getCachedServerBaseUrl, loadEEAuthToken } from "./auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BBRecipe {
  name: string;
  score: number;
  /** Matched intent keywords from the recipe payload. */
  intentKeywords: string[];
  description?: string;
  /** Kept for compat with Phase 6 callers that reference sampleDir. */
  sampleDir?: string;
  packages?: string[];
}

export interface BBPackage {
  name: string;
  license: "OSS" | "Commercial" | string;
  description: string;
  score: number;
}

export interface BBBehavioralRule {
  text: string;
  score: number;
  sha?: string;
}

export interface BBContext {
  recipes: BBRecipe[];
  behavioralRules: BBBehavioralRule[];
  /** Typed package recommendations. Kept as string[] alias for backward compat. */
  packages: BBPackage[];
  /** ISO timestamp of retrieval. */
  retrievedAt: string;
  /** Total latency in ms for all queries. */
  latencyMs: number;
}

export interface FetchBBContextOpts {
  /** Max tokens to include in rendered output. Approximate: text.length / 4. Default: 1500. */
  maxTokens?: number;
  /** Max retrieval latency in ms (default 800). */
  timeoutMs?: number;
  /** Override EE base URL (for tests). Reads ~/.experience/config.json if absent. */
  eeBaseUrl?: string;
  /** Override auth token (for tests). */
  eeAuthToken?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Include commercial packages (default false). */
  commercial?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const BB_RETRIEVAL_TIMEOUT_MS = 800;
const BB_MAX_TOKENS_DEFAULT = 1500;

let _noRecipeLogged = false;
let _networkErrorLogged = false;

interface RawSearchPoint {
  id: string | number;
  score?: number;
  text?: string;
  payload?: Record<string, unknown>;
  collection?: string;
}

interface SearchResponse {
  points?: RawSearchPoint[];
}

async function queryCollection(
  prompt: string,
  collection: string,
  baseUrl: string,
  authToken: string | null,
  signal: AbortSignal,
): Promise<RawSearchPoint[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/search`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: prompt, collections: [collection], limit: 5 }),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`EE /api/search returned ${resp.status} for collection ${collection}`);
  }

  const data = (await resp.json()) as SearchResponse;
  return data.points ?? [];
}

async function queryWithRetry(
  prompt: string,
  collection: string,
  baseUrl: string,
  authToken: string | null,
  signal: AbortSignal,
): Promise<RawSearchPoint[]> {
  try {
    return await queryCollection(prompt, collection, baseUrl, authToken, signal);
  } catch {
    if (signal.aborted) return [];
    // Retry once
    try {
      return await queryCollection(prompt, collection, baseUrl, authToken, signal);
    } catch {
      return [];
    }
  }
}

function extractText(point: RawSearchPoint): string {
  if (point.text) return point.text;
  if (point.payload?.text && typeof point.payload.text === "string") return point.payload.text;
  try {
    const parsed = JSON.parse((point.payload?.json as string) || "{}") as {
      solution?: string;
      principle?: string;
      text?: string;
    };
    return parsed.text ?? parsed.solution ?? parsed.principle ?? "";
  } catch {
    return "";
  }
}

function extractKeywords(point: RawSearchPoint): string[] {
  try {
    const parsed = JSON.parse((point.payload?.json as string) || "{}") as { keywords?: string[] };
    if (Array.isArray(parsed.keywords)) return parsed.keywords;
  } catch {}
  if (Array.isArray(point.payload?.keywords)) return point.payload.keywords as string[];
  return [];
}

function extractPackageFields(point: RawSearchPoint): { name: string; license: string; description: string } {
  const text = extractText(point);
  try {
    const parsed = JSON.parse((point.payload?.json as string) || "{}") as {
      license?: string;
      name?: string;
      description?: string;
    };
    return {
      name: parsed.name ?? (point.payload?.name as string) ?? text.split(" ")[0] ?? "unknown",
      license: parsed.license ?? (point.payload?.license as string) ?? "OSS",
      description: parsed.description ?? text,
    };
  } catch {
    return { name: text.split(" ")[0] ?? "unknown", license: "OSS", description: text };
  }
}

/** Approximate token count: length / 4 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Select top-k items by score until token budget is reached. */
function applyTokenBudget<T extends { score: number }>(
  items: T[],
  maxTokens: number,
  getText: (item: T) => string,
): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  let used = 0;
  const result: T[] = [];
  for (const item of sorted) {
    const t = approxTokens(getText(item));
    if (used + t > maxTokens && result.length > 0) break;
    result.push(item);
    used += t;
  }
  return result;
}

// ---------------------------------------------------------------------------
// SHA marker (shared contract with layer3-ee-injection.ts)
// ---------------------------------------------------------------------------

/**
 * Compute the deduplication marker for injected BB content.
 * Format: `<!-- bb-context-injected:<sha16> -->`
 */
export function bbContextMarker(content: string): string {
  const sha = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `<!-- bb-context-injected:${sha} -->`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch BB context from the Experience Engine for use in council system prompts.
 *
 * Calls `/api/search` in parallel:
 *   - `bb-recipes` — closest sample recipes
 *   - `bb-behavioral` — behavioral rules
 *   - `bb-packages` — package recommendations (gracefully missing if collection absent)
 *
 * Total budget: ≤ 800ms with retry-once. Graceful degrade on any failure.
 * Returns empty result on feature-flag off, EE unconfigured, or network error.
 */
export async function fetchBBContext(prompt: string, opts: FetchBBContextOpts = {}): Promise<BBContext> {
  const empty: BBContext = {
    recipes: [],
    behavioralRules: [],
    packages: [],
    retrievedAt: new Date().toISOString(),
    latencyMs: 0,
  };

  // 5.7: Feature flag — default true
  const settings = loadUserSettings();
  if (settings.eeBBContext === false) {
    return empty;
  }

  const maxTokens = opts.maxTokens ?? BB_MAX_TOKENS_DEFAULT;
  const timeoutMs = opts.timeoutMs ?? BB_RETRIEVAL_TIMEOUT_MS;

  // Resolve EE base URL + auth token
  let baseUrl = opts.eeBaseUrl;
  let authToken: string | null = opts.eeAuthToken ?? null;

  if (!baseUrl) {
    try {
      authToken = await loadEEAuthToken();
    } catch {}
    baseUrl = getCachedServerBaseUrl() ?? undefined;
  }

  if (!baseUrl) {
    // EE not configured — degrade silently
    return empty;
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal: AbortSignal = opts.signal
    ? (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([opts.signal, timeout])
    : timeout;

  const t0 = Date.now();

  let recipeRaw: RawSearchPoint[] = [];
  let behavioralRaw: RawSearchPoint[] = [];
  let packagesRaw: RawSearchPoint[] = [];

  try {
    [recipeRaw, behavioralRaw, packagesRaw] = await Promise.all([
      queryWithRetry(prompt, "bb-recipes", baseUrl, authToken, signal),
      queryWithRetry(prompt, "bb-behavioral", baseUrl, authToken, signal),
      queryWithRetry(prompt, "bb-packages", baseUrl, authToken, signal),
    ]);
  } catch (err) {
    if (!_networkErrorLogged) {
      _networkErrorLogged = true;
      process.stderr.write(`[ee.bb] network error fetching BB context: ${String(err)}\n`);
    }
    return { ...empty, latencyMs: Date.now() - t0 };
  }

  const latencyMs = Date.now() - t0;

  // 5.2b: empty-collection guard for recipes
  if (recipeRaw.length === 0 && !_noRecipeLogged) {
    _noRecipeLogged = true;
    process.stderr.write("[ee.bb] no recipe hits — running Phase 3 ingestion would help\n");
  }

  // Map raw points to typed structures
  const recipes: BBRecipe[] = recipeRaw.map((p) => ({
    name: (p.payload?.name as string) ?? (extractText(p).split("\n")[0].slice(0, 60) || "unknown"),
    score: p.score ?? 0,
    intentKeywords: extractKeywords(p),
    description: extractText(p),
  }));

  const behavioralRules: BBBehavioralRule[] = behavioralRaw
    .map((p) => ({ text: extractText(p), score: p.score ?? 0 }))
    .filter((r) => r.text.length > 0);

  const allPackages: BBPackage[] = packagesRaw.map((p) => {
    const { name, license, description } = extractPackageFields(p);
    return { name, license, description, score: p.score ?? 0 };
  });

  // 5.4: Budget guard — trim to maxTokens across categories.
  // Allocation: 40% recipes, 40% behavioral, 20% packages.
  const recipeBudget = Math.floor(maxTokens * 0.4);
  const behavioralBudget = Math.floor(maxTokens * 0.4);
  const packagesBudget = Math.floor(maxTokens * 0.2);

  const trimmedRecipes = applyTokenBudget(recipes, recipeBudget, (r) => `${r.name} ${r.description ?? ""}`);
  const trimmedBehavioral = applyTokenBudget(behavioralRules, behavioralBudget, (r) => r.text);
  const trimmedPackages = applyTokenBudget(allPackages, packagesBudget, (p) => `${p.name} ${p.description}`);

  // 5.5: Telemetry via stderr when --debug-ee flag is set (no metrics.ts present)
  const debugEE = process.argv.includes("--debug-ee");
  if (debugEE) {
    process.stderr.write(
      `[ee.bb] hits: recipes=${trimmedRecipes.length} behavioral=${trimmedBehavioral.length} packages=${trimmedPackages.length} latency=${latencyMs}ms\n`,
    );
  }

  return {
    recipes: trimmedRecipes,
    behavioralRules: trimmedBehavioral,
    packages: trimmedPackages,
    retrievedAt: new Date().toISOString(),
    latencyMs,
  };
}

/**
 * Render BBContext to the council system prompt block.
 * Returns empty string when context has no hits.
 * Stamps the result with `<!-- bb-context-injected:<sha16> -->` for Layer 3 dedup.
 */
export function renderBBContextBlock(ctx: BBContext): string {
  if (ctx.recipes.length === 0 && ctx.behavioralRules.length === 0 && ctx.packages.length === 0) {
    return "";
  }

  const lines: string[] = ["## BB context (retrieved from Experience Engine)"];

  if (ctx.recipes.length > 0) {
    const top = ctx.recipes[0];
    const kw = top.intentKeywords.length > 0 ? top.intentKeywords.slice(0, 3).join(", ") : "general";
    lines.push(`Closest sample(s): ${top.name} (matches intent: ${kw})`);
    for (const r of ctx.recipes.slice(1)) {
      const k = r.intentKeywords.length > 0 ? r.intentKeywords.slice(0, 3).join(", ") : "general";
      lines.push(`  - ${r.name} (matches intent: ${k})`);
    }
  }

  if (ctx.packages.length > 0) {
    lines.push("Packages to consider:");
    for (const pkg of ctx.packages) {
      lines.push(`- ${pkg.name} (${pkg.license}) — ${pkg.description.slice(0, 120)}`);
    }
  }

  if (ctx.behavioralRules.length > 0) {
    lines.push("Behavioral rules:");
    for (const rule of ctx.behavioralRules) {
      lines.push(`- ${rule.text.slice(0, 200)}`);
    }
  }

  const content = lines.join("\n");
  return `${content}\n${bbContextMarker(content)}`;
}

// Reset helpers for test isolation
export function _resetBBRetrievalState(): void {
  _noRecipeLogged = false;
  _networkErrorLogged = false;
}
