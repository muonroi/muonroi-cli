/**
 * src/tools/bash-output-cache.ts
 *
 * In-memory cache of full (ANSI-stripped, untruncated) stdout+stderr from
 * foreground bash runs, keyed by a per-process monotonic `runId`. Backs the
 * `bash_output_get` tool (Fix #2) so the agent can re-query a captured run
 * with different head/tail/grep slices instead of re-running the command
 * with cosmetic flag changes — the loop pattern observed in session
 * `9b56560aeeb6` where the agent ran `bunx vitest run` 18 times.
 *
 * The cache lives in module scope (process singleton) — a session-scoped
 * cache would complicate the BashTool API for negligible gain (entries
 * naturally roll out via the LRU cap). Functions here are pure aside from
 * the module-scoped Map; safe to unit-test by `clearBashOutputCache()`
 * between cases.
 */

const MAX_ENTRIES = 50;

export interface BashRunRecord {
  /** Stable run id, e.g. "bash-42". */
  id: string;
  /** The original command as passed to BashTool.execute. */
  command: string;
  /** Full stdout (ANSI-stripped). May be empty. */
  stdout: string;
  /** Full stderr (ANSI-stripped). May be empty. */
  stderr: string;
  /** Exit code if known, else null. */
  exitCode: number | null;
  /** ISO timestamp when execute() returned. */
  completedAt: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

// LRU via insertion order. Map preserves insertion order; on access we
// re-insert to bump the entry to the freshest position.
const cache: Map<string, BashRunRecord> = new Map();
let nextId = 1;

export function nextBashRunId(): string {
  return `bash-${nextId++}`;
}

export function recordBashRun(record: Omit<BashRunRecord, "completedAt"> & { completedAt?: string }): void {
  const entry: BashRunRecord = {
    ...record,
    completedAt: record.completedAt ?? new Date().toISOString(),
  };
  cache.delete(record.id); // ensure insertion-order bump
  cache.set(record.id, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getBashRun(id: string): BashRunRecord | null {
  const r = cache.get(id);
  if (!r) return null;
  // Touch to bump in LRU order.
  cache.delete(id);
  cache.set(id, r);
  return r;
}

export function listBashRunIds(): string[] {
  return [...cache.keys()];
}

export function clearBashOutputCache(): void {
  cache.clear();
  nextId = 1;
}

// ---------------------------------------------------------------------------
// ANSI strip — matches the standard ECMA-48 CSI sequences plus the OSC and
// single-character escapes vitest / bun emit even when FORCE_COLOR=0. Copied
// out of strip-ansi (MIT, sindresorhus) to avoid pulling a runtime dep.
// ---------------------------------------------------------------------------

const ANSI_PATTERN = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z0-9/#&.:=?%@~_]+)*|[a-zA-Z0-9]+(?:;[-a-zA-Z0-9/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join("|"),
  "g",
);

export function stripAnsi(text: string): string {
  if (!text) return text;
  return text.replace(ANSI_PATTERN, "");
}

// ---------------------------------------------------------------------------
// Slicing primitives for bash_output_get.
// ---------------------------------------------------------------------------

export type BashSliceMode = "tail" | "head" | "grep" | "lines" | "full";

export interface BashSliceInput {
  mode: BashSliceMode;
  /** Number of lines for head/tail. Defaults to 50. */
  lines?: number;
  /** Regex pattern for grep mode. */
  pattern?: string;
  /** Line range "N-M" (1-based inclusive) for lines mode. */
  range?: string;
  /** Case-insensitive grep. Default false. */
  caseInsensitive?: boolean;
}

export interface BashSliceResult {
  ok: boolean;
  text: string;
  matchedLines?: number;
  totalLines: number;
}

export function sliceBashOutput(record: BashRunRecord, input: BashSliceInput): BashSliceResult {
  const merged = record.stderr ? `${record.stdout}\n[stderr]\n${record.stderr}` : record.stdout;
  const allLines = merged.length === 0 ? [] : merged.split("\n");
  const total = allLines.length;
  const lines = input.lines ?? 50;
  switch (input.mode) {
    case "full":
      return { ok: true, text: merged, totalLines: total };
    case "head":
      return { ok: true, text: allLines.slice(0, Math.max(1, lines)).join("\n"), totalLines: total };
    case "tail":
      return { ok: true, text: allLines.slice(-Math.max(1, lines)).join("\n"), totalLines: total };
    case "lines": {
      const m = (input.range ?? "").match(/^(\d+)\s*-\s*(\d+)$/);
      if (!m) return { ok: false, text: "Invalid range — expected 'N-M' (1-based)", totalLines: total };
      const start = Math.max(1, Number(m[1]));
      const end = Math.min(total, Number(m[2]));
      if (start > end) return { ok: false, text: `Empty range (start ${start} > end ${end})`, totalLines: total };
      return { ok: true, text: allLines.slice(start - 1, end).join("\n"), totalLines: total };
    }
    case "grep": {
      if (!input.pattern) return { ok: false, text: "Missing pattern for grep mode", totalLines: total };
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, input.caseInsensitive ? "i" : "");
      } catch (err) {
        return { ok: false, text: `Invalid regex: ${(err as Error).message}`, totalLines: total };
      }
      const matched = allLines.filter((l) => re.test(l));
      return { ok: true, text: matched.join("\n"), matchedLines: matched.length, totalLines: total };
    }
    default:
      return { ok: false, text: `Unknown mode: ${input.mode}`, totalLines: total };
  }
}
