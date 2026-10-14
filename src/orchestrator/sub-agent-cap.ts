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
 * aggressively, and the agent is told that trimming got harder so it can
 * choose narrower calls. What the budget governs is how much tool output
 * the agent can afford to pull in — NOT whether its task is finished.
 * Until the hard ceiling, tools keep working; "done" stays the agent's
 * call, not the counter's.
 *
 * This is per-invocation state: each call to createSubAgentToolCap()
 * returns a fresh wrapper with its own counters. Don't share across
 * sub-agent runs.
 *
 * BUDGET SOURCE — do not read the 120_000 below as "the sub-agent budget".
 * DEFAULT_MAX_CUMULATIVE_CHARS (120_000) is only the fallback used when
 * wrapToolSetWithCap() is called WITHOUT maxCumulativeChars. The wired
 * budgets come from settings, not this constant:
 *   - sub-agent (`task`) turns: getSubAgentBudgetChars() → default 240_000
 *     (settings.ts), passed at stream-runner.ts.
 *   - top-level orchestrator turn: getTopLevelToolBudgetChars() → default
 *     400_000, wired at tool-engine.ts with looser 0.5/0.8 tier ratios.
 * See docs/agent-harness/CONTEXT-CONTROL-LAYERS.md for how this cap relates
 * to the other four context-control layers (compactor, rotation, reactive
 * sub-session, top-level cap).
 *
 * Tiers (percentages of whichever budget is in effect, NOT of 120_000):
 *   < 30%   → pass through (A1's 32KB per-call cap already applied)
 *   30-70%  → truncate each new result to 8_000 chars head/tail
 *   70-100% → truncate to 2_000 chars head + "[budget reached, trimming harder]" note
 *   ≥ 100%  → same head trim + a note naming the trim (tools still work)
 *   ≥ hardMax (2× budget) → error stub; every further tool call returns it,
 *             so at THAT point (and only there) the agent is told to return
 */

import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { isGuardRejectableCall } from "../tools/arg-guard.js";
import { anchorIsProvablyGone, type DedupCallContext, readCallContext, toIdSet } from "./tool-result-visibility.js";

/**
 * H5: the cross-turn dedup (C3) wraps this cap on the OUTSIDE, so it would
 * otherwise hash the cap's already-trimmed output — whose tier-dependent
 * truncation and live `cumulative` markers are non-deterministic, so identical
 * source content never produces a matching hash and dedup silently never fires.
 *
 * To let C3 key off the RAW pre-cap content while still SERVING the capped
 * output, the cap stashes the raw string under this Symbol on its result object.
 * A Symbol key is invisible to `JSON.stringify` (and thus to the provider wire),
 * so it can never leak into the model payload even if the dedup layer is
 * disabled and never strips it. `cross-turn-dedup.ts` reads it as the hash
 * source.
 */
export const RAW_FOR_DEDUP: unique symbol = Symbol("muonroi.rawForDedup");

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
  /**
   * Ratio at which mid-tier compression (head/tail trim) kicks in. Default
   * 0.3 for sub-agents (aggressive); top-level orchestrator uses 0.5 so
   * single-tool turns are not trimmed.
   */
  midTierRatio?: number;
  /**
   * Ratio at which high-tier compression (head only + a note naming the
   * harder trim) kicks in. Default 0.7 for sub-agents; top-level uses 0.8.
   */
  highTierRatio?: number;
  /**
   * Char target for mid-tier compression (head/tail trim). Default 8_000.
   */
  midTierChars?: number;
  /**
   * Char target for high-tier compression. Default 2_000.
   */
  highTierChars?: number;
  /** Identifier surfaced in budget-exhaustion stubs (for debugging). Default "sub-agent". */
  label?: string;
}

// Fallback ONLY — used when wrapToolSetWithCap gets no maxCumulativeChars.
// Real wired budgets are 240_000 (sub-agent) / 400_000 (top-level) from
// settings; see the header note. Keep this in sync only as the no-arg floor.
const DEFAULT_MAX_CUMULATIVE_CHARS = 120_000;
const DEFAULT_DEDUP_MIN_CHARS = 500;
const DEFAULT_MID_TIER_RATIO = 0.3;
const DEFAULT_HIGH_TIER_RATIO = 0.7;
const DEFAULT_MID_TIER_CHARS = 8_000;
const DEFAULT_HIGH_TIER_CHARS = 2_000;

