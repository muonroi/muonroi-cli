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
import { listDecisionLogDates, readDecisionLog } from "../usage/decision-log.js";
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

  // Native self-assessment for the inner agent (one `usage` call now gives context bloat + comfort signals
  // instead of 5+ separate bash/read/grep for system info, tool load, and "am I going blind on state?").
  // This is the actionable output the agent can consume after any turn to self-calibrate.
  console.log("\n[agent-self] comfort snapshot (run with --breakdown for full per-turn numbers)");
  console.log(
    "  batch system info in ONE bash with ; or && (uname; node -v; ls -la | head; git status; df -h; ps | head), then bash_output_get(run_id, mode=...) for slices — never re-run.",
  );
  console.log(
    "  prefer read_file + grep over bash cat/grep/find for source; read-path budget defaults to 0 (unlimited after write/edit thanks to notifyWrite).",
  );
  console.log(
    "  high avg tools or system chars = use sub-agent compaction or cheaper model for research/verify roles; watch the drift table above.",
  );
}

export { aggregate, printTable };

function parseRelativeSince(since?: string): number | null {
  if (!since) return null;
  const m = since.match(/^(\d+)([dhm])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  const ms = u === "d" ? 86400000 : u === "h" ? 3600000 : 60000;
  return Date.now() - n * ms;
}

/**
 * security-audit (Task 3): yolo/permission overrides + high-risk cmds from decision-log (populated by appendAudit in permission-mode + bash shuru).
 * Reuses aggregate/printTable. Supports --since <date|7d|1h|30m>
 */
export async function runSecurityAudit(
  opts: { since?: string; json?: boolean; format?: "table" | "json" | "md" } = {},
) {
  const home = muonroiHome();
  const cutoff = parseRelativeSince(opts.since);
  let dates = await listDecisionLogDates(home);
  if (opts.since && /^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    dates = [opts.since];
  } else if (cutoff) {
    dates = dates.slice(-10);
  } else {
    dates = dates.slice(-3);
  }
  let decisions: any[] = [];
  for (const d of dates) {
    try {
      decisions = decisions.concat(await readDecisionLog(d, home));
    } catch {}
  }
  if (cutoff) {
    decisions = decisions.filter((d: any) => (d.ts || 0) >= cutoff);
  }
  const costDates = cutoff || !opts.since ? (await listCostLogDates(home)).slice(-1) : [opts.since!];
  let costEntries: CostLogEntry[] = [];
  for (const d of costDates) {
    try {
      costEntries = costEntries.concat(await readCostLog(d, home));
    } catch {}
  }
  const costRows = aggregate(costEntries, "callsite").slice(0, 8);
  const taken = decisions.filter((d: any) => d.taken);
  const overrides = decisions.filter((d: any) => d.kind === "yolo-override" || d.kind === "permission-override");
  const highRiskCmds: string[] = overrides
    .map((d: any) => {
      const ctx = d.meta?.context || {};
      let cmd = ctx.command ? String(ctx.command) : ctx.shuru ? "[shuru]" : "";
      if (cmd && cmd !== "[shuru]") {
        cmd = cmd.replace(/((?:key|token|secret|pwd|pass|auth|AWS_)[^=]*=)[^\s]+/gi, "$1[REDACTED]");
        cmd = cmd.replace(/https?:\/\/\S*?(?:key|token|secret)=\S+/gi, "[REDACTED_URL]");
        cmd = cmd.slice(0, 80);
      }
      return cmd;
    })
    .filter(Boolean);
  if (opts.json || opts.format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          decisions: decisions.length,
          taken: taken.length,
          overrides: overrides.length,
          highRiskCmds: [...new Set(highRiskCmds)].slice(0, 10),
          topCost: costRows,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  console.log(
    `\n[security-audit] ${decisions.length} decisions (${taken.length} taken) | ${overrides.length} yolo/permission overrides | ${costEntries.length} cost entries (since ${opts.since || "recent"})`,
  );
  if (overrides.length > 0) {
    console.log("Yolo / Permission overrides:");
    overrides.slice(0, 5).forEach((d: any) => {
      const ctx = d.meta?.context || {};
      const cmd = ctx.command ? ` cmd=${String(ctx.command).slice(0, 40)}` : ctx.shuru ? " [shuru]" : "";
      console.log(
        `  ${new Date(d.ts).toISOString().slice(0, 19)} ${d.kind} tool=${d.tool || ""}${cmd} reason=${d.reason || ""}`,
      );
    });
  }
  if (highRiskCmds.length > 0) {
    console.log("\nHigh-risk / sandbox cmds (redacted):");
    [...new Set(highRiskCmds)].slice(0, 5).forEach((c) => console.log(`  ${c}`));
  }
  if (taken.length > 0) {
    console.log("\nOther risky decisions taken:");
    taken
      .filter((d: any) => !["yolo-override", "permission-override"].includes(d.kind))
      .slice(0, 3)
      .forEach((d: any) => console.log(`  ${d.ts} ${d.kind} ${d.reason || ""}`));
  }
  console.log("\nTop spend by callsite (review for bloat/risk):");
  printTable(costRows, "callsite");
  if (opts.format === "md") {
    console.log("\n> Audit events from permission-mode + shuru included; review before prod use.");
  }
}

/**
 * Wave 1: perf-regression subcommand.
 * Reuses aggregate for cost/drift snapshot. --compare is stub (delta in later phase).
 */
export async function runPerfRegression(opts: { compare?: string; json?: boolean; format?: "table" | "json" } = {}) {
  const home = muonroiHome();
  const dates = (await listCostLogDates(home)).slice(-2);
  let entries: CostLogEntry[] = [];
  for (const d of dates) {
    try {
      entries = entries.concat(await readCostLog(d, home));
    } catch {}
  }
  const rows = aggregate(entries, "callsite");
  if (opts.json) {
    process.stdout.write(JSON.stringify({ entries: entries.length, top: rows.slice(0, 5) }, null, 2) + "\n");
    return;
  }
  console.log(`\n[perf-regression] snapshot ${entries.length} entries (compare=${opts.compare || "latest"})`);
  printTable(rows.slice(0, 8), "callsite");
  const drifts = rows.filter((r) => r.driftSamples >= 2 && r.driftSum / r.driftSamples > 1.2).slice(0, 3);
  if (drifts.length > 0) {
    console.log("\nHigh drift (>1.2x) callsites (potential regression):");
    drifts.forEach((r) =>
      console.log(`  ${r.key} drift×${(r.driftSum / r.driftSamples).toFixed(2)} over ${r.driftSamples}`),
    );
  }
}
