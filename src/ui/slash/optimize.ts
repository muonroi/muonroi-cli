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

import type { PipelineContext } from "../../pil/index.js";
import { getPilLastResult, runPipeline } from "../../pil/index.js";
import { getLastOutputMode } from "../../pil/store.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

function formatPilTable(ctx: PipelineContext): string {
  const header = `Enriched prompt: ${ctx.enriched}`;
  const style = `Output style: ${ctx.outputStyle ?? "(none)"}`;
  const table = ctx.layers
    .map((l) => `  ${l.name.padEnd(28)} applied=${l.applied ? "yes" : "no "}  delta=${l.delta ?? "(none)"}`)
    .join("\n");

  let metricsBlock = "";
  if (ctx.metrics) {
    const m = ctx.metrics;
    metricsBlock = `\n\nMetrics:\n  total pipeline: ${m.totalMs}ms\n  input chars: ${m.inputChars}\n  output chars: ${m.outputChars}\n  est. tokens saved: ${m.estimatedTokensSaved}\n  layer timings:\n${m.layerTimings.map((t) => `    ${t.name.padEnd(28)} ${t.ms}ms`).join("\n")}`;
  }

  const outputMode = `Output mode: ${getLastOutputMode()}`;

  return `${header}\n${style}\n${outputMode}\n\nLayer breakdown:\n${table}${metricsBlock}`;
}

export const handleOptimizeSlash: SlashHandler = async (args, _ctx) => {
  const ctx = args.length > 0 ? await runPipeline(args.join(" ")) : getPilLastResult();

  if (!ctx) {
    return '/optimize: no prompt processed yet — run a prompt first, or provide a string: /optimize "your prompt"';
  }

  return formatPilTable(ctx);
};

// Self-register on module import (same pattern as cost.ts)
registerSlash("optimize", handleOptimizeSlash);