export interface SubAgentCapState {
  /** Running sum of characters returned to the sub-agent so far. */
  cumulative: number;
  /** Configured ceiling. */
  max: number;
  /** Hard cap ceiling (e.g. max * 2). */
  hardMax?: number;
  /**
   * True once `cumulative >= hardMax` — from there every tool call returns the
   * exhausted stub instead of running. NOT set at `cumulative >= max`: that
   * tier only trims harder, and tools still work.
   */
  exhausted: boolean;
  /** Number of duplicate-output detections (telemetry / tests). */
  dedupHits: number;
  /**
   * Internal: short-hash → the anchor occurrence this layer would point at.
   *
   * `anchorToolCallId` is what makes the pointer resolvable at all. The old
   * pointer named only `callIndex` — an internal counter that appears NOWHERE in
   * the model's context, so even a live payload could not be located from it,
   * and `retrieve_tool_result` (keyed on tool_call_id) could not fetch it.
   */
  seenHashes: Map<string, { callIndex: number; anchorToolCallId?: string }>;
  /**
   * Times full content was re-served because the anchor a pointer would have
   * named was PROVEN gone from the model's view. Each one is a dead-pointer
   * loop that did not happen (measured: nine identical bash calls, all answered
   * with `[dup of call #N — reuse it]` after compaction had removed call #N).
   */
  staleReserves: number;
  /** Internal: call counter for stable pointers. */
  callIndex: number;
  /** Internal: feature flags from options. */
  dedupEnabled: boolean;
  dedupMinChars: number;
  midTierRatio: number;
  highTierRatio: number;
  midTierChars: number;
  highTierChars: number;
  label: string;
}

function trimHeadTail(text: string, target: number, label: string): string {
  if (text.length <= target) return text;
  const half = Math.floor(target / 2);
  return `${text.slice(0, half)}\n\n... [${text.length - target} chars trimmed by ${label} cap] ...\n\n${text.slice(-half)}`;
}

function trimHead(text: string, target: number, label: string): string {
  if (text.length <= target) return text;
  // The marker states what happened to THIS result. It must not read as an
  // instruction to wind the task up — see the note on the over-budget warning
  // in compressForCap() for the measured cost of that wording.
  return `${text.slice(0, target)}\n\n... [${text.length - target} chars trimmed — ${label} tool-output budget reached; results are trimmed harder from here] ...`;
}

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export function compressForCap(state: SubAgentCapState, raw: string, call?: DedupCallContext): string {
  const hardCeiling = state.hardMax ?? state.max;
  if (state.exhausted || state.cumulative >= hardCeiling) {
    state.exhausted = true;
    // Unlike the over-budget tier below, "summarize and return" is TRUE here:
    // past the hard ceiling every tool call — reads, writes, bash — returns
    // this stub instead of running, so no further work is possible and saying
    // otherwise would strand the agent in a loop of dead calls.
    return `[${state.label} tool budget exhausted (${state.cumulative}/${state.max} chars). Further tool calls will return this stub. Summarize findings now and return.]`;
  }
  state.callIndex += 1;

  // Dedup pass — if we've already returned this exact output, replace with a
  // pointer. Cheap protection against an agent that re-reads the same file or
  // re-runs the same grep mid-loop.
  if (state.dedupEnabled && raw.length >= state.dedupMinChars) {
    const hash = shortHash(raw);
    const anchor = state.seenHashes.get(hash);
    // A pointer may only be minted while the payload it names is still in the
    // history the model receives. The in-loop compactor elides older tool
    // results inside this very invocation, and the cross-turn compaction drops
    // them outright — either way the anchor goes away while this map does not,
    // and the agent is then told to "reuse" something it cannot read. It cannot
    // obtain the data and cannot stop asking: measured as nine identical bash
    // calls in a row, each answered with a 29-char dead pointer.
    if (anchor && anchorIsProvablyGone(anchor.anchorToolCallId, call)) {
      state.seenHashes.delete(hash);
      state.staleReserves += 1;
      // Fall through to normal compression: the content is re-served and
      // re-anchored below, to a copy the model can actually see.
    } else if (anchor) {
      state.dedupHits += 1;
      // F4 — short marker (~50 chars vs ~150), now carrying the tool_call_id.
      //
      // The id is not a nicety. `callIndex` is a counter private to THIS cap
      // instance: it is never written into any message, so "call #237" names
      // nothing the model has ever seen, and `retrieve_tool_result` — keyed on
      // tool_call_id — cannot look it up either. That made this pointer
      // unresolvable EVEN WHEN THE PAYLOAD WAS STILL LIVE. Compaction did not
      // create the trap; it only guaranteed that following the pointer was
      // impossible rather than merely useless. Anyone tempted to shorten this
      // marker again: dropping the id restores a pointer to nowhere.
      const id = anchor.anchorToolCallId ? ` (id=${anchor.anchorToolCallId})` : "";
      const stub = `[dup of call #${anchor.callIndex}${id} — reuse it]`;
      state.cumulative += stub.length;
      return stub;
    }
    state.seenHashes.set(hash, { callIndex: state.callIndex, anchorToolCallId: call?.toolCallId });
  }

  const ratio = state.cumulative / state.max;
  let out: string;
  if (state.cumulative >= state.max) {
    const trimmed = trimHead(raw, state.highTierChars, state.label);
    // This cap is REAL (cumulative/max are actual chars) and must be announced —
    // but it governs how much tool OUTPUT the agent can pull in, not whether its
    // task is finished. Tools still run at this tier; only the hard ceiling
    // (hardMax, above) stops them. The wording used to be "Please finalize your
    // work and summarize findings now", and the model read it as a quota it had
    // run out of: measured 2026-09-10, an agent that had worked 29 build errors
    // down to 6 wrote "Top-level budget exceeded. I need to mak…", stopped, and
    // committed a tree with 6 compile errors still in it. Say what is true — the
    // trim got harder — and leave "done" where it belongs: with the agent.
    out = `${trimmed}\n\n[Tool-output budget reached for ${state.label} (${state.cumulative}/${state.max} chars). Every tool result is now trimmed to its first ${state.highTierChars} chars, so prefer narrow, targeted calls (one file, one line range, one precise pattern) over broad ones. Tool calls still run and the task is not blocked on this message: keep working until the work itself is done.]`;
  } else if (ratio >= state.highTierRatio) {
    out = trimHead(raw, state.highTierChars, state.label);
  } else if (ratio >= state.midTierRatio) {
    out = trimHeadTail(raw, state.midTierChars, state.label);
  } else {
    out = raw;
  }
  state.cumulative += out.length;
  if (state.cumulative >= hardCeiling) state.exhausted = true;
  return out;
}

