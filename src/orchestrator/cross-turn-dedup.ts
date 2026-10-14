/**
 * Cross-turn tool-output deduplication (Phase C3).
 *
 * Phase C2 dedupes identical tool outputs WITHIN a single sub-agent
 * invocation via short-hash content hashing (see sub-agent-cap.ts). Phase
 * C3 extends this dedup across MULTIPLE turns of the same orchestrator
 * session — if the user prompts again in the same session and the agent
 * runs `read_file("x.ts")` twice, the second call's tool_result is
 * replaced with a short reference stub instead of re-billing the full
 * content.
 *
 * Design:
 *  - One CrossTurnDedup instance lives on the Orchestrator for the
 *    lifetime of the session.
 *  - Each tool-output string is hashed (sha256, first 16 hex chars). The first
 *    occurrence is cached verbatim; subsequent identical strings are
 *    replaced with a stub.
 *  - Cache is capped at 200 entries (LRU eviction via Map insertion
 *    order) so a long session does not balloon memory.
 *  - Outputs below DEFAULT_MIN_CHARS are skipped (not worth dedup
 *    overhead).
 *  - The instance is also wired into both the sub-agent tool wrapper
 *    and the top-level tool loop via wrapToolSetWithDedup().
 *
 * Disabled via env: MUONROI_CROSS_TURN_DEDUP=0.
 *
 * ---------------------------------------------------------------------------
 * The pointer-reachability invariant
 * ---------------------------------------------------------------------------
 * A cache entry may only produce a pointer while the payload it names is still
 * in the history the model receives. Without that invariant the dedup and the
 * compaction layers compose into an unbreakable loop: dedup assumes the earlier
 * result is still visible, compaction assumes a dropped result is no longer
 * needed, and neither knows about the other.
 *
 * Measured (interaction_logs, /ideal sprint): a `compact` tool call ran at
 * 02:30:26; from 02:33:45 an implementation sub-agent issued ONE identical bash
 * command nine times, 5-7s apart, writing nothing in between. All nine
 * tool_result rows were 29 chars — this module's pointer, each naming a
 * different earlier call whose content compaction had already removed. The model
 * could neither obtain the data nor stop asking.
 *
 * Two independent facts establish unreachability, and either is enough:
 *   1. the anchor tool-result is absent from `ToolCallOptions.messages` (the
 *      history the model was given for this step) — covers the cross-turn drop
 *      site, `Orchestrator.compactForContext` replacing `this.messages` with
 *      `[summary, ...keptMessages]`;
 *   2. a compaction layer reported the anchor as elided via `noteElided()` —
 *      covers the in-loop `prepareStep` drop site (`compactSubAgentMessages`),
 *      which the AI SDK structurally hides from tools. The measured evidence
 *      for that, and the probe to re-check it after an SDK upgrade, live once
 *      in `tool-result-visibility.ts`.
 *
 * Absence is proof of unreachability; presence is NOT proof of reachability —
 * hence both. On either signal the entry is dropped, so the identical call is
 * served in FULL and re-anchored to a copy the model can actually see. The dead
 * pointer becomes unrepresentable rather than merely recoverable-from: a pointer
 * can only be minted from an entry, and an entry only survives while its payload
 * does.
 */

import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { isGuardRejectableCall } from "../tools/arg-guard.js";
import { RAW_FOR_DEDUP } from "./sub-agent-cap";
import { anchorIsProvablyGone, type DedupCallContext, readCallContext, toIdSet } from "./tool-result-visibility.js";

export type { DedupCallContext };

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MIN_CHARS = 500;

export interface CrossTurnDedupEntry {
  /**
   * Full content of the anchor occurrence. Re-served verbatim when the anchor
   * is no longer reachable — the cache already holds the bytes, so repairing a
   * would-be dead pointer costs a lookup, not a retrieval.
   */
  content: string;
  /** 1-indexed turn number when this content was first observed. */
  firstSeenTurn: number;
  /** Tool name that originally produced the content (for the stub). */
  firstSeenToolName: string;
  /**
   * `toolCallId` of the call whose result this entry points at — the anchor.
   * Re-pointed whenever the content is re-served, so it always names the most
   * recent copy the model saw (the one least likely to be compacted away next).
   * Undefined when the caller had no tool-call context; then reachability can
   * neither be proven nor disproven from the message history.
   */
  anchorToolCallId?: string;
  /**
   * Number of SAME-TURN repeat calls seen for this content (0 until the first
   * in-turn re-call). Used to re-serve content once before hard-stopping a
   * loop — see the same-turn branch of maybeDedup.
   */
  sameTurnRepeats: number;
}

