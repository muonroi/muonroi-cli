/**
 * src/ee/mistake-detector.ts
 *
 * P0 native observation — detect agent mistakes from observable BEHAVIOR
 * (NOT lexical patterns or agent self-report). Emits posttool payloads with
 * `outcome.mistakeKind` and structured `evidence` so the brain only learns
 * from unfakeable signals.
 *
 * Three detectors:
 *
 *   1. file-revert  — user-driven turn re-edits a file the agent just edited
 *                     in the prior batch (with warnings). Strong signal that
 *                     the agent's edit was rejected — language-agnostic.
 *
 *   2. abort        — user interrupted the agent mid-batch (AbortSignal)
 *                     while warnings were active. Strong signal that the
 *                     in-flight work was unwanted.
 *
 *   3. retry-pattern — same toolName + similar toolInput within last 3 turns,
 *                     where the first attempt failed and the second succeeded.
 *                     Signals "warning should have fired earlier".
 *
 * No regex over user prose. No language packs. All signals come from the
 * agent's tool stream and the runtime's own abort plumbing.
 */

import type { MistakeKind } from "./types.js";

const RING_SIZE = 5;
const RETRY_LOOKBACK_TURNS = 3;
const RETRY_SIMILARITY_THRESHOLD = 0.7;

/** Tool names that mutate file contents. Includes built-ins + MCP variants + lowercase. */
const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "edit",
  "write",
  "edit_file",
  "write_file",
  "mcp__filesystem__write_file",
  "mcp__filesystem__edit_file",
  "NotebookEdit",
]);

export interface RingEntry {
  toolName: string;
  toolInput: unknown;
  timestamp: number;
  success?: boolean;
  hadWarnings: boolean;
  /** Cached JSON token set for cheap similarity comparison. */
  tokens: Set<string>;
  /** Resolved file path for edit-class tools (null otherwise). */
  filePath: string | null;
}

export interface MistakeEvent {
  kind: MistakeKind;
  toolName: string;
  toolInput: unknown;
  evidence: Record<string, unknown>;
}

/**
 * Tool-call ring buffer + batch tracking. Per-process singleton owned by the
 * hook layer.
 */
export class MistakeDetector {
  private buffer: RingEntry[] = [];
  /** Tools that fired in the most recent contiguous batch — reset on each user turn. */
  private currentBatch: RingEntry[] = [];
  /** Snapshot of the previous batch (captured by resetBatch). Used by detectFileRevert. */
  private priorBatch: RingEntry[] = [];

  /** Append a tool call (called from PreToolUse path with hadWarnings flag). */
  recordPreTool(toolName: string, toolInput: unknown, hadWarnings: boolean): RingEntry {
    const entry: RingEntry = {
      toolName,
      toolInput,
      timestamp: Date.now(),
      hadWarnings,
      tokens: tokenize(toolInput),
      filePath: extractFilePath(toolName, toolInput),
    };
    this.buffer.push(entry);
    if (this.buffer.length > RING_SIZE) this.buffer.shift();
    this.currentBatch.push(entry);
    return entry;
  }

