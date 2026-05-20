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

function isReadTool(name: string): boolean {
  return READ_TOOL_PATTERN.test(name);
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
}

export class ReadPathBudget {
  private counts = new Map<string, number>();
  private capExceededHits = 0;
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

  public getStats(): ReadBudgetStats {
    return { capExceededHits: this.capExceededHits, trackedPaths: this.counts.size };
  }

  /** Test-only. */
  public clear(): void {
    this.counts.clear();
    this.capExceededHits = 0;
  }
}

export function getReadPathBudgetCap(): number {
  const raw = process.env.MUONROI_MAX_READS_PER_PATH;
  if (raw === undefined || raw === "") return 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.floor(n);
}

/**
 * Wrap a ToolSet so read-tool execute() calls are short-circuited once a
 * per-path cap is exceeded. Non-read tools pass through unchanged. Stub
 * matches the format the LLM already sees from cross-turn dedup so the
 * model interprets it consistently.
 */
export function wrapToolSetWithReadBudget(tools: ToolSet, budget: ReadPathBudget | null): ToolSet {
  if (!budget) return tools;
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isReadTool(name)) {
      wrapped[name] = tool;
      continue;
    }
    const t = tool as Record<string, unknown>;
    const innerExecute = t.execute as ((input: unknown, ctx?: unknown) => unknown) | undefined;
    if (!innerExecute) {
      wrapped[name] = tool;
      continue;
    }
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
  }
  return wrapped;
}

export const _internals = { isReadTool, extractPath, normalizePath };
