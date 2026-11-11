/**
 * src/orchestrator/compaction-budget.ts
 *
 * Deterministic, NO-LLM size guarantee for `compactForContext`.
 *
 * Why it exists (session c2fda568be6b, TCIS replay 2026-11-06): 41
 * compactions, nearly all `saved 0` (e.g. 07:04 107,850 -> 108,728;
 * 11:44 942,316 -> 942,316). Neither the summarizer failures nor the
 * mechanical stub were the cause: the kept set itself was the whole history.
 * `WorkingContext.retainedMessages` keeps every turn that carries a
 * protection, and two protections are unbounded in size —
 *   - `outstanding-job`: any turn whose text MENTIONS a jobId that is not
 *     acknowledged. 10 of the session's 33 jobs were delivered but never
 *     acknowledged (4 of them failed), and their ids appear in most turns:
 *     829,813 tokens protected;
 *   - `user-pin-or-folded-policy`: 189,127 tokens;
 * plus every system message (158k tokens of "Background agent complete"
 * notices). Replayed offline against the session's own transcript: kept =
 * 988,382 of 1,037,345 tokens; with those two protections off, 218,765.
 * The history then grew to ~942k est tokens, the turn's preflight
 * (input + 64k output reserve > 1M window) refused every request, and the
 * overflow-recovery compaction could not shrink it either.
 *
 * Protections decide WHICH turns must stay visible; they must not decide that a
 * turn's bulk is incompressible. This pass keeps every retained message's
 * structure (tool-call/result pairing, ids, user text) and only shrinks its
 * payload, strongest-last:
 *   1. outside the verbatim tail: stub tool results (full output recorded for
 *      retrieve_tool_result), drop reasoning parts, truncate long system
 *      notices and long assistant text;
 *   2. the same over the tail, up to (not including) the current user turn;
 *   3. drop whole oldest turns until under the hard budget.
 * Levels 2-3 run only when the result would still not fit the model.
 */
import type { ModelMessage } from "ai";
import { logger } from "../utils/logger.js";
import { estimateConversationTokens, estimateMessageTokens } from "./compaction.js";

/** Tool outputs at or below this size are left verbatim (a stub would not be much smaller). */
const STUB_MIN_CHARS = 600;
/** Head kept from a truncated system notice / assistant text. */
const TRUNCATE_HEAD_CHARS = 1_200;
const TRUNCATE_TAIL_CHARS = 300;
/** System notices / assistant texts longer than this are truncated. */
const SYSTEM_TRUNCATE_AT = 2_000;
const ASSISTANT_TEXT_TRUNCATE_AT = 6_000;

export const HOST_COMPACTION_STUB_PREFIX = "[elided by host compaction]";

export interface CompactionBudgetOptions {
  systemPrompt: string;
  /** Level 1 runs when the result exceeds this many (estimated) tokens. */
  softBudgetTokens: number;
  /** Levels 2-3 run only when the result still exceeds this; <= 0 disables them. */
  hardBudgetTokens: number;
  /** Leading host messages (summary, ledger, receipt, pins) — never touched. */
  headCount: number;
  /** The verbatim tail the cut point chose; everything else is "retained by protection". */
  tail: ReadonlySet<ModelMessage>;
  /** Messages that must never be dropped at level 3 (e.g. pinned user messages). */
  neverDrop?: ReadonlySet<ModelMessage>;
  /** Record a stubbed tool output so retrieve_tool_result can rehydrate it. */
  persistArtifact?: (toolCallId: string, toolName: string, fullContent: string) => void;
}

export interface CompactionBudgetResult {
  messages: ModelMessage[];
  /** Index into the input array for every output message (callers keep parallel seq arrays aligned). */
  sourceIndices: number[];
  level: 0 | 1 | 2 | 3;
  tokensBefore: number;
  tokensAfter: number;
  stubbedToolResults: number;
  strippedReasoningParts: number;
  truncatedTexts: number;
  droppedMessages: number;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "value" in output) {
    const value = (output as { value: unknown }).value;
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
  }
  return JSON.stringify(output ?? "");
}

