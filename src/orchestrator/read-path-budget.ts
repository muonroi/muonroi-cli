/**
 * src/orchestrator/read-path-budget.ts
 *
 * Phase C4 — input-keyed read budget. Complements the C3 cross-turn output-hash
 * dedup, which misses re-reads of files the agent itself just edited: file
 * content changes → output hash changes → cache miss → full re-bill.
 *
 * Caps `read_file` style tool calls at N per (toolName, normalizedPath) per
 * session. When the cap is exceeded, the wrapped execute() returns a stub
 * pointing the agent at its prior result instead of actually reading.
 *
 * Evidence: chat-export-bcf1f0951567 — client/vite.config.ts, index.html,
 * main.tsx each read 2× across edit turns; C3 missed because file bytes
 * changed between reads.
 *
 * Default cap N = 3 — generous enough that legitimate "edit → verify"
 * patterns still get a fresh read once, but tight enough to break runaway
 * re-read loops. Override via MUONROI_MAX_READS_PER_PATH; disable with 0.
 */
import type { ToolSet } from "ai";

// Matches built-in read tools + common MCP read tools (filesystem read_file,
// read_text_file, etc). We don't include "ls" / "list_directory" because
// those legitimately re-issue against a changing FS state.
const READ_TOOL_PATTERN = /(^|_|__)read(_file|_text_file)?$/i;

// Matches built-in write/edit tools + common MCP equivalents. These do NOT
// get a budget cap of their own (the cumulative tool budget covers them);
// instead a successful write/edit invalidates the read counter for the same
// path so the agent can refresh its view of the post-write content. Without
// this, an Edit on F.ts → agent re-reads F.ts → cap-blocked even though the
// content changed under it (evidenced by session 1f29e238a816 where biome
// reformatted a freshly-edited file and the next Read hit the budget cap).
const WRITE_TOOL_PATTERN = /(^|_|__)(write_file|edit_file|create_file|notebook_edit|str_replace_editor)$/i;

function isReadTool(name: string): boolean {
  return READ_TOOL_PATTERN.test(name);
}

function isWriteTool(name: string): boolean {
  return WRITE_TOOL_PATTERN.test(name);
}

/**
 * Extract the file path argument from a read-tool input shape. Handles the
 * common shapes: { path: "..." }, { file_path: "..." }, { filePath: "..." }.
 */
function extractPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const candidates = ["path", "file_path", "filePath", "filepath"];
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Normalize a path for budget keying: lowercase + forward slashes + trim. */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").toLowerCase();
}

export interface ReadBudgetStats {
  capExceededHits: number;
  trackedPaths: number;
  writeInvalidations: number;
}

export class ReadPathBudget {
  private counts = new Map<string, number>();
  private capExceededHits = 0;
  private writeInvalidations = 0;
  constructor(private readonly cap: number) {}

  /** Returns null if under cap (caller passes through); stub string if over. */
  public checkAndIncrement(toolName: string, path: string): string | null {
    if (this.cap <= 0) return null;
    const key = `${toolName}::${normalizePath(path)}`;
    const prior = this.counts.get(key) ?? 0;
    if (prior >= this.cap) {
      this.capExceededHits += 1;
      return `[read budget exceeded for ${path}: ${prior} prior reads this session; refer to your earlier result instead of re-reading. To override set MUONROI_MAX_READS_PER_PATH higher or 0 to disable.]`;
    }
    this.counts.set(key, prior + 1);
    return null;
  }

  /**
   * Reset every read counter pointing at `path` (across all toolName keys).
   * Called after a successful write/edit so the agent can re-read the
   * post-write content without immediately tripping the cap. Without this,
   * external rewriters (lint-staged biome, formatters) that mutate the file
   * between agent edits leave the read-counter "primed" and block recovery
   * reads. Evidence: session 1f29e238a816, cost-leak-tui-helpers.ts edits
   * → biome reformatted → next read hit cap → agent could not refresh.
   */
  public notifyWrite(path: string): void {
    if (this.cap <= 0) return;
    const normalized = normalizePath(path);
    let removed = 0;
    for (const key of Array.from(this.counts.keys())) {
      // Key shape: `${toolName}::${normalizedPath}` — strip the prefix and
      // compare the path portion. Read-tool name varies (read_file,
      // mcp__filesystem__read_text_file, etc.) so we can't pre-compute the
      // key.
      const sepIdx = key.indexOf("::");
      if (sepIdx === -1) continue;
      const keyPath = key.slice(sepIdx + 2);
      if (keyPath === normalized) {
        this.counts.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.writeInvalidations += removed;
  }

  public getStats(): ReadBudgetStats {
    return {
      capExceededHits: this.capExceededHits,
      trackedPaths: this.counts.size,
      writeInvalidations: this.writeInvalidations,
    };
  }

  /** Test-only. */
  public clear(): void {
    this.counts.clear();
    this.capExceededHits = 0;
    this.writeInvalidations = 0;
  }
}

export function getReadPathBudgetCap(): number {
  const raw = process.env.MUONROI_MAX_READS_PER_PATH;
  // Default 0 = disabled. Agent knows when it needs to re-read and should
  // not be blocked mid-analysis by a per-path cap. Override via env to
  // re-enable (e.g. MUONROI_MAX_READS_PER_PATH=3).
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.floor(n);
}

/**
 * Wrap a ToolSet so:
 *   - read-tool execute() calls are short-circuited once a per-path cap is
 *     exceeded
 *   - write/edit-tool execute() calls invalidate the read counter for the
 *     same path AFTER a successful invocation, so the agent can refresh its
 *     view of post-write content without tripping the cap
 *
 * Tools that are neither read nor write pass through unchanged. Stub
 * matches the format the LLM already sees from cross-turn dedup so the
 * model interprets it consistently.
 */
export function wrapToolSetWithReadBudget(tools: ToolSet, budget: ReadPathBudget | null): ToolSet {
  if (!budget) return tools;
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const reading = isReadTool(name);
    const writing = isWriteTool(name);
    if (!reading && !writing) {
      wrapped[name] = tool;
      continue;
    }
    const t = tool as Record<string, unknown>;
    const innerExecute = t.execute as ((input: unknown, ctx?: unknown) => unknown) | undefined;
    if (!innerExecute) {
      wrapped[name] = tool;
      continue;
    }
    if (reading) {
      wrapped[name] = {
        ...(tool as object),
        execute: async (input: unknown, ctx?: unknown) => {
          const path = extractPath(input);
          if (path) {
            const stub = budget.checkAndIncrement(name, path);
            if (stub !== null) return stub;
          }
          return innerExecute(input, ctx);
        },
      } as ToolSet[string];
    } else {
      wrapped[name] = {
        ...(tool as object),
        execute: async (input: unknown, ctx?: unknown) => {
          const path = extractPath(input);
          const result = await innerExecute(input, ctx);
          // Only invalidate on apparent success — i.e. the wrapped tool did
          // not throw. We can't easily inspect the result shape (tools return
          // formatted strings here, not structured objects) so we trust that
          // a non-throwing call wrote something. False positives are cheap
          // (a free re-read), false negatives are not (the bug we're fixing).
          if (path) budget.notifyWrite(path);
          return result;
        },
      } as ToolSet[string];
    }
  }
  return wrapped;
}

export const _internals = { isReadTool, isWriteTool, extractPath, normalizePath };
