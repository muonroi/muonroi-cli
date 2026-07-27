/**
 * src/council/stance.ts
 *
 * Projects a leader evaluation's per-criterion stances onto the PINNED spec
 * criteria and the CURRENT panel roster, producing the `CouncilStanceRow[]` the
 * rail and the Ctrl+T stance matrix render.
 *
 * The whole point of this module is that it is *conservative*. A stance matrix
 * is read as "who is blocking convergence", so every uncertain input has to
 * degrade to `null` (renders `·`, "has not spoken") and never to a mark:
 *
 *   - criterion the leader did not grade      → every panelist null
 *   - role the leader invented                → dropped (not a column)
 *   - panelist the leader never mentioned     → null
 *   - mark outside the "+" / "-" / "~" set    → null
 *
 * A fabricated "+" is worse than a missing one: it turns a live disagreement
 * into a fake consensus at exactly the moment the user is deciding whether to
 * pay for another round.
 *
 * Pure + dependency-free so the rules above are unit-testable without a debate.
 */

import type { CouncilStanceMark, CouncilStanceRow } from "../types/index.js";
import type { LeaderEvaluation } from "./types.js";

/** Marks the leader is allowed to emit. Everything else degrades to null. */
const VALID_MARKS = new Set(["+", "-", "~"]);

/**
 * Unicode minus (U+2212) and en-dash render identically to ASCII "-" in a
 * terminal, and models emit them interchangeably. Fold them rather than
 * discarding a stance the leader clearly expressed.
 */
const MINUS_ALIASES = new Set(["−", "–", "—"]);

function normalizeMark(raw: unknown): CouncilStanceMark {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (MINUS_ALIASES.has(s)) return "-";
  if (VALID_MARKS.has(s)) return s as CouncilStanceMark;
  return null;
}

/**
 * Match a leader-emitted role key against the real roster.
 *
 * The leader is told to use the exact role labels, but models routinely return
 * a case variant or the abbreviation shown in the turn-order line ("arc" for
 * "architect"). Exact match wins; then case-insensitive; then a prefix match,
 * but ONLY when exactly one roster role matches — an ambiguous prefix attributes
 * a stance to the wrong panelist, which is the one failure this module exists to
 * prevent.
 */
export function resolveRoleKey(emitted: string, roster: readonly string[]): string | null {
  const key = emitted.trim();
  if (key.length === 0) return null;
  const exact = roster.find((r) => r === key);
  if (exact) return exact;
  const lower = key.toLowerCase();
  const ci = roster.filter((r) => r.toLowerCase() === lower);
  if (ci.length === 1) return ci[0]!;
  const prefix = roster.filter((r) => r.toLowerCase().startsWith(lower) || lower.startsWith(r.toLowerCase()));
  return prefix.length === 1 ? prefix[0]! : null;
}

/** Every panelist mapped to `null` — the honest "nothing is known" row. */
function emptyStances(roster: readonly string[]): Record<string, CouncilStanceMark> {
  const out: Record<string, CouncilStanceMark> = {};
  for (const role of roster) out[role] = null;
  return out;
}

/**
 * Best-effort text match used to line a leader's criterion string up with the
 * pinned criterion at the same index. The leader is instructed to emit criteria
 * in order, so index is the primary key; this only guards against a model that
 * reordered them.
 */
function sameCriterion(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

export interface BuildStanceRowsInput {
  /** The user-pinned success criteria — the rows, in display order. */
  criteria: readonly string[];
  /** The leader's graded criteria for this round (may be short, empty, or reordered). */
  criteriaStatus: LeaderEvaluation["criteriaStatus"];
  /** Current panel role labels — the columns. */
  roster: readonly string[];
}

/**
 * Build one stance row per PINNED criterion.
 *
 * Row count always equals `criteria.length` — a criterion the leader skipped
 * still gets a row (all-null), because silently dropping it would shrink the
 * matrix and make the panel look closer to converged than it is.
 */
export function buildStanceRows({ criteria, criteriaStatus, roster }: BuildStanceRowsInput): CouncilStanceRow[] {
  const status = Array.isArray(criteriaStatus) ? criteriaStatus : [];
  return criteria.map((criterion, i) => {
    // Index first (the leader is told to preserve order), then fall back to a
    // text match so a reordered payload still lands on the right row.
    const byIndex = status[i];
    const entry =
      byIndex && sameCriterion(byIndex.criterion ?? "", criterion)
        ? byIndex
        : (status.find((s) => sameCriterion(s?.criterion ?? "", criterion)) ?? byIndex);

    if (!entry) {
      return { criterion, met: false, stances: emptyStances(roster) };
    }

    const stances = emptyStances(roster);
    const emitted = entry.stances;
    if (emitted && typeof emitted === "object") {
      for (const [rawRole, rawMark] of Object.entries(emitted)) {
        const role = resolveRoleKey(rawRole, roster);
        if (!role) continue; // invented role — not a column, drop it
        stances[role] = normalizeMark(rawMark);
      }
    }

    const split = typeof entry.split === "string" && entry.split.trim() ? entry.split.trim() : undefined;
    return { criterion, met: entry.met === true, stances, ...(split ? { split } : {}) };
  });
}

// NOTE: presentation helpers that derive labels from these rows (tally,
// verdict text, dissent extraction) live in
// src/ui/components/council-stance-matrix.tsx — nothing under src/ui imports
// from src/council, and keeping the split means this module stays pure
// parsing/normalization while formatting stays with the renderer.
