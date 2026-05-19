/**
 * src/ee/bb-design.ts
 *
 * Plan 23-01a: EE-driven BB Package Design.
 *
 * Queries Experience Engine collections (bb-recipes, experience-principles,
 * bb-behavioral) in parallel to derive:
 *   - Matched BB template (mr-base-sln / mr-mod-sln / mr-micro-sln)
 *   - OSS-safe NuGet package ids (recipe.uses minus commercial flags)
 *   - Top-3 behavioral hints for system-prompt injection
 *
 * Returns null on any failure mode (EE unconfigured, timeout, HTTP error,
 * no template match) — caller falls back to manual menu.
 *
 * All failure paths route through `logEeFailure("bb-design", ...)` so
 * harness specs can assert and operators see structured warns.
 */

import { BB_TEMPLATE_PACKAGES, type BBTemplateInfo, SHORTNAME_TO_NUGET } from "../scaffold/init-new.js";
import { classifyEeError, logEeFailure, readTimeoutEnv, withEeTimeout } from "../utils/ee-logger.js";
import { getCachedServerBaseUrl, loadEEAuthToken } from "./auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BBDesign {
  /** Matched template (one of mr-base-sln / mr-mod-sln / mr-micro-sln). */
  template: BBTemplateInfo;
  /** OSS-safe NuGet package ids from recipe.uses, minus commercial blocks. */
  packageIds: string[];
  /**
   * Packages filtered out because experience-principles flags them commercial.
   * Surfaced in UI so user can opt in via --commercial.
   */
  commercialBlocked: string[];
  /** Top-3 bb-behavioral hints for system-prompt injection during code-gen. */
  behavioralHints: string[];
  /** Raw template description for the form preview. */
  rationale: string;
  /** Top recipe score (0..1). Used by UI to surface low-confidence warning. */
  confidence: number;
}

