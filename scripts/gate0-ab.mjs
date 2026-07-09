#!/usr/bin/env bun
/**
 * scripts/gate0-ab.mjs — Gate 0: measurement-isolation A/B harness.
 *
 * Post-council (session 488d541391b0) the ≥50% fresh-input claim is
 * uninterpretable until measurement isolates FRESH tokens from cache warming,
 * model nondeterminism, and turn-count changes. This harness enforces that
 * discipline so no later gate (O1/O2/O3) can score a cache-only or
 * sequential-forced artifact as an architecture win.
 *
 * PRIMARY metric = FRESH input = input_tokens - cache_read_tokens. Fresh is
 * cache-independent by construction (it subtracts the cached prefix), so
 * comparing fresh across arms is the cache-isolated comparison the council
 * demanded. cached_fraction is ALSO reported so a warm-cache confound is
 * VISIBLE, and the falsifier rules flag cache-only / sequential-forced "wins".
 *
 * COLD-CACHE LIMITATION (honest): provider prompt-cache state cannot be forced
 * cold via an API key without waiting out the provider TTL. This harness does
 * NOT pretend to. Instead it (a) makes fresh — not total input — the metric,
 * (b) reports cached_fraction per arm, (c) FLAGS the comparison when arms
 * diverge in cache state or turn count. Run arms back-to-back to equalize
 * warming; alternate arm order across --runs to average it out.
 *
 * Usage:
 *   bun scripts/gate0-ab.mjs \
 *     --prompt "Read src/a.ts, src/b.ts, src/c.ts and summarize each" \
 *     --arm "baseline|" \
 *     --arm "hysteresis|MUONROI_COMPACT_HYSTERESIS=1.15" \
 *     [--model opencode/kimi-k2.7-code] [--runs 1] [--json]
 *
 *   # analyze-only: compare two already-captured usage_events rowid watermarks
 *   bun scripts/gate0-ab.mjs --analyze-only --arm "A|@12345" --arm "B|@23456"
 *
 * Arm spec: "<label>|<ENV1=v1,ENV2=v2>"  (env list may be empty)
 *   In --analyze-only mode the part after "|" is "@<rowidWatermark>" instead.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SEQUENTIAL_SPLIT_PROVIDERS = ["kimi", "glm", "deepseek-go", "deepseek-ai/deepseek", "z.ai", "zai"];

function dbPath() {
  const home = process.env.MUONROI_CLI_HOME ?? join(homedir(), ".muonroi-cli");
  return join(home, "muonroi.db");
}

function parseArgs(argv) {
  const out = { arms: [], prompt: null, model: null, runs: 1, json: false, analyzeOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt") out.prompt = argv[++i];
    else if (a === "--arm") out.arms.push(argv[++i]);
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--runs") out.runs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--json") out.json = true;
    else if (a === "--analyze-only") out.analyzeOnly = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (out.arms.length < 1) throw new Error("need at least one --arm");
  if (!out.analyzeOnly && !out.prompt) throw new Error("--prompt required unless --analyze-only");
  return out;
}

function parseArm(spec) {
  const bar = spec.indexOf("|");
  const label = (bar === -1 ? spec : spec.slice(0, bar)).trim();
  const rest = bar === -1 ? "" : spec.slice(bar + 1).trim();
  return { label, rest };
}

function envFromArm(rest) {
  const env = {};
  if (!rest) return env;
  for (const pair of rest.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return env;
}

function watermark(db) {
  const row = db.query("SELECT COALESCE(MAX(id),0) AS m FROM usage_events").get();
  return row?.m ?? 0;
}

/** Aggregate usage_events (id > sinceUsage) + interaction_logs tool_call count. */
function collect(db, sinceUsage) {
  const rows = db
    .query(
      `SELECT id, source, model, input_tokens AS input, cache_read_tokens AS cread
       FROM usage_events WHERE id > ? ORDER BY id`,
    )
    .all(sinceUsage);

  const m = {
    llmCalls: 0, // top-level billed calls (source='message')
    childCalls: 0, // task/subagent/council rows (depth >= 1)
    totalInput: 0,
    totalCacheRead: 0,
    totalFresh: 0,
    peakFresh: 0,
    bySource: {}, // depth proxy
    byProvider: {}, // model -> {fresh, calls}
    sequentialSplitSeen: false,
    rowCount: rows.length,
  };
  for (const r of rows) {
    const fresh = Math.max(0, (r.input ?? 0) - (r.cread ?? 0));
    m.totalInput += r.input ?? 0;
    m.totalCacheRead += r.cread ?? 0;
    m.totalFresh += fresh;
    if (fresh > m.peakFresh) m.peakFresh = fresh;
    if (r.source === "message") m.llmCalls++;
    else m.childCalls++;
    const src = r.source ?? "?";
    m.bySource[src] ??= { fresh: 0, calls: 0 };
    m.bySource[src].fresh += fresh;
    m.bySource[src].calls++;
    const prov = r.model ?? "?";
    m.byProvider[prov] ??= { fresh: 0, calls: 0 };
    m.byProvider[prov].fresh += fresh;
    m.byProvider[prov].calls++;
    if (SEQUENTIAL_SPLIT_PROVIDERS.some((p) => prov.toLowerCase().includes(p))) m.sequentialSplitSeen = true;
  }
  m.cachedFraction = m.totalInput > 0 ? m.totalCacheRead / m.totalInput : 0;
  const calls = m.llmCalls + m.childCalls || 1;
  m.freshPerCall = Math.round(m.totalFresh / calls);
  return m;
}

