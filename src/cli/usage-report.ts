/**
 * src/cli/usage-report.ts
 *
 * `muonroi-cli usage report` — group cost-log + product-ledger entries to
 * answer "where is the cost coming from". Bloat-finder, not billing.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CostLogEntry, readCostLog } from "../usage/cost-log.js";
import { projectCostUSD } from "../usage/estimator.js";
import { readProductLedger } from "../usage/product-ledger.js";

type GroupBy = "callsite" | "role" | "phase" | "model" | "provider";

interface Row {
  key: string;
  calls: number;
  usd: number;
  inTok: number;
  outTok: number;
  cachedTok: number;
  promptChars: number;
  durationMs: number;
  driftSum: number;
  driftSamples: number;
}

function muonroiHome(homeOverride?: string): string {
  return homeOverride ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

async function listCostLogDates(homeOverride?: string): Promise<string[]> {
  const dir = path.join(muonroiHome(homeOverride), "usage");
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.startsWith("cost-log-") && f.endsWith(".jsonl"))
      .map((f) => f.replace(/^cost-log-/, "").replace(/\.jsonl$/, ""))
      .sort();
  } catch {
    return [];
  }
}

async function listProductRunIds(homeOverride?: string): Promise<string[]> {
  const dir = path.join(muonroiHome(homeOverride), "usage", "products");
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

function keyOf(e: CostLogEntry, by: GroupBy): string {
  if (by === "callsite") return e.callsite ?? "<untagged>";
  if (by === "role") return e.role ?? "<no-role>";
  if (by === "phase") return e.phase ?? "<no-phase>";
  if (by === "model") return e.model;
  return e.provider;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

/**
 * Build aggregated rows from a flat list of cost entries.
 * Drift = actualInputTokens / estInputTokens. Average across calls where both exist.
 */
function aggregate(entries: CostLogEntry[], by: GroupBy): Row[] {
  const acc = new Map<string, Row>();
  for (const e of entries) {
    const k = keyOf(e, by);
    let r = acc.get(k);
    if (!r) {
      r = {
        key: k,
        calls: 0,
        usd: 0,
        inTok: 0,
        outTok: 0,
        cachedTok: 0,
        promptChars: 0,
        durationMs: 0,
        driftSum: 0,
        driftSamples: 0,
      };
      acc.set(k, r);
    }
    r.calls += 1;
    r.usd += e.estimatedUsd ?? 0;
    r.inTok += e.actualInputTokens ?? e.estInputTokens ?? 0;
    r.outTok += e.actualOutputTokens ?? 0;
    r.cachedTok += e.cachedInputTokens ?? 0;
    r.promptChars += e.promptChars ?? 0;
    r.durationMs += e.durationMs ?? 0;
    if (e.actualInputTokens && e.estInputTokens && e.estInputTokens > 0) {
      r.driftSum += e.actualInputTokens / e.estInputTokens;
      r.driftSamples += 1;
    }
  }
  return [...acc.values()].sort((a, b) => b.usd - a.usd);
}

function printTable(rows: Row[], by: GroupBy): void {
  if (rows.length === 0) {
    console.log("  (no entries)");
    return;
  }
  const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  console.log(`\nGroup by: ${by}   total: ${fmtUsd(totalUsd)} across ${totalCalls} calls`);
  console.log("─".repeat(110));
  console.log(
    `${"key".padEnd(28)} ${"calls".padStart(7)} ${"usd".padStart(10)} ${"%".padStart(6)} ${"in tok".padStart(11)} ${"out tok".padStart(11)} ${"cache".padStart(9)} ${"drift×".padStart(8)} ${"avg ms".padStart(8)}`,
  );
  console.log("─".repeat(110));
  for (const r of rows) {
    const pct = totalUsd > 0 ? (r.usd / totalUsd) * 100 : 0;
    const drift = r.driftSamples > 0 ? (r.driftSum / r.driftSamples).toFixed(2) : "-";
    const avgMs = r.calls > 0 ? Math.round(r.durationMs / r.calls) : 0;
    console.log(
      `${r.key.padEnd(28).slice(0, 28)} ${String(r.calls).padStart(7)} ${fmtUsd(r.usd).padStart(10)} ${pct.toFixed(1).padStart(5)}% ${fmtNum(r.inTok).padStart(11)} ${fmtNum(r.outTok).padStart(11)} ${fmtNum(r.cachedTok).padStart(9)} ${drift.padStart(8)} ${String(avgMs).padStart(8)}`,
    );
  }
}

/**
 * Convert a product-ledger entry into a cost-log–shaped entry so the same
 * aggregator handles both sources.
 */