function compressResult(state: SubAgentCapState, raw: unknown, call?: DedupCallContext): unknown {
  if (typeof raw === "string") {
    return compressForCap(state, raw, call);
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.output === "string") {
      const rawOutput = obj.output;
      // H5: stash the RAW pre-cap output under a Symbol so the outer cross-turn
      // dedup keys off it (not the trimmed, marker-bearing capped output). The
      // Symbol never serializes to the model wire.
      return { ...obj, output: compressForCap(state, rawOutput, call), [RAW_FOR_DEDUP]: rawOutput };
    }
    // MCP tool result shape: { type: "content", value: [{type:"text", text}, ...] }.
    // Without this branch the whole payload escaped the cumulative tracker —
    // its text never counted toward the budget and was never compressed, so
    // many MCP calls could blow past the cap. Thread each text part through
    // compressForCap (counts + compresses + dedups); leave non-text parts
    // (images/media) intact so base64 isn't corrupted.
    if (obj.type === "content" && Array.isArray(obj.value)) {
      const value = obj.value.map((part) => {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return { ...(part as object), text: compressForCap(state, (part as { text: string }).text, call) };
        }
        return part;
      });
      return { ...obj, value };
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
        // F3 — a call the executor-side arg guard rejects never runs, so its
        // result is a CORRECTION, not tool output. Compressing it would count
        // it against the budget, and the cap's own content dedup would replace
        // the second identical correction with `[dup of call #N — reuse it]` —
        // telling the model to reuse the answer to a call that never succeeded.
        // Measured 2026-09-09 15:30:21 / 15:30:27; the model then repeated the
        // malformed shape instead of repairing it.
        if (isGuardRejectableCall(tool, name, input)) return await innerExecute(input, ctx);
        const result = await innerExecute(input, ctx);
        return compressResult(state, result, readCallContext(ctx));
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
  const max = Math.max(20_000, opts.maxCumulativeChars ?? DEFAULT_MAX_CUMULATIVE_CHARS);
  const state: SubAgentCapState = {
    cumulative: 0,
    max,
    hardMax: max * 2,
    exhausted: false,
    dedupHits: 0,
    seenHashes: new Map(),
    staleReserves: 0,
    callIndex: 0,
    dedupEnabled: opts.dedupRepeatOutputs ?? true,
    dedupMinChars: opts.dedupMinChars ?? DEFAULT_DEDUP_MIN_CHARS,
    midTierRatio: opts.midTierRatio ?? DEFAULT_MID_TIER_RATIO,
    highTierRatio: opts.highTierRatio ?? DEFAULT_HIGH_TIER_RATIO,
    midTierChars: opts.midTierChars ?? DEFAULT_MID_TIER_CHARS,
    highTierChars: opts.highTierChars ?? DEFAULT_HIGH_TIER_CHARS,
    label: opts.label ?? "sub-agent",
  };
  return {
    tools: wrapInternal(tools, state),
    state,
    rewrap: (next: ToolSet) => wrapInternal(next, state),
  };
}

/**
 * A compaction layer reports tool results it removed from the model's view.
 * Any dedup entry anchored to one of them is dropped, so the next identical
 * output is served in full and re-anchored to a copy the model can see.
 *
 * The complement to the `ToolCallOptions.messages` check in `compressForCap`:
 * the in-loop `prepareStep` compactor rewrites results for the provider only,
 * and the AI SDK hands tool execute() the array from BEFORE that rewrite, so
 * scanning the history cannot observe that elision. Idempotent — the compactor
 * re-derives the same id set on every step. Returns the number dropped.
 */
export function noteElidedForCap(state: SubAgentCapState, toolCallIds: Iterable<string>): number {
  const ids = toIdSet(toolCallIds);
  if (ids.size === 0) return 0;
  let removed = 0;
  for (const [hash, anchor] of state.seenHashes) {
    if (anchor.anchorToolCallId && ids.has(anchor.anchorToolCallId)) {
      state.seenHashes.delete(hash);
      removed += 1;
    }
  }
  return removed;
}

export const SUB_AGENT_DEFAULT_BUDGET_CHARS = DEFAULT_MAX_CUMULATIVE_CHARS;
