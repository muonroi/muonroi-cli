/**
 * /debug slash command — toggle pipeline debug tracing.
 *
 * When ON: each turn prints a trace showing every step from input to output:
 *   PIL layers → Router decision → EE hooks → Model call → Token savings
 *
 * Usage:
 *   /debug        — toggle on/off
 *   /debug on     — enable
 *   /debug off    — disable
 *   /debug status — show current pipeline state without toggling
 */

import { statusBarStore } from "../../state/status-bar-store.js";
import {
  getAllTraces,
  getLastTrace,
  isDebugEnabled,
  recordTurnTrace,
  setDebugEnabled,
  type TurnTrace,
} from "../../state/turn-trace.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

// Trace state (flag + ring buffer) + the PipelineStep/TurnTrace/SavingsEstimate
// types now live in src/state/turn-trace.ts so the headless core can record
// traces without importing src/ui. This file owns only formatting + the
// /debug slash command. Re-export for existing UI-side importers.
export type { PipelineStep, SavingsEstimate, TurnTrace } from "../../state/turn-trace.js";
export { isDebugEnabled, recordTurnTrace };

function formatTrace(trace: TurnTrace): string {
  const lines: string[] = [];
  lines.push(`┌─ Turn #${trace.turn_id} ─────────────────────────────────`);
  lines.push(`│ Prompt: "${trace.raw_prompt.slice(0, 80)}${trace.raw_prompt.length > 80 ? "..." : ""}"`);
  lines.push("│");

  for (const step of trace.steps) {
    const dur = step.duration_ms < 1 ? "<1ms" : `${step.duration_ms}ms`;
    const saved = step.tokens_saved ? ` (saved ~${step.tokens_saved} tok)` : "";
    lines.push(`│ ▸ ${step.name} [${dur}]${saved}`);
    if (step.input_summary) lines.push(`│   in:  ${step.input_summary}`);
    if (step.output_summary) lines.push(`│   out: ${step.output_summary}`);
  }

  lines.push("│");
  const routeLabel = trace.routed ? `${trace.model_requested} → ${trace.model_used} (routed)` : trace.model_used;
  lines.push(`│ Model: ${routeLabel}`);
  lines.push(
    `│ Tokens: ↑${trace.input_tokens} ↓${trace.output_tokens}${trace.cache_read_tokens ? ` ⊚${trace.cache_read_tokens}` : ""} | Cost: $${trace.cost_usd.toFixed(4)}`,
  );

  const s = trace.estimated_savings;
  if (s.total_tokens_saved > 0 || s.total_cost_saved_usd > 0) {
    lines.push("│");
    lines.push("│ ── Savings ──");
    if (s.pil_tokens_saved > 0) lines.push(`│   PIL enrichment:  ~${s.pil_tokens_saved} tokens saved`);
    if (s.cache_tokens_saved > 0) lines.push(`│   Cache hits:      ~${s.cache_tokens_saved} tokens saved`);
    if (s.router_cost_saved_usd > 0) lines.push(`│   Router downgrade: ~$${s.router_cost_saved_usd.toFixed(4)} saved`);
    lines.push(`│   Total: ~${s.total_tokens_saved} tokens, ~$${s.total_cost_saved_usd.toFixed(4)} saved`);
  }

  lines.push("└──────────────────────────────────────────────");
  return lines.join("\n");
}

function formatSessionSummary(): string {
  const s = statusBarStore.getState();
  const turnTraces = getAllTraces();
  const totalSavings = turnTraces.reduce(
    (acc, t) => ({
      tokens: acc.tokens + t.estimated_savings.total_tokens_saved,
      cost: acc.cost + t.estimated_savings.total_cost_saved_usd,
    }),
    { tokens: 0, cost: 0 },
  );

  const lines: string[] = [];
  lines.push("── Session Pipeline Summary ──");
  lines.push(`Turns traced: ${turnTraces.length}`);
  lines.push(`Total tokens: ↑${s.in_tokens} ↓${s.out_tokens}`);
  lines.push(`Session cost:  $${s.session_usd.toFixed(4)}`);
  if (totalSavings.tokens > 0) {
    lines.push(`Est. savings:  ~${totalSavings.tokens} tokens, ~$${totalSavings.cost.toFixed(4)}`);
    const pct = s.session_usd > 0 ? ((totalSavings.cost / (s.session_usd + totalSavings.cost)) * 100).toFixed(1) : "0";
    lines.push(`Efficiency:    ${pct}% cost reduction vs raw API`);
  }
  lines.push(`EE status:     ${s.ee_status}`);
  return lines.join("\n");
}

export const handleDebugSlash: SlashHandler = async (args, _ctx) => {
  const cmd = args[0]?.toLowerCase();

  if (cmd === "on") {
    setDebugEnabled(true);
    return "Pipeline debug tracing: ON\nEach turn will show: PIL → Router → EE hooks → Model → Savings";
  }
  if (cmd === "off") {
    setDebugEnabled(false);
    return "Pipeline debug tracing: OFF";
  }
  if (cmd === "status") {
    return formatSessionSummary();
  }
  if (cmd === "last") {
    const last = getLastTrace();
    if (!last) return "No traces recorded yet. Send a message with /debug on.";
    return formatTrace(last);
  }

  // Toggle
  const next = !isDebugEnabled();
  setDebugEnabled(next);
  if (next) {
    return "Pipeline debug tracing: ON\nEach turn will show: PIL → Router → EE hooks → Model → Savings\n\nCommands: /debug off | /debug status | /debug last";
  }
  return "Pipeline debug tracing: OFF";
};

registerSlash("debug", handleDebugSlash);
