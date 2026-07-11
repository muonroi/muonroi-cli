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
 */

import { createHash } from "node:crypto";
import type { ToolSet } from "ai";

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MIN_CHARS = 500;

export interface CrossTurnDedupEntry {
  /** Full content of the first occurrence. Kept for potential future retrieval; not currently re-emitted. */
  content: string;
  /** 1-indexed turn number when this content was first observed. */
  firstSeenTurn: number;
  /** Tool name that originally produced the content (for the stub). */
  firstSeenToolName: string;
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
    return { hits: this.hits, size: this.cache.size, inserts: this.inserts };
  }

  /** Test-only / reset helper. */
  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.inserts = 0;
    this.currentTurn = 0;
  }

  /**
   * Inspect a tool output. If identical content was seen earlier (in this
   * or a previous turn), returns a short stub string. Otherwise records
   * the content and returns null (caller passes through the original).
   */
  public maybeDedup(toolName: string, raw: string): string | null {
    if (!this.enabled) return null;
    if (raw.length < this.minChars) return null;
    const hash = shortHash(raw);
    const existing = this.cache.get(hash);
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
        if (existing.sameTurnRepeats === 1) return null;
        this.hits += 1;
        return `[${existing.firstSeenToolName} already returned this EXACT result ${existing.sameTurnRepeats + 1}× this turn — it is unchanged and already in the context above. STOP re-calling it; answer from the result you already have.]`;
      }

      // Genuine cross-turn reuse (C3): the user prompted again and the agent
      // re-ran an identical read. The model is not looping, so the short stub
      // is the right, token-saving behavior.
      this.hits += 1;
      // G3 — short marker. Old format was ~110 chars; this is ~45.
      return `[dup of ${existing.firstSeenToolName} from turn ${existing.firstSeenTurn} — reuse]`;
    }
    // Insert new entry, evicting oldest if over cap.
    this.cache.set(hash, {
      content: raw,
      firstSeenTurn: this.currentTurn || 1,
      firstSeenToolName: toolName,
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
 * AFTER any other compression (e.g. sub-agent cap), so the cap sees
 * the raw output and the dedup sees the already-compressed output —
 * keeping the dedup keyed on what actually reaches the model.
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
        const result = await innerExecute(input, ctx);
        return dedupResult(dedup, name, result);
      },
    } as ToolSet[string];
  }
  return wrapped;
}

function dedupResult(dedup: CrossTurnDedup, toolName: string, raw: unknown): unknown {
  if (typeof raw === "string") {
    const stub = dedup.maybeDedup(toolName, raw);
    return stub ?? raw;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.output === "string") {
      const stub = dedup.maybeDedup(toolName, obj.output);
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
          const stub = dedup.maybeDedup(toolName, text);
          if (stub !== null) return { ...(part as object), text: stub };
        }
        return part;
      });
      return { ...obj, value };
    }
  }
  return raw;
}
