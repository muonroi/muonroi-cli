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

import { statusBarStore } from "../status-bar/store.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

let debugEnabled = false;
let turnTraces: TurnTrace[] = [];

export interface PipelineStep {
  name: string;
  duration_ms: number;
  input_summary: string;
  output_summary: string;
  tokens_saved?: number;
}

export interface TurnTrace {
  turn_id: number;
  timestamp: number;
  raw_prompt: string;
  steps: PipelineStep[];
  model_requested: string;
  model_used: string;
  routed: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  estimated_savings: SavingsEstimate;
}

export interface SavingsEstimate {
  pil_tokens_saved: number;
  cache_tokens_saved: number;
  router_cost_saved_usd: number;
  total_tokens_saved: number;
  total_cost_saved_usd: number;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function recordTurnTrace(trace: TurnTrace): void {
  if (!debugEnabled) return;
  turnTraces.push(trace);
  if (turnTraces.length > 50) turnTraces.shift();
}

export function getLastTrace(): TurnTrace | null {
  return turnTraces[turnTraces.length - 1] ?? null;
}

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
  const routeLabel = trace.routed
    ? `${trace.model_requested} → ${trace.model_used} (routed)`
    : trace.model_used;
  lines.push(`│ Model: ${routeLabel}`);
  lines.push(`│ Tokens: ↑${trace.input_tokens} ↓${trace.output_tokens}${trace.cache_read_tokens ? ` ⊚${trace.cache_read_tokens}` : ""} | Cost: $${trace.cost_usd.toFixed(4)}`);

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
    debugEnabled = true;
    return "Pipeline debug tracing: ON\nEach turn will show: PIL → Router → EE hooks → Model → Savings";
  }
  if (cmd === "off") {
    debugEnabled = false;
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
  debugEnabled = !debugEnabled;
  if (debugEnabled) {
    return "Pipeline debug tracing: ON\nEach turn will show: PIL → Router → EE hooks → Model → Savings\n\nCommands: /debug off | /debug status | /debug last";
  }
  return "Pipeline debug tracing: OFF";
};

registerSlash("debug", handleDebugSlash);