export interface CrossTurnDedupStats {
  /** Total dedup hits across the lifetime of this instance. */
  hits: number;
  /** Current cache size. */
  size: number;
  /** Lifetime number of distinct outputs inserted. */
  inserts: number;
  /**
   * Times the same-turn policy RE-SERVED full content instead of stubbing it
   * (the deliberate O1/O2 trade-off that avoids the single-read fallback). Each
   * one re-bills its content — the "leak" the dedup knowingly accepts.
   */
  sameTurnReserves: number;
  /**
   * Total characters re-served via the same-turn passthrough. This is the
   * MEASURABLE cost of the same-turn re-serve policy — invisible before because
   * `hits` only counted stubs, never the passthrough re-bills. Divide by ~4 for
   * a rough token estimate. Surfaced so a fix to the policy is falsifiable.
   */
  sameTurnReservedChars: number;
  /**
   * Times full content was re-served because the anchor a pointer would have
   * named was PROVEN unreachable (compaction dropped or elided it). Each one is
   * a nine-call loop that did not happen. A rising count against a flat `hits`
   * means compaction is out-running the dedup window — not that dedup broke.
   */
  staleReserves: number;
  /** Characters re-served by `staleReserves`. Divide by ~4 for a token estimate. */
  staleReservedChars: number;
  /** Entries dropped by `noteElided()` — payloads a compaction layer reported gone. */
  invalidated: number;
}

export interface CrossTurnDedupOptions {
  /** Hard cap on cache entries. Oldest are evicted (LRU by insertion order). */
  maxEntries?: number;
  /** Outputs below this length are not deduplicated. */
  minChars?: number;
  /** Master switch — set false to no-op every call. */
  enabled?: boolean;
}