export interface DesignBBPackagesOpts {
  allowCommercial?: boolean;
  eeBaseUrl?: string;
  eeAuthToken?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Env-clamped timeout
// ---------------------------------------------------------------------------

const BB_DESIGN_TIMEOUT_MS = readTimeoutEnv("MUONROI_BB_DESIGN_TIMEOUT_MS", 1500, 500, 5000);

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

interface RawSearchPoint {
  id?: string | number;
  score?: number;
  text?: string;
  payload?: Record<string, unknown>;
  collection?: string;
}

interface SearchResponse {
  points?: RawSearchPoint[];
}

async function querySearch(
  query: string,
  collection: string,
  limit: number,
  baseUrl: string,
  authToken: string | null,
  signal: AbortSignal,
): Promise<RawSearchPoint[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/search`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, collections: [collection], limit }),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`EE /api/search returned ${resp.status} for collection ${collection}`);
  }

  const data = (await resp.json()) as SearchResponse;
  return data.points ?? [];
}

function extractText(point: RawSearchPoint): string {
  if (typeof point.text === "string" && point.text.length > 0) return point.text;
  const payloadText = point.payload?.text;
  if (typeof payloadText === "string") return payloadText;
  return "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Query the Experience Engine for a recommended BB template + package set
 * given a free-form intent string.
 *
 * Returns null on every failure mode:
 *   - EE base URL not configured (~/.experience/config.json missing)
 *   - Timeout fired (BB_DESIGN_TIMEOUT_MS)
 *   - HTTP error (any non-2xx)
 *   - No template recipe found in top-5 results
 *
 * All failure paths emit `logEeFailure("bb-design", ...)`.
 */
export async function designBBPackages(intent: string, opts: DesignBBPackagesOpts = {}): Promise<BBDesign | null> {
  const t0 = Date.now();
  const budgetMs = BB_DESIGN_TIMEOUT_MS;

  // 1. Resolve baseUrl + authToken
  let baseUrl = opts.eeBaseUrl;
  let authToken: string | null = opts.eeAuthToken ?? null;

  if (!baseUrl) {
    try {
      authToken = await loadEEAuthToken();
    } catch {
      /* ignored — fall through to baseUrl check */
    }
    baseUrl = getCachedServerBaseUrl() ?? undefined;
  }

  if (!baseUrl) {
    logEeFailure("bb-design", "error", new Error("EE base URL not configured"), {
      elapsedMs: Date.now() - t0,
      budgetMs,
    });
    return null;
  }

  // 2. Build signal: timeout + caller signal
  const timeoutSignal = AbortSignal.timeout(budgetMs);
  const signal: AbortSignal = opts.signal
    ? (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([opts.signal, timeoutSignal])
    : timeoutSignal;

  // 3. Three parallel queries, racing the combined timeout
  let recipes: RawSearchPoint[] = [];
  let principles: RawSearchPoint[] = [];
  let behavioral: RawSearchPoint[] = [];

  try {
    [recipes, principles, behavioral] = await withEeTimeout(
      Promise.all([
        querySearch(intent, "bb-recipes", 5, baseUrl, authToken, signal),
        querySearch(intent, "experience-principles", 20, baseUrl, authToken, signal),
        querySearch(intent, "bb-behavioral", 3, baseUrl, authToken, signal),
      ]),
      budgetMs,
    );
  } catch (err) {
    logEeFailure("bb-design", classifyEeError(err), err, {
      elapsedMs: Date.now() - t0,
      budgetMs,
    });
    return null;
  }

  // 4. From bb-recipes, find entries whose text starts with "Template "
  //    Pick the highest scoring template.
  const templateCandidates = recipes
    .filter((p) => extractText(p).startsWith("Template "))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (templateCandidates.length === 0) {
    logEeFailure("bb-design", "error", new Error("no template recipe in top-5 results"), {
      elapsedMs: Date.now() - t0,
      budgetMs,
    });
    return null;
  }

  const top = templateCandidates[0];
  const topText = extractText(top);
  const topScore = top.score ?? 0;

  // 5. Parse template text:
  //    Template <Description> (mr-xxx-sln): <Description> | uses: pkg1, pkg2, ...
  const shortNameMatch = topText.match(/\((mr-[a-z-]+)\)/);
  if (!shortNameMatch) {
    logEeFailure("bb-design", "error", new Error(`could not parse shortName from: ${topText.slice(0, 120)}`), {
      elapsedMs: Date.now() - t0,
      budgetMs,
    });
    return null;
  }
  const shortName = shortNameMatch[1];

  const usesMatch = topText.match(/\|\s*uses:\s*(.+?)(?:$|\n)/);
  const recipePackages = usesMatch
    ? usesMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  // Description = everything before " | uses:" (or full text if no uses clause).
  const pipeIdx = topText.indexOf(" | uses:");
  const rationale = pipeIdx >= 0 ? topText.slice(0, pipeIdx).trim() : topText.trim();

  // 6. Map shortName → BBTemplateInfo via SHORTNAME_TO_NUGET reverse lookup
  //    then enrich with version from BB_TEMPLATE_PACKAGES.
  const nugetId = SHORTNAME_TO_NUGET[shortName];
  if (!nugetId) {
    logEeFailure("bb-design", "error", new Error(`unknown template shortName: ${shortName}`), {
      elapsedMs: Date.now() - t0,
      budgetMs,
    });
    return null;
  }
  const pkgInfo = BB_TEMPLATE_PACKAGES.find((p) => p.nugetId === nugetId);
  if (!pkgInfo) {
    logEeFailure("bb-design", "error", new Error(`no BB_TEMPLATE_PACKAGES entry for nugetId: ${nugetId}`), {
      elapsedMs: Date.now() - t0,
      budgetMs,
    });
    return null;
  }
  const template: BBTemplateInfo = {
    shortName,
    nugetId,
    version: pkgInfo.version,
  };

  // 7. Build commercial set from experience-principles.
  //    Regex: `Commercial package <Name> requires` → capture <Name>
  const commercialSet = new Set<string>();
  for (const p of principles) {
    const text = extractText(p);
    const m = text.match(/Commercial package (\S+) requires/);
    if (m) commercialSet.add(m[1]);
  }

  // 8. Partition packageIds
  let packageIds: string[];
  let commercialBlocked: string[];
  if (opts.allowCommercial) {
    packageIds = [...recipePackages];
    commercialBlocked = [];
  } else {
    packageIds = recipePackages.filter((id) => !commercialSet.has(id));
    commercialBlocked = recipePackages.filter((id) => commercialSet.has(id));
  }

  // 9. behavioralHints = top-3 bb-behavioral text, deduped by exact match.
  const seenHints = new Set<string>();
  const behavioralHints: string[] = [];
  const sortedBehavioral = [...behavioral].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const p of sortedBehavioral) {
    const text = extractText(p);
    if (text.length === 0) continue;
    if (seenHints.has(text)) continue;
    seenHints.add(text);
    behavioralHints.push(text);
    if (behavioralHints.length >= 3) break;
  }

  return {
    template,
    packageIds,
    commercialBlocked,
    behavioralHints,
    rationale,
    confidence: topScore,
  };
}
