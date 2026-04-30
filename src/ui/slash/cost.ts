/**
 * src/ui/slash/cost.ts
 *
 * /cost slash command handler (USAGE-08).
 * Prints current status-bar contents: model, tier, tokens, USD/session, USD/month.
 * Reads directly from statusBarStore.getState() — works even without an active run.
 *
 * Self-registers on module import.
 */

import { statusBarStore } from '../status-bar/store.js';
import type { SlashHandler } from './registry.js';
import { registerSlash } from './registry.js';

export const handleCostSlash: SlashHandler = (_args, _ctx) => {
  const s = statusBarStore.getState();
  return [
    `Provider: ${s.provider || '(none)'}`,
    `Model:    ${s.model || '(none)'}`,
    `Tier:     ${s.tier}`,
    `Tokens:   ${s.in_tokens} in / ${s.out_tokens} out`,
    `Session:  $${s.session_usd.toFixed(4)}`,
    `Month:    $${s.month_usd.toFixed(4)} / $${s.cap_usd.toFixed(2)} (${s.current_pct.toFixed(1)}%)`,
  ].join('\n');
};

// Self-register on module import
registerSlash('cost', handleCostSlash);