function toolCallCount(db, sinceIlog) {
  try {
    const row = db
      .query(`SELECT COUNT(*) AS c FROM interaction_logs WHERE id > ? AND event_type = 'tool_call'`)
      .get(sinceIlog);
    return row?.c ?? 0;
  } catch {
    return -1; // table absent / schema drift — surfaced, not swallowed
  }
}

function ilogWatermark(db) {
  try {
    const row = db.query("SELECT COALESCE(MAX(id),0) AS m FROM interaction_logs").get();
    return row?.m ?? 0;
  } catch {
    return 0;
  }
}

function runArm(arm, opts) {
  const db = new Database(dbPath(), { readonly: true });
  const wmU = watermark(db);
  const wmI = ilogWatermark(db);
  db.close();

  const env = { ...process.env, ...envFromArm(arm.rest) };
  if (opts.model) env.MUONROI_MODEL = opts.model;
  const entry = resolve("src/index.ts");
  const args = ["run", entry, "-p", opts.prompt, "--format", "text"];
  const started = Date.now();
  const res = spawnSync("bun", args, { env, encoding: "utf8", timeout: 300_000 });
  const wallMs = Date.now() - started;
  if (res.status !== 0) {
    process.stderr.write(`[gate0] arm "${arm.label}" exited ${res.status}: ${(res.stderr || "").slice(0, 400)}\n`);
  }

  const db2 = new Database(dbPath(), { readonly: true });
  const m = collect(db2, wmU);
  m.toolCalls = toolCallCount(db2, wmI);
  m.wallMs = wallMs;
  db2.close();
  return m;
}

