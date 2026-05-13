/**
 * src/cli/pil-report.ts
 *
 * `muonroi-cli usage pil` — aggregate PIL budget-log entries to surface
 * which layer is responsible for prompt-size growth.
 *
 * Companion to usage-report.ts (which groups model-call cost). Where that
 * report answers "which model call costs the most", this one answers
 * "which PIL layer is making the system prompt huge before any model
 * call happens".
 */

import { type IntentTraceSnapshot, listPilLogDates, type PilBudgetLogEntry, readPilLog } from "../pil/budget-log.js";

interface LayerAgg {
  name: string;
  invocations: number;
  totalChars: number;
  maxChars: number;
  totalMs: number;
  growthEvents: number;
}

export interface PilReportOpts {
  date?: string;
  json?: boolean;
  top?: number;
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function aggregateLayers(entries: PilBudgetLogEntry[]): LayerAgg[] {
  const acc = new Map<string, LayerAgg>();
  for (const e of entries) {
    for (const l of e.layers) {
      let a = acc.get(l.name);
      if (!a) {
        a = { name: l.name, invocations: 0, totalChars: 0, maxChars: 0, totalMs: 0, growthEvents: 0 };
        acc.set(l.name, a);
      }
      a.invocations += 1;
      a.totalChars += Math.max(0, l.charsDelta);
      a.maxChars = Math.max(a.maxChars, l.charsDelta);
      a.totalMs += l.durationMs;
      if (l.charsDelta > 0) a.growthEvents += 1;
    }
  }
  return [...acc.values()].sort((a, b) => b.totalChars - a.totalChars);
}

function printLayerTable(rows: LayerAgg[]): void {
  if (rows.length === 0) {
    console.log("  (no entries — run a prompt first)");
    return;
  }
  const totalChars = rows.reduce((s, r) => s + r.totalChars, 0);
  console.log("\nPIL layer attribution");
  console.log("─".repeat(105));
  console.log(
    `${"layer".padEnd(26)} ${"invocs".padStart(7)} ${"sum Δchars".padStart(12)} ${"%".padStart(6)} ${"max Δ".padStart(10)} ${"avg Δ".padStart(10)} ${"avg ms".padStart(8)} ${"grew/n".padStart(10)}`,
  );
  console.log("─".repeat(105));
  for (const r of rows) {
    const pct = totalChars > 0 ? (r.totalChars / totalChars) * 100 : 0;
    const avgChars = r.invocations > 0 ? Math.round(r.totalChars / r.invocations) : 0;
    const avgMs = r.invocations > 0 ? Math.round(r.totalMs / r.invocations) : 0;
    console.log(
      `${r.name.padEnd(26)} ${String(r.invocations).padStart(7)} ${fmtNum(r.totalChars).padStart(12)} ${pct.toFixed(1).padStart(5)}% ${fmtNum(r.maxChars).padStart(10)} ${fmtNum(avgChars).padStart(10)} ${String(avgMs).padStart(8)} ${`${r.growthEvents}/${r.invocations}`.padStart(10)}`,
    );
  }
}

/**
 * Aggregate intent-detection traces to answer "where does Layer 1 actually
 * decide the outcome?". A healthy distribution has most prompts decided by
 * the cheap passes (1, 2, 2.5) and only the genuinely-ambiguous ones reaching
 * the brain calls. If pass3LegacyStyleAttempted dominates, the 800ms style
 * brain call is the bloat source — fixable by widening the explicit-style
 * regex patterns in layer1-intent.ts.
 */
function printIntentDetectionBreakdown(entries: PilBudgetLogEntry[]): void {
  const traces = entries.map((e) => e.intentDetection).filter((t): t is IntentTraceSnapshot => t != null);
  if (traces.length === 0) {
    console.log("\nIntent detection: no trace data (entries pre-date trace rollout)");
    return;
  }
  const total = traces.length;
  const counts = {
    pass1Hit: 0,
    pass2Hit: 0,
    pass25ChitchatHit: 0,
    pass3UnifiedAttempted: 0,
    pass3UnifiedSucceeded: 0,
    pass3LegacyTaskAttempted: 0,
    pass3LegacyTaskSucceeded: 0,
    pass3LegacyStyleAttempted: 0,
    pass3LegacyStyleSucceeded: 0,
  };
  const styleSrc = new Map<string, number>();
  const reasonHist = new Map<string, number>();
  for (const t of traces) {
    if (t.pass1Hit) counts.pass1Hit += 1;
    if (t.pass2Hit) counts.pass2Hit += 1;
    if (t.pass25ChitchatHit) counts.pass25ChitchatHit += 1;
    if (t.pass3UnifiedAttempted) counts.pass3UnifiedAttempted += 1;
    if (t.pass3UnifiedSucceeded) counts.pass3UnifiedSucceeded += 1;
    if (t.pass3LegacyTaskAttempted) counts.pass3LegacyTaskAttempted += 1;
    if (t.pass3LegacyTaskSucceeded) counts.pass3LegacyTaskSucceeded += 1;
    if (t.pass3LegacyStyleAttempted) counts.pass3LegacyStyleAttempted += 1;
    if (t.pass3LegacyStyleSucceeded) counts.pass3LegacyStyleSucceeded += 1;
    styleSrc.set(t.styleSource, (styleSrc.get(t.styleSource) ?? 0) + 1);
    reasonHist.set(t.pass1Reason, (reasonHist.get(t.pass1Reason) ?? 0) + 1);
  }
  const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`\nIntent detection breakdown  (${total} prompts)`);
  console.log("─".repeat(70));
  console.log(
    `  Pass 1 (classifier)         ${String(counts.pass1Hit).padStart(6)}  ${pct(counts.pass1Hit).padStart(7)}  free`,
  );
  console.log(
    `  Pass 2 (keyword regex)      ${String(counts.pass2Hit).padStart(6)}  ${pct(counts.pass2Hit).padStart(7)}  free`,
  );
  console.log(
    `  Pass 2.5 (chitchat short)   ${String(counts.pass25ChitchatHit).padStart(6)}  ${pct(counts.pass25ChitchatHit).padStart(7)}  free`,
  );
  console.log(
    `  Pass 3 unified attempt      ${String(counts.pass3UnifiedAttempted).padStart(6)}  ${pct(counts.pass3UnifiedAttempted).padStart(7)}  paid (~1.5s)`,
  );
  console.log(
    `           success rate       ${String(counts.pass3UnifiedSucceeded).padStart(6)}/${String(counts.pass3UnifiedAttempted).padStart(4)}`,
  );
  console.log(
    `  Pass 3 legacy TASK call     ${String(counts.pass3LegacyTaskAttempted).padStart(6)}  ${pct(counts.pass3LegacyTaskAttempted).padStart(7)}  paid (~1.5s)`,
  );
  console.log(
    `           success rate       ${String(counts.pass3LegacyTaskSucceeded).padStart(6)}/${String(counts.pass3LegacyTaskAttempted).padStart(4)}`,
  );
  console.log(
    `  Pass 3 legacy STYLE call    ${String(counts.pass3LegacyStyleAttempted).padStart(6)}  ${pct(counts.pass3LegacyStyleAttempted).padStart(7)}  paid (~0.8s)`,
  );
  console.log(
    `           success rate       ${String(counts.pass3LegacyStyleSucceeded).padStart(6)}/${String(counts.pass3LegacyStyleAttempted).padStart(4)}`,
  );

