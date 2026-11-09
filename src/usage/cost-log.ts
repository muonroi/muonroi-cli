/**
 * src/usage/cost-log.ts
 *
 * Lightweight, append-only JSONL log of every LLM call across the CLI.
 * Complements the monthly ledger and per-product ledger by capturing calls
 * that don't have a productRunId (orchestrator, compaction, council, PIL, ...).
 *
 * Goal: answer "where did the cost grow?" by callsite / role / phase, even
 * for traffic that bypasses reserve/commit. Writes are best-effort — failures
 * never block the model call.
 *
 * Path: ~/.muonroi-cli/usage/cost-log.jsonl  (rotates daily by date suffix)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { muonroiHome } from "../utils/muonroi-home.js";
import { projectCostUSD, sanitizeInputTokens } from "./estimator.js";
import type { CostMeta } from "./product-ledger.js";

export interface CostLogEntry extends CostMeta {
  ts: number;
  provider: string;
  model: string;
  estimatedUsd: number;
  productRunId?: string;
  /**
   * Free-form chars/tokens breakdown per logical prompt component.
   * Keys: staticPrefix, dynamicSuffix, playwrightGuidance, pilSuffix,
   *       messages, tools, toolNames, etc. Used by orchestrator to
   *       attribute measured request size to its components.
   */
  breakdown?: Record<string, number>;
  /**
   * Set on every row a background worker process writes (see
   * {@link setCostLogAttribution}). Workers run with persistSession=false, so
   * the cost log is the ONLY record of their spend; without these tags
   * `usage flow-metrics` can attribute it to a session only by job time window.
   */
  parentSessionId?: string;
  delegationId?: string;
}

let attribution: { parentSessionId?: string; delegationId?: string } | null = null;

/**
 * Tag every subsequent cost-log row written by THIS process with the
 * delegation it is running. Called once by the background worker entry; the
 * main process never sets it (its spend is already in usage_events).
 */
export function setCostLogAttribution(tag: { parentSessionId?: string; delegationId?: string } | null): void {
  attribution = tag;
}