function analyzeArm(arm) {
  const at = arm.rest.startsWith("@") ? parseInt(arm.rest.slice(1), 10) : NaN;
  if (!Number.isFinite(at)) throw new Error(`--analyze-only arm "${arm.label}" needs "@<rowid>"`);
  const db = new Database(dbPath(), { readonly: true });
  const m = collect(db, at);
  m.toolCalls = -1;
  m.wallMs = 0;
  db.close();
  return m;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function report(results, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }
  const base = results[0];
  process.stdout.write(`\n=== Gate 0 A/B — measurement-isolated (FRESH is primary) ===\n`);
  for (const r of results) {
    process.stdout.write(
      `\n[${r.label}]  llm_calls=${r.m.llmCalls} child_calls=${r.m.childCalls} tool_calls=${r.m.toolCalls}\n` +
        `  total_fresh=${r.m.totalFresh}  fresh/call=${r.m.freshPerCall}  peak_fresh=${r.m.peakFresh}\n` +
        `  total_input=${r.m.totalInput}  cache_read=${r.m.totalCacheRead}  cached_fraction=${pct(r.m.cachedFraction)}\n` +
        `  by_source(depth): ${Object.entries(r.m.bySource)
          .map(([k, v]) => `${k}=${v.fresh}f/${v.calls}c`)
          .join("  ")}\n` +
        `  by_provider: ${Object.entries(r.m.byProvider)
          .map(([k, v]) => `${k}=${v.fresh}f/${v.calls}c`)
          .join("  ")}\n` +
        (r.m.wallMs ? `  wall=${(r.m.wallMs / 1000).toFixed(1)}s\n` : ""),
    );
  }

  // Falsifier gate (arm[i] vs arm[0] baseline)
  process.stdout.write(`\n--- Falsifier checks (vs "${base.label}") ---\n`);
  let anyFlag = false;
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    const flags = [];
    const freshDelta = base.m.totalFresh > 0 ? (r.m.totalFresh - base.m.totalFresh) / base.m.totalFresh : 0;
    const callDelta = Math.abs(r.m.llmCalls - base.m.llmCalls);

    if (callDelta >= 2)
      flags.push(
        `TURN-COUNT DIVERGENCE (${base.m.llmCalls}→${r.m.llmCalls}) — fresh comparison unreliable (nondeterminism / forced-sequential confound)`,
      );
    if (r.m.totalFresh < base.m.totalFresh && r.m.cachedFraction - base.m.cachedFraction > 0.1)
      flags.push(
        `CACHE-ONLY WIN — fresh dropped but cached_fraction rose ${pct(base.m.cachedFraction)}→${pct(r.m.cachedFraction)}; not architecture`,
      );
    if (r.m.totalFresh < base.m.totalFresh && r.m.llmCalls > base.m.llmCalls)
      flags.push(`SEQUENTIAL-FORCED — fresh down but MORE llm_calls; provider likely split the batch`);
    if (r.m.sequentialSplitSeen)
      flags.push(
        `provider in split-cohort present (kimi/glm/deepseek-go/z.ai) — stratify, do not pool into the ≥50% claim`,
      );

    const verdict = flags.length === 0 ? `fresh Δ=${pct(freshDelta)} — clean, interpretable` : flags.join("\n      ");
    if (flags.length) anyFlag = true;
    process.stdout.write(`  [${r.label}] ${flags.length ? "⚠ FLAGGED\n      " : "✓ "}${verdict}\n`);
  }
  if (!anyFlag) process.stdout.write(`  all arms comparable — fresh deltas are architecture-attributable.\n`);
  process.stdout.write(`\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const arms = opts.arms.map(parseArm);
  const results = [];
  // --runs alternates arm order to average cache warming across repetitions.
  for (let run = 0; run < opts.runs; run++) {
    const order = run % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of order) {
      const m = opts.analyzeOnly ? analyzeArm(arm) : runArm(arm, opts);
      const existing = results.find((r) => r.label === arm.label);
      if (existing) {
        // accumulate across runs (simple mean of fresh for stability)
        existing.runs++;
        existing.m.totalFresh = Math.round(
          (existing.m.totalFresh * (existing.runs - 1) + m.totalFresh) / existing.runs,
        );
      } else {
        results.push({ label: arm.label, runs: 1, m });
      }
    }
  }
  // keep results in the declared arm order
  results.sort((a, b) => arms.findIndex((x) => x.label === a.label) - arms.findIndex((x) => x.label === b.label));
  report(results, opts);
}

main();
