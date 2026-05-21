/**
 * src/ee/council-bridge.ts
 *
 * EE thin-client bridge for council integration.
 * Exposes queryExperience(topic, domain) which issues a single searchByText call
 * over experience-behavioral + experience-principles collections.
 *
 * Hard cap: 1.5s — per CONTEXT.md decision. Never throws. Degrades gracefully.
 * EE mode: thin-client only. Fat-mode is OUT OF SCOPE for v1.6.
 */

import type { EEPoint } from "./bridge.js";
import { searchByText } from "./bridge.js";

// Hard cap for council critical path (CONTEXT.md: 1.5s hard cap, pre-fetch parallel with clarifier)
const COUNCIL_EE_TIMEOUT_MS = 1500;

// Score floor matching PIL Layer 3 (0.55). Council only shows high-confidence warnings.
const COUNCIL_SCORE_FLOOR = (() => {
  const raw = Number(process.env.MUONROI_PIL_SCORE_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.55;
})();

const COUNCIL_SEARCH_COLLECTIONS = ["experience-behavioral", "experience-principles"];
const COUNCIL_SEARCH_TOP_K = 5;

export interface CouncilWarning {
  text: string;
  id: string;
  score: number;
  collection: string;
}

export interface CouncilExperienceResult {
  warnings: CouncilWarning[];
  /** Set when VPS unreachable or search failed. Council runs without experience. */
  error?: string;
}

/**
 * Query EE brain for past warnings relevant to the council topic + domain.
 * Issues a single thin-client searchByText call (1.5s hard cap).
 * Returns empty warnings array on any failure — never throws.
 */
export async function queryExperience(
  topic: string,
  domain: string | undefined,
  signal?: AbortSignal,
): Promise<CouncilExperienceResult> {
  // Combine topic + domain into search query for better recall
  const query = domain ? `${topic} [domain: ${domain}]` : topic;

  // Use the shorter of: caller signal or 1.5s hard cap
  const timeoutSignal = AbortSignal.timeout(COUNCIL_EE_TIMEOUT_MS);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const points = await searchByText(query, COUNCIL_SEARCH_COLLECTIONS, COUNCIL_SEARCH_TOP_K, effectiveSignal);

    const kept = points.filter((p) => (p.score ?? 0) >= COUNCIL_SCORE_FLOOR);

    const warnings: CouncilWarning[] = kept.map((p) => ({
      text: extractText(p),
      id: String(p.id),
      score: p.score ?? 0,
      collection: (p.payload?.collection as string) ?? "experience-behavioral",
    }));

    return { warnings };
  } catch (err) {
    return { warnings: [], error: String(err) };
  }
}

function extractText(p: EEPoint): string {
  const payload = p.payload ?? {};
  const direct = payload.text as string | undefined;
  if (direct) return direct;
  try {
    const parsed = JSON.parse((payload.json as string) || "{}") as {
      solution?: string;
      principle?: string;
      judgment?: string;
    };
    return parsed.solution ?? parsed.principle ?? parsed.judgment ?? "";
  } catch {
    return "";
  }
}