  console.log("\n  Style source histogram:");
  for (const [src, n] of [...styleSrc.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${src.padEnd(24)} ${String(n).padStart(6)}  ${pct(n).padStart(7)}`);
  }

  console.log("\n  Top Pass 1 reasons:");
  const topReasons = [...reasonHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [reason, n] of topReasons) {
    console.log(`    ${reason.padEnd(28)} ${String(n).padStart(6)}  ${pct(n).padStart(7)}`);
  }
}

function printTopOffenders(entries: PilBudgetLogEntry[], top: number): void {
  const sorted = [...entries].sort((a, b) => b.totalDeltaChars - a.totalDeltaChars).slice(0, top);
  if (sorted.length === 0) return;
  console.log(`\nTop ${top} prompts by total PIL growth`);
  console.log("─".repeat(105));
  for (const e of sorted) {
    const ts = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
    const dominantLayer = [...e.layers].sort((a, b) => b.charsDelta - a.charsDelta)[0];
    const tag = dominantLayer ? `${dominantLayer.name}+${fmtNum(dominantLayer.charsDelta)}` : "-";
    console.log(
      `  ${ts}  raw=${fmtNum(e.rawChars).padStart(5)}  enriched=${fmtNum(e.enrichedChars).padStart(6)}  Δ=${fmtNum(e.totalDeltaChars).padStart(6)}  top: ${tag}`,
    );
  }
}

export async function runPilReport(opts: PilReportOpts = {}): Promise<void> {
  const top = opts.top ?? 5;
  const entries: PilBudgetLogEntry[] = [];
  if (opts.date) {
    entries.push(...(await readPilLog(opts.date)));
  } else {
    const dates = await listPilLogDates();
    for (const d of dates) entries.push(...(await readPilLog(d)));
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ entries: entries.length, layers: aggregateLayers(entries) }, null, 2)}\n`);
    return;
  }

  console.log(`Loaded ${entries.length} PIL pipeline runs`);
  if (entries.length === 0) return;

  const enrichedTotal = entries.reduce((s, e) => s + e.enrichedChars, 0);
  const rawTotal = entries.reduce((s, e) => s + e.rawChars, 0);
  const avgGrowth = entries.length > 0 ? Math.round((enrichedTotal - rawTotal) / entries.length) : 0;
  console.log(
    `Avg prompt: raw ${Math.round(rawTotal / entries.length)} chars → enriched ${Math.round(enrichedTotal / entries.length)} chars  (avg +${fmtNum(avgGrowth)} chars per prompt)`,
  );

  printLayerTable(aggregateLayers(entries));
  printIntentDetectionBreakdown(entries);
  printTopOffenders(entries, top);
}