// 16 hex chars = 64 bits → birthday collision at ~4B entries; LRU cap is 200, so overkill-safe.
function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export class CrossTurnDedup {
  private readonly cache = new Map<string, CrossTurnDedupEntry>();
  private readonly maxEntries: number;
  private readonly minChars: number;
  private readonly enabled: boolean;
  private currentTurn = 0;
  private hits = 0;
  private inserts = 0;
  private sameTurnReserves = 0;
  private sameTurnReservedChars = 0;
  private staleReserves = 0;
  private staleReservedChars = 0;
  private invalidated = 0;

  constructor(opts: CrossTurnDedupOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.minChars = Math.max(0, opts.minChars ?? DEFAULT_MIN_CHARS);
    this.enabled = opts.enabled ?? true;
  }

  /** Bump the turn counter. Call when a new user turn starts. */
  public beginTurn(): void {
    this.currentTurn += 1;
  }

  /** Current 1-indexed turn number (0 before first beginTurn). */
  public getTurn(): number {
    return this.currentTurn;
  }

  public getStats(): CrossTurnDedupStats {
    return {
      hits: this.hits,
      size: this.cache.size,
      inserts: this.inserts,
      sameTurnReserves: this.sameTurnReserves,
      sameTurnReservedChars: this.sameTurnReservedChars,
      staleReserves: this.staleReserves,
      staleReservedChars: this.staleReservedChars,
      invalidated: this.invalidated,
    };
  }

  /**
   * Drop every cached entry and zero every counter. Called by
   * `Agent.startNewSession()` so a session boundary is also a dedup-cache
   * boundary — without it, a brand-new session's dedup stats (logged tagged
   * with the NEW session id) would carry hits/reserves/content accumulated by
   * an unrelated PRIOR session sharing the same long-lived Agent instance,
   * which corrupts the per-session cost-leak attribution this class exists to
   * make falsifiable (see message-processor.ts's `dedup` interaction log).
   * Also used directly by tests.
   */
  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.inserts = 0;
    this.sameTurnReserves = 0;
    this.sameTurnReservedChars = 0;
    this.staleReserves = 0;
    this.staleReservedChars = 0;
    this.invalidated = 0;
    this.currentTurn = 0;
  }

  /**
   * A compaction layer reports tool results it removed from the model's view.
   * Any entry anchored to one of them is dropped, so the next identical call is
   * a plain miss — served in full and re-anchored to a copy the model can see.
   *
   * Required for the in-loop `prepareStep` compactor (`compactSubAgentMessages`):
   * it rewrites tool-result outputs into stubs for the wire only, and the AI SDK
   * hands tool execute() `stepInputMessages` — the array BEFORE that rewrite —
   * so no amount of scanning `ToolCallOptions.messages` can observe the loss.
   *
   * Idempotent: the compactor re-derives the same elision set every step.
   * Returns the number of entries dropped.
   */
  public noteElided(toolCallIds: Iterable<string>): number {
    if (!this.enabled) return 0;
    const ids = toIdSet(toolCallIds);
    if (ids.size === 0) return 0;
    let removed = 0;
    for (const [hash, entry] of this.cache) {
      if (entry.anchorToolCallId && ids.has(entry.anchorToolCallId)) {
        this.cache.delete(hash);
        removed += 1;
      }
    }
    this.invalidated += removed;
    return removed;
  }

  /**
   * Inspect a tool output. If identical content was seen earlier (in this
   * or a previous turn), returns a short stub string. Otherwise records
   * the content and returns null (caller passes through the original).
   *
   * `served` is the string that will actually reach the model if not stubbed.
   * `hashSource` (H5) is the identity to hash/cache on — pass the RAW pre-cap
   * content here so a downstream cap's non-deterministic trimming does not defeat
   * the hash; defaults to `served` when the two are the same (top-level path).
   *
   * `call` carries this call's `toolCallId` (the anchor recorded on insert) and
   * the message history the model was given. A cached entry whose anchor is
   * absent from that history is dropped instead of pointed at — see the
   * pointer-reachability invariant in the module header.
   */
  public maybeDedup(toolName: string, served: string, hashSource?: string, call?: DedupCallContext): string | null {
    if (!this.enabled) return null;
    const identity = hashSource ?? served;
    // Gate on the identity length (the real content), not the possibly-trimmed
    // served string — a capped output can fall under minChars while its raw
    // source is large and worth deduping.
    if (identity.length < this.minChars) return null;
    const hash = shortHash(identity);
    let existing = this.cache.get(hash);
    if (existing && anchorIsProvablyGone(existing.anchorToolCallId, call)) {
      // The payload this entry would name is not in the history the model
      // received, so a pointer at it would be unresolvable — the exact shape of
      // the measured nine-call loop. Drop the entry and fall through to the
      // insert path: the content is served in full and re-anchored below.
      this.cache.delete(hash);
      this.staleReserves += 1;
      this.staleReservedChars += served.length;
      existing = undefined;
    }
    if (existing) {
      // Refresh LRU position so frequently-reused outputs survive eviction.
      this.cache.delete(hash);
      this.cache.set(hash, existing);

      const thisTurn = this.currentTurn || 1;
      const sameTurnLoop = existing.firstSeenTurn === thisTurn;
      if (sameTurnLoop) {
        // O1/O2 fix — a re-call of identical content WITHIN the same turn is a
        // model loop, not genuine cross-turn reuse. A cheap model (kimi /
        // deepseek) that re-issues the same read usually did so because it did
        // NOT retain the earlier result; a bare "reuse" stub then triggers a
        // WORSE fallback — it re-reads each file singly, inflating fresh input
        // (measured: batch read → stub → stub → 4 single reads). Re-serve the
        // content ONCE (passthrough) to satisfy the loop, then hard-stop on any
        // further in-turn repeat so an infinite loop stays bounded.
        existing.sameTurnRepeats += 1;
        if (existing.sameTurnRepeats === 1) {
          // Deliberate re-serve (see comment above). Meter its cost so the
          // policy trade-off is visible and a future fix is falsifiable. Count
          // the SERVED length (what actually re-bills), not the raw identity.
          this.sameTurnReserves += 1;
          this.sameTurnReservedChars += served.length;
          // Re-point at the copy just served: it is the newest one in the
          // model's view and therefore the last to be compacted away.
          if (call?.toolCallId) existing.anchorToolCallId = call.toolCallId;
          return null;
        }
        this.hits += 1;
        return `[${existing.firstSeenToolName} already returned this EXACT result ${existing.sameTurnRepeats + 1}× this turn — it is unchanged and already in the context above. STOP re-calling it; answer from the result you already have.]`;
      }

      // Genuine cross-turn reuse (C3): the user prompted again and the agent
      // re-ran an identical read. The model is not looping, so the short stub
      // is the right, token-saving behavior.
      this.hits += 1;
      // G3 — short marker. Old format was ~110 chars; this is ~45. The anchor
      // id rides along (~18 chars) so a pointer that somehow outlives its
      // payload still names a handle `retrieve_tool_result` can resolve — a
      // backstop, not the fix: the anchor checks above are what keep the
      // pointer alive in the first place.
      const anchor = existing.anchorToolCallId ? ` id=${existing.anchorToolCallId}` : "";
      return `[dup of ${existing.firstSeenToolName} from turn ${existing.firstSeenTurn}${anchor} — reuse]`;
    }
    // Insert new entry, evicting oldest if over cap. Cache the raw identity so a
    // later capped re-read (different served bytes, same source) still matches.
    this.cache.set(hash, {
      content: identity,
      firstSeenTurn: this.currentTurn || 1,
      firstSeenToolName: toolName,
      anchorToolCallId: call?.toolCallId,
      sameTurnRepeats: 0,
    });
    this.inserts += 1;
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return null;
  }
}