function resolveHome(homeOverride?: string): string {
  return homeOverride ?? muonroiHome();
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function logPath(homeOverride?: string): string {
  return path.join(resolveHome(homeOverride), "usage", `cost-log-${todayUtc()}.jsonl`);
}

/**
 * Append one entry. Best-effort: errors are swallowed so a logging fault
 * cannot break the calling LLM request.
 */
export async function appendCostLog(entry: CostLogEntry, homeOverride?: string): Promise<void> {
  try {
    const fp = logPath(homeOverride);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.appendFile(fp, `${JSON.stringify(attribution ? { ...attribution, ...entry } : entry)}\n`);
  } catch {
    // intentionally swallow — diagnostics must not break the hot path
  }
}

/**
 * Metered wrapper for any LLM call.
 *
 * Use this at every `generateText` / `streamText` / `llm.generate` site that
 * does NOT already go through the per-product ledger. It records:
 *   - estimated cost (cheap, from chars/4)
 *   - actual tokens IF the caller can supply them from `result.usage`
 *   - callsite/role/phase/iteration tags for groupable reports
 *
 * The wrapper does not enforce the cap — orchestrator/compaction paths run
 * outside reserve/commit by design (Phase G). It exists to MEASURE.
 */
export async function meteredGenerate<T>(
  args: {
    provider: string;
    model: string;
    systemChars: number;
    promptChars: number;
    estOutputTokens?: number;
    meta?: CostMeta;
    homeOverride?: string;
  },
  fn: () => Promise<{
    result: T;
    actualInputTokens?: number;
    actualOutputTokens?: number;
    cachedInputTokens?: number;
    stepCount?: number;
  }>,
): Promise<T> {
  const estIn = Math.ceil((args.systemChars + args.promptChars) / 4);
  const estOut = args.estOutputTokens ?? 2048;
  const startedAt = Date.now();
  try {
    const { result, actualInputTokens, actualOutputTokens, cachedInputTokens, stepCount } = await fn();
    const inTok = sanitizeInputTokens(actualInputTokens, estIn);
    const outTok = actualOutputTokens ?? Math.max(1, Math.ceil(estOut / 4));
    const usd = projectCostUSD(args.provider, args.model, inTok, outTok);
    await appendCostLog(
      {
        ts: startedAt,
        provider: args.provider,
        model: args.model,
        estimatedUsd: usd,
        systemChars: args.systemChars,
        promptChars: args.promptChars,
        estInputTokens: estIn,
        actualInputTokens,
        actualOutputTokens,
        cachedInputTokens,
        stepCount,
        durationMs: Date.now() - startedAt,
        ...args.meta,
      },
      args.homeOverride,
    );
    return result;
  } catch (err) {
    // Still record the attempt so retries/failures show up in the bloat report.
    await appendCostLog(
      {
        ts: startedAt,
        provider: args.provider,
        model: args.model,
        estimatedUsd: 0,
        systemChars: args.systemChars,
        promptChars: args.promptChars,
        estInputTokens: estIn,
        durationMs: Date.now() - startedAt,
        ...args.meta,
        callsite: `${args.meta?.callsite ?? "unknown"}:error`,
      },
      args.homeOverride,
    );
    throw err;
  }
}

/** Callsite of the summarizing compaction (`Orchestrator.compactForContext`). */
export const COMPACTION_CALLSITE = "orchestrator.compaction";
/** Pairing tolerance between the two legacy copies of one compaction. */
const COMPACTION_TWIN_TOLERANCE_MS = 15 * 60 * 1000;

/** The minimal row shape the compaction-twin rule reads. */
export interface CompactionTwinRow {
  ts: number;
  model: string;
  callsite?: string;
  iteration?: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Legacy duplicate: until the compaction path became the single writer, every
 * compaction was appended twice — once by `recordUsage(…, "compaction")`
 * (callsite `orchestrator.compaction`, NO `iteration`, ts = write time) and
 * once by `compactForContext` itself (callsite `orchestrator.compaction` or
 * `orchestrator.compaction.rejected`, WITH `iteration`/`durationMs`, ts = call
 * start). Measured: 186 compaction rows for 93 compactions over 2026-11-02..04.
 *
 * `dup` is the recordUsage copy, `authoritative` the compaction path's own row.
 * Requiring the `iteration` asymmetry means two genuinely separate single-row
 * compactions with identical token counts are never collapsed.
 */
export function isCompactionTwin(dup: CompactionTwinRow, authoritative: CompactionTwinRow): boolean {
  return (
    dup.callsite === COMPACTION_CALLSITE &&
    dup.iteration === undefined &&
    typeof authoritative.callsite === "string" &&
    authoritative.callsite.startsWith(COMPACTION_CALLSITE) &&
    authoritative.iteration !== undefined &&
    dup.model === authoritative.model &&
    dup.inputTokens === authoritative.inputTokens &&
    dup.outputTokens === authoritative.outputTokens &&
    Math.abs(dup.ts - authoritative.ts) <= COMPACTION_TWIN_TOLERANCE_MS
  );
}

/**
 * Drop the legacy recordUsage copy of each double-logged compaction, keeping
 * the compaction path's own row (provider, iteration, duration). Rows written
 * after the fix are single and pass through untouched. Order is preserved.
 */
export function collapseDoubleLoggedCompactions<T>(rows: readonly T[], view: (row: T) => CompactionTwinRow): T[] {
  const views = rows.map(view);
  const authoritative = views
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.iteration !== undefined && row.callsite?.startsWith(COMPACTION_CALLSITE));
  const claimed = new Set<number>();
  const drop = new Set<number>();
  views.forEach((row, index) => {
    if (row.callsite !== COMPACTION_CALLSITE || row.iteration !== undefined) return;
    let best = -1;
    for (const a of authoritative) {
      if (claimed.has(a.index) || !isCompactionTwin(row, a.row)) continue;
      if (best < 0 || Math.abs(a.row.ts - row.ts) < Math.abs(views[best]!.ts - row.ts)) best = a.index;
    }
    if (best >= 0) {
      claimed.add(best);
      drop.add(index);
    }
  });
  return rows.filter((_, index) => !drop.has(index));
}

/** Twin view of a raw cost-log entry. */
export function costLogTwinView(e: CostLogEntry): CompactionTwinRow {
  return {
    ts: e.ts,
    model: e.model,
    callsite: e.callsite,
    iteration: e.iteration,
    inputTokens: e.actualInputTokens ?? 0,
    outputTokens: e.actualOutputTokens ?? 0,
  };
}

/**
 * Read all cost-log entries for the given UTC date (default = today).
 * Returns empty array if the file does not exist. Legacy double-logged
 * compactions are collapsed to one row (see collapseDoubleLoggedCompactions),
 * so `usage report --by callsite` counts each compaction once.
 */
export async function readCostLog(date?: string, homeOverride?: string): Promise<CostLogEntry[]> {
  const day = date ?? todayUtc();
  const fp = path.join(resolveHome(homeOverride), "usage", `cost-log-${day}.jsonl`);
  try {
    const content = await fs.readFile(fp, "utf-8");
    const entries = content
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as CostLogEntry);
    return collapseDoubleLoggedCompactions(entries, costLogTwinView);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