async function loadProductEntries(runId: string, homeOverride?: string): Promise<CostLogEntry[]> {
  const entries = await readProductLedger(runId, homeOverride);
  return entries.map((e) => ({
    ts: e.ts,
    provider: e.provider,
    model: e.model,
    estimatedUsd: e.actualUsd,
    productRunId: e.productRunId,
    callsite: e.callsite,
    role: e.role,
    phase: e.phase,
    iteration: e.iteration,
    stepCount: e.stepCount,
    systemChars: e.systemChars,
    promptChars: e.promptChars,
    estInputTokens: e.estInputTokens,
    actualInputTokens: e.actualInputTokens,
    actualOutputTokens: e.actualOutputTokens,
    cachedInputTokens: e.cachedInputTokens,
    durationMs: e.durationMs,
  }));
}

export interface UsageReportOpts {
  by?: GroupBy;
  date?: string;
  runId?: string;
  source?: "cost-log" | "product" | "both";
  json?: boolean;
  breakdown?: boolean;
}

/**
 * Average the orchestrator-side prompt breakdown across message-source entries.
 * This is what answers "of the 17K input tokens, how many came from the system
 * prompt vs tool definitions vs message history".
 */
function printBreakdown(entries: CostLogEntry[]): void {
  const msgs = entries.filter((e) => e.callsite === "orchestrator.message" && e.breakdown);
  if (msgs.length === 0) {
    console.log("\nBreakdown: no orchestrator.message entries with breakdown data");
    return;
  }
  const keys = ["staticPrefixChars", "dynamicSuffixChars", "playwrightGuidanceChars", "messagesChars", "toolsChars"];
  const sums = new Map<string, number>();
  let totalCount = 0;
  let totalSystemChars = 0;
  let totalActualIn = 0;
  let totalToolsCount = 0;
  let totalMessagesCount = 0;
  for (const m of msgs) {
    totalCount += 1;
    for (const k of keys) sums.set(k, (sums.get(k) ?? 0) + (m.breakdown?.[k] ?? 0));
    totalSystemChars += m.breakdown?.systemChars ?? 0;
    totalActualIn += m.actualInputTokens ?? 0;
    totalToolsCount += m.breakdown?.toolsCount ?? 0;
    totalMessagesCount += m.breakdown?.messagesCount ?? 0;
  }
  const avgSystem = Math.round(totalSystemChars / totalCount);
  const avgActualInTok = Math.round(totalActualIn / totalCount);
  const avgTools = Math.round(totalToolsCount / totalCount);
  const avgMsgs = Math.round(totalMessagesCount / totalCount);
  console.log(`\nOrchestrator prompt breakdown  (${totalCount} message calls)`);
  console.log(
    `  avg system: ${avgSystem.toLocaleString()} chars (~${Math.round(avgSystem / 4).toLocaleString()} tok)   actual input: ~${avgActualInTok.toLocaleString()} tok   avg tools loaded: ${avgTools}   avg messages: ${avgMsgs}`,
  );
  console.log("─".repeat(95));
  console.log(
    `${"component".padEnd(30)} ${"avg chars".padStart(14)} ${"avg tok".padStart(10)} ${"% of system".padStart(14)}`,
  );
  console.log("─".repeat(95));
  const grandTotal = [...sums.values()].reduce((a, b) => a + b, 0);
  for (const k of keys) {
    const avg = Math.round((sums.get(k) ?? 0) / totalCount);
    const tok = Math.round(avg / 4);
    const pct = grandTotal > 0 ? ((sums.get(k) ?? 0) / grandTotal) * 100 : 0;
    console.log(
      `${k.padEnd(30)} ${avg.toLocaleString().padStart(14)} ${tok.toLocaleString().padStart(10)} ${pct.toFixed(1).padStart(13)}%`,
    );
  }
}

export async function runUsageReport(opts: UsageReportOpts = {}): Promise<void> {
  const by: GroupBy = opts.by ?? "callsite";
  const source = opts.source ?? "both";

  const entries: CostLogEntry[] = [];
  if (source === "cost-log" || source === "both") {
    if (opts.date) {
      entries.push(...(await readCostLog(opts.date)));
    } else {
      const dates = await listCostLogDates();
      for (const d of dates) entries.push(...(await readCostLog(d)));
    }
  }
  if (source === "product" || source === "both") {
    if (opts.runId) {
      entries.push(...(await loadProductEntries(opts.runId)));
    } else {
      const runs = await listProductRunIds();
      for (const r of runs) entries.push(...(await loadProductEntries(r)));
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(aggregate(entries, by), null, 2)}\n`);
    return;
  }

  console.log(`Loaded ${entries.length} entries (source=${source})`);
  printTable(aggregate(entries, by), by);

  if (opts.breakdown) {
    printBreakdown(entries);
  }

  // Drift watchlist — surface high-drift callsites separately (top 5 by drift × calls).
  const driftRows = aggregate(entries, "callsite")
    .filter((r) => r.driftSamples >= 3 && r.driftSum / r.driftSamples >= 1.5)
    .slice(0, 5);
  if (driftRows.length > 0) {
    console.log("\nEstimator drift > 1.5× (top offenders):");
    for (const r of driftRows) {
      const drift = (r.driftSum / r.driftSamples).toFixed(2);
      console.log(`  ${r.key.padEnd(28)} drift×${drift}  over ${r.driftSamples} calls`);
    }
  }
}
