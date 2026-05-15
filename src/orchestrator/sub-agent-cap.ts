/**
 * Sub-agent cumulative tool-output cap.
 *
 * Background: when the orchestrator delegates work to a `task` sub-agent
 * (runTaskRequest / runTaskRequestBatch), the AI SDK drives an internal
 * tool loop that accumulates *every* tool result into the LLM context for
 * the next iteration. There is no auto-compact inside that loop —
 * `postTurnCompact()` only runs in the top-level orchestrator turn. So
 * one sub-agent reading 4 medium files can balloon the context past 500k
 * billed input tokens (real-world repro: session b58603caceb9).
 *
 * Fix: wrap each tool's `execute` with a cumulative-cost tracker. As the
 * sub-agent burns through its budget, returns are truncated more
 * aggressively — eventually telling the agent "budget low, wrap up" so
 * it stops scheduling more reads and produces its summary.
 *
 * This is per-invocation state: each call to createSubAgentToolCap()
 * returns a fresh wrapper with its own counters. Don't share across
 * sub-agent runs.
 *
 * Tiers (default 120_000 chars cumulative ≈ ~30k tokens):
 *   < 30%   → pass through (A1's 32KB per-call cap already applied)
 *   30-70%  → truncate each new result to 8_000 chars head/tail
 *   70-100% → truncate to 2_000 chars head + "[budget low, finalize work]" note
 *   ≥ 100%  → return error stub that signals the agent to stop expanding scope
 */

import { createHash } from "node:crypto";
import type { ToolSet } from "ai";

export interface SubAgentCapOptions {
  /** Total chars of tool output the sub-agent may receive before the cap kicks in fully. */
  maxCumulativeChars?: number;
  /**
   * If true (default), identical tool outputs (by content hash) within the
   * same sub-agent invocation are returned as a short reference stub on
   * subsequent occurrences. Cheap way to neutralize a sub-agent that
   * re-reads the same file or re-runs the same grep.
   */
  dedupRepeatOutputs?: boolean;
  /** Outputs below this length are not worth deduplicating. */
  dedupMinChars?: number;
}

const DEFAULT_MAX_CUMULATIVE_CHARS = 120_000;
const DEFAULT_DEDUP_MIN_CHARS = 500;

export interface SubAgentCapState {
  /** Running sum of characters returned to the sub-agent so far. */
  cumulative: number;
  /** Configured ceiling. */
  max: number;
  /** True once `cumulative >= max` (sub-agent should wrap up). */
  exhausted: boolean;
  /** Number of duplicate-output detections (telemetry / tests). */
  dedupHits: number;
  /** Internal: short-hash → first call index, for "see call #N" pointers. */
  seenHashes: Map<string, number>;
  /** Internal: call counter for stable pointers. */
  callIndex: number;
  /** Internal: feature flags from options. */
  dedupEnabled: boolean;
  dedupMinChars: number;
}

function trimHeadTail(text: string, target: number): string {
  if (text.length <= target) return text;
  const half = Math.floor(target / 2);
  return `${text.slice(0, half)}\n\n... [${text.length - target} chars trimmed by sub-agent cap] ...\n\n${text.slice(-half)}`;
}

function trimHead(text: string, target: number): string {
  if (text.length <= target) return text;
  return `${text.slice(0, target)}\n\n... [${text.length - target} chars trimmed — sub-agent budget low; finalize work] ...`;
}

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export function compressForCap(state: SubAgentCapState, raw: string): string {
  if (state.exhausted) {
    return `[sub-agent tool budget exhausted (${state.cumulative}/${state.max} chars). Further tool calls will return this stub. Summarize findings now and return.]`;
  }
  state.callIndex += 1;

  // Dedup pass — if we've already returned this exact output, replace with a
  // pointer. Cheap protection against an agent that re-reads the same file or
  // re-runs the same grep mid-loop.
  if (state.dedupEnabled && raw.length >= state.dedupMinChars) {
    const hash = shortHash(raw);
    const firstSeen = state.seenHashes.get(hash);
    if (firstSeen !== undefined) {
      state.dedupHits += 1;
      const stub = `[duplicate tool output detected — identical to result of call #${firstSeen} in this sub-agent (sha1:${hash}, ${raw.length} chars). Reuse the earlier result instead of re-running.]`;
      state.cumulative += stub.length;
      return stub;
    }
    state.seenHashes.set(hash, state.callIndex);
  }

  const ratio = state.cumulative / state.max;
  let out: string;
  if (ratio >= 0.7) {
    out = trimHead(raw, 2_000);
  } else if (ratio >= 0.3) {
    out = trimHeadTail(raw, 8_000);
  } else {
    out = raw;
  }
  state.cumulative += out.length;
  if (state.cumulative >= state.max) state.exhausted = true;
  return out;
}

function compressResult(state: SubAgentCapState, raw: unknown): unknown {
  if (typeof raw === "string") {
    return compressForCap(state, raw);
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.output === "string") {
      return { ...obj, output: compressForCap(state, obj.output) };
    }
  }
  return raw;
}

function wrapInternal(tools: ToolSet, state: SubAgentCapState): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const t = tool as Record<string, unknown>;
    const innerExecute = t.execute as ((input: unknown, ctx?: unknown) => unknown) | undefined;
    if (!innerExecute) {
      wrapped[name] = tool;
      continue;
    }
    // Spread the original tool object to preserve description, inputSchema, type, etc.
    wrapped[name] = {
      ...(tool as object),
      execute: async (input: unknown, ctx?: unknown) => {
        const result = await innerExecute(input, ctx);
        return compressResult(state, result);
      },
    } as ToolSet[string];
  }
  return wrapped;
}

/**
 * Wrap a ToolSet so every tool's execute() is intercepted and its output is
 * subjected to the cumulative cap. Original tool objects are not mutated.
 *
 * Returns { tools, state, rewrap } — `rewrap` lets you re-wrap an expanded
 * tool set later (e.g. after merging in MCP tools) while sharing the same
 * cumulative state.
 */
export function wrapToolSetWithCap(
  tools: ToolSet,
  opts: SubAgentCapOptions = {},
): {
  tools: ToolSet;
  state: SubAgentCapState;
  rewrap: (next: ToolSet) => ToolSet;
} {
  const state: SubAgentCapState = {
    cumulative: 0,
    max: Math.max(20_000, opts.maxCumulativeChars ?? DEFAULT_MAX_CUMULATIVE_CHARS),
    exhausted: false,
    dedupHits: 0,
    seenHashes: new Map(),
    callIndex: 0,
    dedupEnabled: opts.dedupRepeatOutputs ?? true,
    dedupMinChars: opts.dedupMinChars ?? DEFAULT_DEDUP_MIN_CHARS,
  };
  return {
    tools: wrapInternal(tools, state),
    state,
    rewrap: (next: ToolSet) => wrapInternal(next, state),
  };
}

export const SUB_AGENT_DEFAULT_BUDGET_CHARS = DEFAULT_MAX_CUMULATIVE_CHARS;
