/**
 * src/usage/downgrade.ts
 *
 * Auto-downgrade chain for USAGE-04.
 * premium -> balanced -> fast -> HALT with status-bar transition events.
 * Chain is derived from catalog.json tiers, not hardcoded model IDs.
 *
 * Plan 06 (status bar) subscribes to DowngradeEvent for UI updates.
 */

import { getModelByTier } from "../models/registry.js";
import { getDefaultProvider } from "../utils/settings.js";

function buildDowngradeChain(): ReadonlyArray<string> {
  const provider = getDefaultProvider() ?? undefined;
  const tiers: Array<"premium" | "balanced" | "fast"> = ["premium", "balanced", "fast"];
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const tier of tiers) {
    const m = getModelByTier(tier, provider);
    if (m && !seen.has(m.id)) {
      chain.push(m.id);
      seen.add(m.id);
    }
  }
  chain.push("HALT");
  return chain;
}

export function getDowngradeChain(): ReadonlyArray<string> {
  return buildDowngradeChain();
}

export interface DowngradeStep {
  next: string;
  isHalt: boolean;
  eventLabel: string;
}

export interface DowngradeEvent {
  fromModel: string;
  toModel: string;
  pct: number;
  atMs: number;
}

/**
 * Given the current model, return the next step down in the downgrade chain.
 * Unknown models are treated as top-of-chain (Opus position).
 */
export function downgradeChain(currentModel: string, capPct = 0): DowngradeStep {
  const chain = getDowngradeChain();
  const idx = chain.indexOf(currentModel);
  const i = idx === -1 ? 0 : idx; // unknown model treated as top
  const next = chain[i + 1] ?? "HALT";
  const isHalt = next === "HALT";

  const human = (m: string) =>
    m.includes("opus") ? "Opus" : m.includes("sonnet") ? "Sonnet" : m.includes("haiku") ? "Haiku" : m;

  const eventLabel = isHalt
    ? `Capping at ${capPct.toFixed(0)}% — halting (Haiku exhausted)`
    : `Capping at ${capPct.toFixed(0)}% — switching ${human(currentModel)} → ${human(next)}`;

  return { next, isHalt, eventLabel };
}

type Listener = (e: DowngradeEvent) => void;
const listeners = new Set<Listener>();

/**
 * Subscribe to downgrade transition events.
 * Returns an unsubscribe function.
 */
export function subscribeDowngrade(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Emit a downgrade event to all subscribers.
 * Called by decide() when cap-driven downgrade occurs.
 */
export function emitDowngrade(e: DowngradeEvent): void {
  for (const l of listeners) l(e);
}
