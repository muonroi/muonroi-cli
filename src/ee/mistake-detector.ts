/**
 * src/ee/mistake-detector.ts
 *
 * P0 native observation — detect agent mistakes from observable signals
 * (NOT agent self-report). Emits posttool payloads with `outcome.mistakeKind`
 * and structured `evidence` so the brain can learn from unfakeable data.
 *
 * Two detectors:
 *
 *   1. user-veto    — next user turn matches a veto regex AND the previous
 *                     tool batch surfaced warnings or recently fired matches.
 *                     This is the highest-quality oracle (the user).
 *
 *   2. retry-pattern — same toolName + similar toolInput within last 3 turns,
 *                     where the first attempt failed and the second succeeded.
 *                     Signals "warning should have fired earlier".
 *
 * Both detectors observe behavior, never ask the agent. Outputs are passed
 * to posttool() so the existing fire-and-forget plumbing (B-4 invariant)
 * stays intact.
 */

import type { MistakeKind } from "./types.js";

const RING_SIZE = 5;
const RETRY_LOOKBACK_TURNS = 3;
const RETRY_SIMILARITY_THRESHOLD = 0.7;

/** User-veto regex: short, high-precision phrases. Lowercased before matching. */
const VETO_REGEX =
  /\b(no|wrong|sai|undo|revert|that broke|why did|don[' ]?t do|stop|that(?:'s)? not what|không|nhầm|hỏng|lỗi rồi)\b/i;

export interface RingEntry {
  toolName: string;
  toolInput: unknown;
  timestamp: number;
  success?: boolean;
  hadWarnings: boolean;
  /** Cached JSON token set for cheap similarity comparison. */
  tokens: Set<string>;
}

export interface MistakeEvent {
  kind: MistakeKind;
  toolName: string;
  toolInput: unknown;
  evidence: Record<string, unknown>;
}

/**
 * Tool-call ring buffer. Per-process singleton owned by the hook layer.
 * Each entry corresponds to one PreToolUse → PostToolUse pair.
 */
export class MistakeDetector {
  private buffer: RingEntry[] = [];
  /** Tools that fired in the most recent contiguous batch — reset on each user turn. */
  private currentBatch: RingEntry[] = [];

  /** Append a tool call (called from PreToolUse path with hadWarnings flag). */
  recordPreTool(toolName: string, toolInput: unknown, hadWarnings: boolean): RingEntry {
    const entry: RingEntry = {
      toolName,
      toolInput,
      timestamp: Date.now(),
      hadWarnings,
      tokens: tokenize(toolInput),
    };
    this.buffer.push(entry);
    if (this.buffer.length > RING_SIZE) this.buffer.shift();
    this.currentBatch.push(entry);
    return entry;
  }

  /** Mark the most recent entry as completed (called from PostToolUse path). */
  recordPostTool(toolName: string, success: boolean): RingEntry | null {
    // Walk backwards — most recent matching toolName without success set yet.
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const e = this.buffer[i]!;
      if (e.toolName === toolName && e.success === undefined) {
        e.success = success;
        return e;
      }
    }
    return null;
  }

  /**
   * Inspect the latest entry for a retry-pattern.
   * Returns a mistake event when a prior failed attempt of the same tool with
   * similar input was followed by a success here.
   */
  detectRetryPattern(): MistakeEvent | null {
    if (this.buffer.length < 2) return null;
    const latest = this.buffer[this.buffer.length - 1]!;
    if (latest.success !== true) return null;

    // Look back up to RETRY_LOOKBACK_TURNS entries (excluding latest).
    const start = Math.max(0, this.buffer.length - 1 - RETRY_LOOKBACK_TURNS);
    for (let i = this.buffer.length - 2; i >= start; i--) {
      const prior = this.buffer[i]!;
      if (prior.toolName !== latest.toolName) continue;
      if (prior.success !== false) continue; // only count first-failed → success patterns
      const sim = jaccardSimilarity(prior.tokens, latest.tokens);
      if (sim >= RETRY_SIMILARITY_THRESHOLD) {
        return {
          kind: "retry-pattern",
          toolName: latest.toolName,
          toolInput: latest.toolInput,
          evidence: {
            similarity: Number(sim.toFixed(3)),
            firstAttemptToolInput: prior.toolInput,
            firstAttemptHadWarnings: prior.hadWarnings,
            turnsSincePrior: this.buffer.length - 1 - i,
          },
        };
      }
    }
    return null;
  }

  /**
   * Examine an incoming user message for a veto signal directed at the
   * previous tool batch. Returns one event per tool in the batch when a veto
   * is detected; returns [] otherwise.
   *
   * Gate: at least one tool in the batch must have had warnings or matches —
   * generic "no" replies that aren't tied to a recent surfaced suggestion
   * become noise if we fire on them.
   */
  detectUserVeto(userMessage: string): MistakeEvent[] {
    if (!userMessage || this.currentBatch.length === 0) return [];
    if (!VETO_REGEX.test(userMessage)) return [];
    const batch = this.currentBatch;
    const anyHadWarnings = batch.some((e) => e.hadWarnings);
    if (!anyHadWarnings) return [];

    const excerpt = userMessage.slice(0, 200);
    return batch.map<MistakeEvent>((e) => ({
      kind: "user-veto",
      toolName: e.toolName,
      toolInput: e.toolInput,
      evidence: {
        userMessageExcerpt: excerpt,
        hadWarnings: e.hadWarnings,
        toolSucceeded: e.success ?? null,
      },
    }));
  }

  /** Reset the active batch — call at the start of every user turn. */
  resetBatch(): void {
    this.currentBatch = [];
  }

  /** For tests + introspection. */
  snapshot(): { ring: RingEntry[]; batch: RingEntry[] } {
    return {
      ring: this.buffer.map((e) => ({ ...e, tokens: new Set(e.tokens) })),
      batch: this.currentBatch.map((e) => ({ ...e, tokens: new Set(e.tokens) })),
    };
  }

  /** Clear all state. Test-only. */
  reset(): void {
    this.buffer = [];
    this.currentBatch = [];
  }
}

// ─── Module-level singleton (matches _cachedScope / _lastWarningResponse pattern in hooks) ───

let _detector: MistakeDetector | null = null;

export function getMistakeDetector(): MistakeDetector {
  if (!_detector) _detector = new MistakeDetector();
  return _detector;
}

/** Test-only helper. */
export function resetMistakeDetector(): void {
  _detector = null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Cheap content-aware tokenization for similarity comparison. We don't need
 * full Levenshtein on large strings — Jaccard over a coarse token set is
 * a good signal for "is this the same kind of call with similar args".
 */
function tokenize(input: unknown): Set<string> {
  let json: string;
  try {
    json = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    json = String(input);
  }
  // Lowercase, split on non-alphanumerics, drop ultra-short noise tokens.
  const tokens = json
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Exposed for tests. */
export const _internals = { tokenize, jaccardSimilarity, VETO_REGEX };