/** Read env knob; default enabled. Set MUONROI_CROSS_TURN_DEDUP=0 to disable. */
export function isCrossTurnDedupEnabled(): boolean {
  const raw = process.env.MUONROI_CROSS_TURN_DEDUP;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Wrap a ToolSet so every tool's execute() output is hashed and
 * deduped via the shared CrossTurnDedup instance. The wrap is applied
 * AFTER any other compression (e.g. sub-agent cap): the cap sees the raw
 * output, and the dedup SERVES the already-compressed output but HASHES the
 * raw pre-cap content the cap stashed under RAW_FOR_DEDUP (H5) — so the cap's
 * non-deterministic trimming/markers can no longer defeat the hash. On the
 * top-level path (no cap) there is no Symbol and it hashes the served output
 * directly.
 *
 * If dedup is disabled (null instance or env=0), returns the original
 * tool set unchanged.
 */
export function wrapToolSetWithDedup(tools: ToolSet, dedup: CrossTurnDedup | null): ToolSet {
  if (!dedup) return tools;
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const t = tool as Record<string, unknown>;
    const innerExecute = t.execute as ((input: unknown, ctx?: unknown) => unknown) | undefined;
    if (!innerExecute) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...(tool as object),
      execute: async (input: unknown, ctx?: unknown) => {
        // F3 — see isGuardRejectableCall. A malformed call never ran, so there
        // is no prior result to "reuse"; its correction must reach the model
        // verbatim every time, however often the shape repeats. Only calls the
        // arg guard would block take this branch, so well-formed traffic is
        // deduped exactly as before.
        if (isGuardRejectableCall(tool, name, input)) return await innerExecute(input, ctx);
        const result = await innerExecute(input, ctx);
        return dedupResult(dedup, name, result, readCallContext(ctx));
      },
    } as ToolSet[string];
  }
  return wrapped;
}

function dedupResult(dedup: CrossTurnDedup, toolName: string, raw: unknown, call?: DedupCallContext): unknown {
  if (typeof raw === "string") {
    const stub = dedup.maybeDedup(toolName, raw, undefined, call);
    return stub ?? raw;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.output === "string") {
      // H5: if a sub-agent cap ran first, it stashed the RAW pre-cap output under
      // RAW_FOR_DEDUP — hash on that so the cap's non-deterministic trimming can't
      // defeat the match. The Symbol never serializes to the model wire.
      const hashSource = (obj as Record<string | symbol, unknown>)[RAW_FOR_DEDUP];
      const stub = dedup.maybeDedup(
        toolName,
        obj.output,
        typeof hashSource === "string" ? hashSource : undefined,
        call,
      );
      if (stub !== null) return { ...obj, output: stub };
    }
    // MCP tool result shape: { type: "content", value: [{type:"text", text}, ...] }.
    // Without this branch a re-fetched MCP payload (same docs page, same query)
    // re-billed full content every turn — the dedup never saw it. Dedup each
    // text part; non-text parts (images/media) pass through untouched.
    if (obj.type === "content" && Array.isArray(obj.value)) {
      const value = obj.value.map((part) => {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          const text = (part as { text: string }).text;
          const stub = dedup.maybeDedup(toolName, text, undefined, call);
          if (stub !== null) return { ...(part as object), text: stub };
        }
        return part;
      });
      return { ...obj, value };
    }
  }
  return raw;
}