  /** Mark the most recent entry as completed (called from PostToolUse path). */
  recordPostTool(toolName: string, success: boolean): RingEntry | null {
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

    const start = Math.max(0, this.buffer.length - 1 - RETRY_LOOKBACK_TURNS);
    for (let i = this.buffer.length - 2; i >= start; i--) {
      const prior = this.buffer[i]!;
      if (prior.toolName !== latest.toolName) continue;
      if (prior.success !== false) continue;
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
   * File-revert detection — behavior-based veto signal.
   *
   * If the incoming Edit/Write call targets a file that the agent already
   * edited in the PRIOR batch (and that prior edit had warnings), treat it
   * as the user re-touching the same file to undo or rework what we just
   * did. Emits one veto event per matching prior-batch entry.
   *
   * Call this from the PreToolUse path AFTER recordPreTool, because we need
   * the resolved filePath of the new entry.
   *
   * Gate: at least one prior-batch entry on the same file must have had
   * warnings — generic re-edits during normal iteration shouldn't fire.
   */
  detectFileRevert(toolName: string, toolInput: unknown): MistakeEvent[] {
    if (!isEditTool(toolName)) return [];
    const path = extractFilePath(toolName, toolInput);
    if (!path) return [];
    if (this.priorBatch.length === 0) return [];

    const matches = this.priorBatch.filter(
      (e) => isEditTool(e.toolName) && e.filePath === path && e.hadWarnings,
    );
    if (matches.length === 0) return [];

    return matches.map<MistakeEvent>((e) => ({
      kind: "user-veto",
      toolName: e.toolName,
      toolInput: e.toolInput,
      evidence: {
        signal: "file-revert",
        filePath: path,
        priorEditTimestamp: e.timestamp,
        priorEditSucceeded: e.success ?? null,
        nextEditTool: toolName,
      },
    }));
  }

  /**
   * Abort detection — behavior-based veto signal.
   *
   * Called when the runtime detects the user aborted the in-flight turn.
   * Emits one veto event per current-batch entry that had warnings. Tools
   * without warnings are skipped (an unrelated abort shouldn't poison the
   * brain about them).
   */
  detectAbort(reason?: string): MistakeEvent[] {
    if (this.currentBatch.length === 0) return [];
    const flagged = this.currentBatch.filter((e) => e.hadWarnings);
    if (flagged.length === 0) return [];
    return flagged.map<MistakeEvent>((e) => ({
      kind: "user-veto",
      toolName: e.toolName,
      toolInput: e.toolInput,
      evidence: {
        signal: "abort",
        ...(reason ? { reason } : {}),
        toolSucceeded: e.success ?? null,
      },
    }));
  }

  /**
   * Reset the active batch — call at the start of every user turn.
   * Captures the prior batch so file-revert detection has something to
   * compare against on the first tool of the new turn.
   */
  resetBatch(): void {
    this.priorBatch = this.currentBatch;
    this.currentBatch = [];
  }

  /** For tests + introspection. */
  snapshot(): { ring: RingEntry[]; batch: RingEntry[]; priorBatch: RingEntry[] } {
    return {
      ring: this.buffer.map((e) => ({ ...e, tokens: new Set(e.tokens) })),
      batch: this.currentBatch.map((e) => ({ ...e, tokens: new Set(e.tokens) })),
      priorBatch: this.priorBatch.map((e) => ({ ...e, tokens: new Set(e.tokens) })),
    };
  }

  /** Clear all state. Test-only. */
  reset(): void {
    this.buffer = [];
    this.currentBatch = [];
    this.priorBatch = [];
  }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

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

function isEditTool(toolName: string): boolean {
  return EDIT_TOOL_NAMES.has(toolName);
}

/**
 * Resolve the file path argument for an edit-class tool. Returns null when
 * the tool is not an edit tool or the input shape is unexpected.
 */
function extractFilePath(toolName: string, toolInput: unknown): string | null {
  if (!isEditTool(toolName)) return null;
  if (!toolInput || typeof toolInput !== "object") return null;
  const obj = toolInput as Record<string, unknown>;
  const candidate = obj.file_path ?? obj.filePath ?? obj.path ?? obj.notebook_path;
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  return normalizePath(candidate);
}

/**
 * Normalize a path for cross-tool equality comparison: trim, lowercase the
 * Windows drive letter, swap backslashes to forward slashes. We do NOT
 * resolve symlinks or canonicalize against cwd — false negatives on relative
 * vs. absolute paths are acceptable; false positives are not.
 */
function normalizePath(p: string): string {
  let out = p.trim().replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(out)) {
    out = out[0]!.toLowerCase() + out.slice(1);
  }
  return out;
}

function tokenize(input: unknown): Set<string> {
  let json: string;
  try {
    json = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    json = String(input);
  }
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
export const _internals = { tokenize, jaccardSimilarity, extractFilePath, isEditTool, normalizePath };