function truncateMiddle(text: string, why: string): string {
  const elided = text.length - TRUNCATE_HEAD_CHARS - TRUNCATE_TAIL_CHARS;
  return `${text.slice(0, TRUNCATE_HEAD_CHARS)}\n${HOST_COMPACTION_STUB_PREFIX} ${elided} chars ${why}\n${text.slice(-TRUNCATE_TAIL_CHARS)}`;
}

interface Counters {
  stubbed: number;
  reasoning: number;
  truncated: number;
}

function shrinkMessage(
  msg: ModelMessage,
  counters: Counters,
  persist: CompactionBudgetOptions["persistArtifact"],
): ModelMessage {
  if (msg.role === "system") {
    if (typeof msg.content !== "string" || msg.content.length <= SYSTEM_TRUNCATE_AT) return msg;
    if (msg.content.includes(HOST_COMPACTION_STUB_PREFIX)) return msg;
    counters.truncated++;
    return {
      ...msg,
      content: truncateMiddle(
        msg.content,
        "elided to fit the context window; delegation_read(jobId) or retrieve_tool_result returns full results",
      ),
    };
  }
  if (msg.role === "tool" && Array.isArray(msg.content)) {
    let changed = false;
    const content = (msg.content as unknown as Array<Record<string, unknown>>).map((part) => {
      if (part.type !== "tool-result") return part;
      const full = outputText(part.output);
      if (full.length <= STUB_MIN_CHARS || full.startsWith("[elided ")) return part;
      const toolCallId = String(part.toolCallId ?? "");
      const toolName = String(part.toolName ?? "tool");
      if (persist && toolCallId) {
        try {
          persist(toolCallId, toolName, full);
        } catch (err) {
          // The stub still goes out; only rehydration of this id is lost — say so in the log.
          logger.warn("orchestrator", "[compaction-budget] artifact persist failed; stubbing anyway", {
            toolCallId,
            toolName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      changed = true;
      counters.stubbed++;
      return {
        ...part,
        output: {
          type: "text",
          value:
            `${HOST_COMPACTION_STUB_PREFIX} ${toolName} result, ${full.length} chars. ` +
            `retrieve_tool_result(${JSON.stringify({ tool_call_id: toolCallId })}) returns it. Preview: ` +
            full.slice(0, 200).replace(/\s+/g, " ").trim(),
        },
      };
    });
    return changed ? ({ ...msg, content } as unknown as ModelMessage) : msg;
  }
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    let changed = false;
    const parts: Array<Record<string, unknown>> = [];
    for (const part of msg.content as unknown as Array<Record<string, unknown>>) {
      if (part.type === "reasoning") {
        counters.reasoning++;
        changed = true;
        continue;
      }
      if (part.type === "text" && typeof part.text === "string" && part.text.length > ASSISTANT_TEXT_TRUNCATE_AT) {
        counters.truncated++;
        changed = true;
        parts.push({
          ...part,
          text: truncateMiddle(part.text, "of an earlier answer elided to fit the context window"),
        });
        continue;
      }
      parts.push(part);
    }
    if (!changed) return msg;
    // Some providers reject an assistant message with no content at all.
    if (parts.length === 0) parts.push({ type: "text", text: `${HOST_COMPACTION_STUB_PREFIX} earlier reasoning` });
    return { ...msg, content: parts } as unknown as ModelMessage;
  }
  if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > ASSISTANT_TEXT_TRUNCATE_AT) {
    counters.truncated++;
    return { ...msg, content: truncateMiddle(msg.content, "of an earlier answer elided to fit the context window") };
  }
  return msg;
}

/**
 * Durable form of a compaction's retained-set decisions. The compaction row
 * persists only `first_kept_seq`, so after a reload every message from that seq
 * on came back verbatim, including the ones the live pass summarized away or
 * shrank (session c2fda568be6b: first_kept_seq stuck at 23). This spec rides on
 * the compaction row and reproduces the live view when the transcript is
 * rebuilt. It is a view over the canonical `messages` rows, never a rewrite of
 * them: dropping the compaction row (/expand) removes the spec with it.
 *
 * The shrink itself is not stored. {@link shrinkMessage} is a pure function of
 * the message, so the spec only records WHICH rows it applies to.
 */
export interface PersistedShrinkSpec {
  v: 1;
  /** Highest message seq that existed when the compaction ran; later rows are untouched. */
  throughSeq: number;
  /** Highest budget level the live pass reached (0 = only the retained set is recorded). */
  level: 0 | 1 | 2 | 3;
  /** First seq of the verbatim tail; rows below it were retained only by a protection. */
  tailFromSeq: number | null;
  /** First seq of the current turn at compaction time; it and everything after is never shrunk. */
  currentTurnFromSeq: number;
  /** Inclusive [from, to] seq ranges of rows the live view no longer holds (summarized or budget-dropped). */
  droppedRanges: Array<[number, number]>;
}

/** Collapse a set of seqs into sorted inclusive ranges (spec stays small for long sessions). */
export function toSeqRanges(seqs: Iterable<number>): Array<[number, number]> {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const seq of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && seq === last[1] + 1) last[1] = seq;
    else ranges.push([seq, seq]);
  }
  return ranges;
}

