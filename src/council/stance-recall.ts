/**
 * src/council/stance-recall.ts
 *
 * Sprint-2 item 3 — per-stance recall at debate opening. Builds the
 * `CouncilConfig.stanceRecall` function from an EE client: given the panel's
 * unique roles and a query, it fires ONE stance-weighted `/api/recall` per role
 * (in parallel, bounded, failure-tolerant) and returns a `role → seed-text` map.
 *
 * The server weights the recall collections by the stance/role hint (researcher
 * → principles, implementer → behavioral, verifier → self-QA), so each stance
 * opens grounded in the slice of the brain its lens cares about — instead of the
 * whole panel sharing one generic recall.
 *
 * Contract: never throws. A role whose recall fails/empties/ times out simply
 * gets no entry in the map (that participant opens unchanged).
 */

import type { EERecallResponse } from "../ee/types.js";

/** Minimal EE-client surface this helper needs (keeps it unit-testable). */
export interface StanceRecallClient {
  recall(
    query: string,
    opts?: { stance?: string; cwd?: string; project?: string; sourceSession?: string; timeoutMs?: number },
  ): Promise<EERecallResponse | null>;
}

export interface StanceRecallOptions {
  cwd?: string;
  project?: string;
  sourceSession?: string;
  /** Per-recall timeout. Kept modest so N parallel recalls don't stall openings. */
  timeoutMs?: number;
  /** Cap the seed text folded into each opening so it can't blow the prompt. */
  maxSeedChars?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_SEED_CHARS = 1200;

/**
 * Build a `stanceRecall(roles, query)` function bound to an EE client. Returns
 * undefined when no client is available, so callers can spread it into
 * CouncilConfig without a conditional (`stanceRecall: makeStanceRecall(...)`).
 */
export function makeStanceRecall(
  client: StanceRecallClient | null | undefined,
  opts: StanceRecallOptions = {},
): ((roles: string[], query: string) => Promise<Map<string, string>>) | undefined {
  if (!client) return undefined;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSeedChars = opts.maxSeedChars ?? DEFAULT_MAX_SEED_CHARS;

  return async (roles: string[], query: string): Promise<Map<string, string>> => {
    const seeds = new Map<string, string>();
    const q = (query ?? "").trim();
    if (!q) return seeds;
    const unique = Array.from(new Set(roles.filter((r) => typeof r === "string" && r.trim())));
    if (unique.length === 0) return seeds;

    await Promise.all(
      unique.map(async (role) => {
        try {
          const resp = await client.recall(q, {
            stance: role,
            cwd: opts.cwd,
            project: opts.project,
            sourceSession: opts.sourceSession,
            timeoutMs,
          });
          const text = resp?.text?.trim();
          if (text) seeds.set(role, text.slice(0, maxSeedChars));
        } catch {
          /* per-role failure is non-fatal — that stance just opens unseeded */
        }
      }),
    );
    return seeds;
  };
}
