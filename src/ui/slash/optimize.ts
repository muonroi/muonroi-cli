/**
 * src/ui/slash/optimize.ts
 *
 * /optimize slash command (PIL-07, D-14, D-16, D-17).
 * No-arg: prints last turn's layer-by-layer summary table.
 * Arg: runs PIL pipeline on given string and prints same table.
 *
 * Output format: plain-text, terminal-compatible, headless-safe (D-17 — no ANSI color).
 * Self-registers on module import.
 */

import { registerSlash } from './registry.js';
import type { SlashHandler } from './registry.js';
import { runPipeline, getPilLastResult } from '../../pil/index.js';
import type { PipelineContext } from '../../pil/index.js';

function formatPilTable(ctx: PipelineContext): string {
  const header = `Enriched prompt: ${ctx.enriched}\n\nLayer breakdown:`;
  const table = ctx.layers
    .map((l) => `  ${l.name.padEnd(28)} applied=${l.applied ? 'yes' : 'no '}  delta=${l.delta ?? '(none)'}`)
    .join('\n');
  return `${header}\n${table}`;
}

export const handleOptimizeSlash: SlashHandler = async (args, _ctx) => {
  const ctx = args.length > 0
    ? await runPipeline(args.join(' '))
    : getPilLastResult();

  if (!ctx) {
    return '/optimize: no prompt processed yet — run a prompt first, or provide a string: /optimize "your prompt"';
  }

  return formatPilTable(ctx);
};

// Self-register on module import (same pattern as cost.ts)
registerSlash('optimize', handleOptimizeSlash);