export function isPersistedShrinkSpec(value: unknown): value is PersistedShrinkSpec {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PersistedShrinkSpec>;
  return (
    v.v === 1 &&
    typeof v.throughSeq === "number" &&
    typeof v.level === "number" &&
    (v.tailFromSeq === null || typeof v.tailFromSeq === "number") &&
    typeof v.currentTurnFromSeq === "number" &&
    Array.isArray(v.droppedRanges) &&
    v.droppedRanges.every(
      (r) => Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number",
    )
  );
}

/**
 * Re-apply a persisted spec to the messages a compaction row keeps
 * (`firstKeptSeq` onward, in seq order). Rows the live pass dropped are
 * removed; rows it shrank are shrunk with the same pure function. Rows newer
 * than `throughSeq`, the current turn and rows with no seq are left alone.
 */
export function applyPersistedShrink(
  messages: readonly ModelMessage[],
  seqs: ReadonlyArray<number | null>,
  spec: PersistedShrinkSpec,
): { indices: number[]; messages: ModelMessage[] } {
  const dropped = spec.droppedRanges;
  const isDropped = (seq: number): boolean => {
    // Ranges are sorted and disjoint: binary search.
    let lo = 0;
    let hi = dropped.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [from, to] = dropped[mid]!;
      if (seq < from) hi = mid - 1;
      else if (seq > to) lo = mid + 1;
      else return true;
    }
    return false;
  };
  const counters: Counters = { stubbed: 0, reasoning: 0, truncated: 0 };
  const indices: number[] = [];
  const out: ModelMessage[] = [];
  messages.forEach((message, i) => {
    const seq = seqs[i] ?? null;
    if (seq === null || seq > spec.throughSeq) {
      indices.push(i);
      out.push(message);
      return;
    }
    if (isDropped(seq)) return;
    const inTail = spec.tailFromSeq !== null && seq >= spec.tailFromSeq;
    const shrinkable = seq < spec.currentTurnFromSeq && (spec.level >= 2 || !inTail) && spec.level >= 1;
    indices.push(i);
    out.push(shrinkable ? shrinkMessage(message, counters, undefined) : message);
  });
  return { indices, messages: out };
}

function lastUserIndex(messages: readonly ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
  return messages.length;
}

/**
 * Shrink `messages` (the post-compaction history) until it fits. Returns the
 * input by identity at level 0. Never touches the head or the current turn
 * (last user message onward); never reorders.
 */
