/**
 * src/state/turn-trace.ts
 *
 * Pipeline debug-trace state — the toggle flag + recorded per-turn traces.
 *
 * Presentation-agnostic: the headless core (tool-engine, message-processor)
 * records traces here without importing src/ui. The /debug slash command
 * (src/ui/slash/debug.ts) owns the human formatting and toggling on top of
 * this state.
 */

let debugEnabled = false;
const turnTraces: TurnTrace[] = [];

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

export function setDebugEnabled(value: boolean): void {
  debugEnabled = value;
}

export function recordTurnTrace(trace: TurnTrace): void {
  if (!debugEnabled) return;
  turnTraces.push(trace);
  if (turnTraces.length > 50) turnTraces.shift();
}

export function getLastTrace(): TurnTrace | null {
  return turnTraces[turnTraces.length - 1] ?? null;
}

export function getAllTraces(): readonly TurnTrace[] {
  return turnTraces;
}
