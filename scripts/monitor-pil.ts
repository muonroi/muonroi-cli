#!/usr/bin/env node
// PIL Phase G monitor — daily snapshot of unified-call rollout health.
//
// Reads ~/.muonroi-cli/muonroi.db, aggregates the last N hours of `event_type='pil'`
// rows, and prints distribution + latency + fallback breakdown. Used during Phase 4
// dogfood and Phase 6 observation to gate the rollout transitions.
//
// Usage:
//   npx tsx scripts/monitor-pil.ts                # last 24h (default)
//   npx tsx scripts/monitor-pil.ts --hours 168    # last 7 days
//   npx tsx scripts/monitor-pil.ts --json         # machine-readable output

import { getDatabase } from "../src/storage/db.js";

interface Args {
  hours: number;
  json: boolean;
}
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let hours = 24;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--hours" && argv[i + 1]) {
      hours = Number(argv[++i]);
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    hours = 24;
  }
  return { hours, json };
}

interface PilRow {
  duration_ms: number;
  event_subtype: string | null; // taskType
  metadata_json: string;
  created_at: string;
}

interface LayerEntry {
  name: string;
  applied?: boolean;
  delta?: string | null;
}
interface LayerTiming {
  name: string;
  ms: number;
}
interface PilMetadata {
  layers?: string[];
  layerCount?: number;
  layerTimings?: LayerTiming[] | null;
  domain?: string | null;
  confidence?: number;
  outputStyle?: string | null;
  intentKind?: string | null;
  fallbackReason?: string | null;
  eeMode?: string;
  fullLayers?: LayerEntry[]; // optional richer payload
}

function parseUnifiedStatus(meta: PilMetadata): "ok" | "fail" | "skip" | "unknown" {
  // Read from the intent-detection layer's delta string: "...unified=ok|fail|skip"
  const layers = meta.fullLayers ?? [];
  const intentLayer = layers.find((l) => l.name === "intent-detection");
  const delta = intentLayer?.delta ?? "";
  if (delta.includes("unified=ok")) {
    return "ok";
  }
  if (delta.includes("unified=fail")) {
    return "fail";
  }
  if (delta.includes("unified=skip")) {
    return "skip";
  }
  return "unknown";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

async function main() {
  const args = parseArgs();
  const db = getDatabase();
  const cutoff = new Date(Date.now() - args.hours * 3600_000).toISOString();

  const rows = db
    .prepare(
      `SELECT duration_ms, event_subtype, metadata_json, created_at
       FROM interaction_logs
       WHERE event_type = 'pil' AND created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(cutoff) as PilRow[];

  if (rows.length === 0) {
    const msg = `No 'pil' events in the last ${args.hours}h. Either CLI is idle, or PIL logging is broken.`;
    if (args.json) {
      console.log(JSON.stringify({ window_hours: args.hours, events: 0, error: msg }));
    } else {
      console.log(msg);
    }
    process.exit(0);
  }

  let okCount = 0,
    failCount = 0,
    skipCount = 0,
    unknownCount = 0;
  const latencies: number[] = [];
  const fallbackReasons = new Map<string, number>();
  const taskTypeDist = new Map<string, number>();
  const eeModes = new Map<string, number>();
  let timeoutCount = 0;

  for (const r of rows) {
    let meta: PilMetadata;
    try {
      meta = JSON.parse(r.metadata_json) as PilMetadata;
    } catch {
      continue;
    }

    const status = parseUnifiedStatus(meta);
    if (status === "ok") {
      okCount++;
    } else if (status === "fail") {
      failCount++;
    } else if (status === "skip") {
      skipCount++;
    } else {
      unknownCount++;
    }

    if (typeof r.duration_ms === "number") {
      latencies.push(r.duration_ms);
    }
    if (meta.fallbackReason) {
      fallbackReasons.set(meta.fallbackReason, (fallbackReasons.get(meta.fallbackReason) ?? 0) + 1);
      if (meta.fallbackReason.includes("timeout")) {
        timeoutCount++;
      }
    }
    const tt = r.event_subtype ?? "none";
    taskTypeDist.set(tt, (taskTypeDist.get(tt) ?? 0) + 1);
    const ee = meta.eeMode ?? "unknown";
    eeModes.set(ee, (eeModes.get(ee) ?? 0) + 1);
  }

  latencies.sort((a, b) => a - b);
  const total = rows.length;
  const okPct = (okCount / total) * 100;
  const timeoutPct = (timeoutCount / total) * 100;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          window_hours: args.hours,
          events: total,
          unified_status: { ok: okCount, fail: failCount, skip: skipCount, unknown: unknownCount, ok_pct: okPct },
          latency_ms: {
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            p99: percentile(latencies, 0.99),
            max: latencies[latencies.length - 1] ?? 0,
          },
          timeout: { count: timeoutCount, pct: timeoutPct },
          fallback_reasons: Object.fromEntries(fallbackReasons),
          task_types: Object.fromEntries(taskTypeDist),
          ee_modes: Object.fromEntries(eeModes),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Human-readable
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`\nPIL monitor — last ${args.hours}h (${total} events since ${cutoff})\n`);
  console.log(`unified_status:`);
  console.log(`  ok      ${okCount.toString().padStart(5)} (${pct(okCount)})`);
  console.log(`  fail    ${failCount.toString().padStart(5)} (${pct(failCount)})`);
  console.log(`  skip    ${skipCount.toString().padStart(5)} (${pct(skipCount)})`);
  console.log(`  unknown ${unknownCount.toString().padStart(5)} (${pct(unknownCount)})`);
  console.log(`\nlatency (ms):`);
  console.log(`  p50  ${percentile(latencies, 0.5)}`);
  console.log(`  p95  ${percentile(latencies, 0.95)}`);
  console.log(`  p99  ${percentile(latencies, 0.99)}`);
  console.log(`  max  ${latencies[latencies.length - 1] ?? 0}`);
  console.log(`\ntimeout rate: ${timeoutCount}/${total} (${timeoutPct.toFixed(1)}%)`);

  if (fallbackReasons.size > 0) {
    console.log(`\nfallback reasons:`);
    for (const [reason, count] of [...fallbackReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count.toString().padStart(5)}  ${reason}`);
    }
  }

  console.log(`\ntask types:`);
  for (const [tt, count] of [...taskTypeDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(5)}  ${tt}`);
  }

  console.log(`\nee modes:`);
  for (const [mode, count] of [...eeModes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(5)}  ${mode}`);
  }

  // Gate evaluation
  console.log(`\nPhase G gates:`);
  const gate = (label: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(28)} ${detail}`);
  };
  gate("unified ok >= 95%", okPct >= 95, `${okPct.toFixed(1)}%`);
  gate("timeout rate < 5%", timeoutPct < 5, `${timeoutPct.toFixed(1)}%`);
  gate("p95 latency < 2500ms", percentile(latencies, 0.95) < 2500, `${percentile(latencies, 0.95)}ms`);
}

main().catch((err) => {
  console.error("monitor-pil error:", err);
  process.exit(1);
});