export function enforceCompactionBudget(
  messages: readonly ModelMessage[],
  opts: CompactionBudgetOptions,
): CompactionBudgetResult {
  const measure = (ms: readonly ModelMessage[]) => estimateConversationTokens(opts.systemPrompt, ms as ModelMessage[]);
  const tokensBefore = measure(messages);
  const identity = messages.map((_, i) => i);
  const result: CompactionBudgetResult = {
    messages: messages as ModelMessage[],
    sourceIndices: identity,
    level: 0,
    tokensBefore,
    tokensAfter: tokensBefore,
    stubbedToolResults: 0,
    strippedReasoningParts: 0,
    truncatedTexts: 0,
    droppedMessages: 0,
  };
  if (!(opts.softBudgetTokens > 0) || tokensBefore <= opts.softBudgetTokens) return result;

  const counters: Counters = { stubbed: 0, reasoning: 0, truncated: 0 };
  const currentTurn = lastUserIndex(messages);
  const shrinkWhere = (ms: readonly ModelMessage[], eligible: (m: ModelMessage, i: number) => boolean) =>
    ms.map((m, i) => (eligible(m, i) ? shrinkMessage(m, counters, opts.persistArtifact) : m));

  // Level 1 — everything retained only by protection (outside the verbatim tail).
  let out = shrinkWhere(messages, (m, i) => i >= opts.headCount && i < currentTurn && !opts.tail.has(m));
  let level: CompactionBudgetResult["level"] = 1;
  let tokens = measure(out);
  const hard = opts.hardBudgetTokens > 0 ? opts.hardBudgetTokens : 0;

  // Level 2 — the tail too (not the current turn).
  if (hard > 0 && tokens > hard) {
    out = shrinkWhere(out, (_m, i) => i >= opts.headCount && i < currentTurn);
    level = 2;
    tokens = measure(out);
  }

  // Level 3 — drop whole oldest turns (a turn = a user message and everything
  // up to the next one, so tool-call/result pairs leave together).
  let indices = identity;
  if (hard > 0 && tokens > hard) {
    level = 3;
    const keep = out.map(() => true);
    let i = opts.headCount;
    while (i < currentTurn && tokens > hard) {
      let end = i + 1;
      while (end < currentTurn && out[end]?.role !== "user") end++;
      let pinned = false;
      for (let k = i; k < end; k++) if (opts.neverDrop?.has(messages[k]!)) pinned = true;
      if (!pinned) {
        for (let k = i; k < end; k++) {
          keep[k] = false;
          tokens -= estimateMessageTokens(out[k]!);
          result.droppedMessages++;
        }
      }
      i = end;
    }
    // A turn can own a call whose result landed after a LATER user message
    // (background jobs); dropping the call's turn would orphan that result,
    // which providers reject. Calls never follow their results, so only
    // orphaned results need removing.
    const callIds = new Set<string>();
    out.forEach((m, k) => {
      if (!keep[k] || m.role !== "assistant" || !Array.isArray(m.content)) return;
      for (const part of m.content as unknown as Array<Record<string, unknown>>)
        if (part.type === "tool-call" && typeof part.toolCallId === "string") callIds.add(part.toolCallId);
    });
    out = out.map((m, k) => {
      if (!keep[k] || m.role !== "tool" || !Array.isArray(m.content)) return m;
      const parts = m.content as unknown as Array<Record<string, unknown>>;
      const kept = parts.filter((p) => p.type !== "tool-result" || callIds.has(String(p.toolCallId ?? "")));
      if (kept.length === parts.length) return m;
      if (kept.length === 0) {
        keep[k] = false;
        result.droppedMessages++;
        return m;
      }
      return { ...m, content: kept } as unknown as ModelMessage;
    });
    indices = identity.filter((k) => keep[k]);
    out = indices.map((k) => out[k]!);
    tokens = measure(out);
  }

  result.messages = out;
  result.sourceIndices = indices;
  result.level = level;
  result.tokensAfter = tokens;
  result.stubbedToolResults = counters.stubbed;
  result.strippedReasoningParts = counters.reasoning;
  result.truncatedTexts = counters.truncated;
  return result;
}
