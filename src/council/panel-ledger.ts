/**
 * src/council/panel-ledger.ts
 *
 * Per-speaker turns + spend for the rail's panel block.
 *
 * WHY THIS EXISTS AS A NEW EMIT PATH: council cost was already recorded, but
 * only in aggregate. `recordCouncilUsage` (llm.ts) writes a `usage_events` row
 * keyed by MODEL and mirrors the totals into the global StatusBar — neither
 * carries the panelist ROLE, and neither reaches the TUI's council state. So
 * "which panelist is this run actually paying for" was unanswerable live, and
 * `llm.debate()` was not even passing its `onUsage` callback at the three call
 * sites in debate.ts. This module is the accumulator that closes that gap.
 *
 * Honesty rules:
 *   - `usd` is priced from the model catalog, same formula as recordCouncilUsage.
 *   - A model with no catalog pricing contributes 0, and is reported as 0 —
 *     never a guess, and never silently dropped from the roster.
 *   - `turns` counts SETTLED turns (a turn that failed after retries still cost
 *     tokens and still counts) so the ledger matches what was billed.
 */

import { getModelInfo } from "../models/registry.js";
import type { CouncilPanelLedgerEntry } from "../types/index.js";
import { recordCouncilCallSpend } from "./spend-log.js";
import type { CouncilCallUsage } from "./types.js";

/**
 * Price one call in USD from the catalog.
 *
 * Mirrors the arithmetic in `recordCouncilUsage`: cached input bills at the
 * model's cached rate (falling back to 10% of the input rate, the ratio used
 * across the catalog), and prices are per-token micro-dollars.
 *
 * Returns 0 for an unpriced model rather than throwing or inventing a rate —
 * a missing price must not make a whole run's ledger disappear.
 */
export function priceCouncilCallUsd(modelId: string, usage: CouncilCallUsage): number {
  const info = getModelInfo(modelId);
  if (!info) return 0;
  const priceIn = info.inputPrice ?? 0;
  const priceCached = info.cachedInputPrice ?? priceIn * 0.1;
  const priceOut = info.outputPrice ?? 0;
  const nonCachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const micros = nonCachedInput * priceIn + usage.cachedInputTokens * priceCached + usage.outputTokens * priceOut;
  return micros / 1_000_000;
}

/**
 * Ledger key for the leader's own spend. Not a panelist — it never debates —
 * but it IS billed (one grading call per round, the largest non-panel cost), so
 * the rail renders it as a sigil-less row at the bottom of the panel block.
 * Exported so the UI can tell it apart from a debater and skip palette lookup.
 */
export const LEADER_LEDGER_ROLE = "leader";

export interface PanelLedger {
  /**
   * Add one BILLED CALL's spend to `role`. Fires once per provider call, so a
   * turn that retried and then fell back contributes three times — which is
   * correct, all three were billed. `modelUsed` is the model that actually ran
   * (a fallback prices differently from the model originally selected).
   */
  recordUsage(role: string, modelUsed: string, usage: CouncilCallUsage, phase?: string): void;
  /**
   * Mark one SETTLED TURN for `role`. Called once per turn regardless of how
   * many provider calls it took, so `turns` reads as "times this panelist
   * spoke", not "times we called an API". A turn that failed after retries
   * still counts — it still cost money and still consumed the round.
   */
  recordTurn(role: string, model: string): void;
  /** Immutable snapshot in first-seen role order (matches the palette slots). */
  snapshot(): CouncilPanelLedgerEntry[];
  /** True once at least one turn has been recorded — gates the emit. */
  hasEntries(): boolean;
}

export interface PanelLedgerOptions {
  /**
   * Session/run id. When present, every `recordUsage` call that also names a
   * phase is mirrored to the durable per-call spend log (`/cost --council`).
   * Omit and the ledger stays purely in-memory, exactly as before.
   */
  sessionId?: string;
}

export function createPanelLedger(options: PanelLedgerOptions = {}): PanelLedger {
  // Insertion-ordered: first-seen role order is the same order the rail's role
  // palette assigns slots, so the ledger rows line up with the sigil colors
  // used everywhere else in the council UI.
  const rows = new Map<string, { model: string; turns: number; usd: number }>();
  const upsert = (role: string, model: string) => {
    const key = role.trim();
    if (!key) return null;
    const prev = rows.get(key);
    if (prev) {
      // Keep the LATEST model that spoke for this role — a fallback swap
      // mid-run should show the model actually being billed.
      if (model) prev.model = model;
      return prev;
    }
    const fresh = { model, turns: 0, usd: 0 };
    rows.set(key, fresh);
    return fresh;
  };

  return {
    recordUsage(role, modelUsed, usage, phase) {
      const row = upsert(role, modelUsed);
      if (!row) return;
      const usd = priceCouncilCallUsd(modelUsed, usage);
      row.usd += usd;
      // Durable attribution for `/cost --council`. Only when the caller named a
      // phase: a row whose phase we would have to guess is worse than no row —
      // it would land in a breakdown that claims to know where the money went.
      if (phase && options.sessionId) {
        recordCouncilCallSpend(options.sessionId, {
          phase,
          role: role.trim(),
          model: modelUsed,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cachedInputTokens,
          usd,
        });
      }
    },
    recordTurn(role, model) {
      const row = upsert(role, model);
      if (!row) return;
      row.turns += 1;
    },
    snapshot() {
      return [...rows.entries()].map(([role, v]) => ({
        role,
        model: v.model || undefined,
        turns: v.turns,
        usd: v.usd,
      }));
    },
    hasEntries() {
      return rows.size > 0;
    },
  };
}
