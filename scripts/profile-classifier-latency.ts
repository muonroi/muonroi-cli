#!/usr/bin/env bun
// Profile classifier latency distribution against prod /api/pil-context.
// Runs N samples of M fixtures and prints p50/p90/p95/p99/max plus a per-
// fixture success rate. Used to right-size classifyViaBrain timeout without
// guessing. Run AFTER each model/prompt change to verify the new floor.
//
// Usage:
//   bun scripts/profile-classifier-latency.ts                # 20 samples × 8 fixtures
//   bun scripts/profile-classifier-latency.ts --samples 50
//   bun scripts/profile-classifier-latency.ts --json

import { getCachedAuthToken, getCachedServerBaseUrl, loadEEAuthToken } from "../src/ee/auth.js";

interface Args {
  samples: number;
  json: boolean;
}
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let samples = 20;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--samples" && argv[i + 1]) samples = Number(argv[++i]);
    else if (argv[i] === "--json") json = true;
  }
  return { samples, json };
}

const FIXTURES = [
  "refactor this function to be async",
  "tại sao test fail?",
  "thiết kế hệ thống auth cho team",
  "hi",
  "phân tích lỗi memory leak",
  "write docs for the API endpoint",
  "generate a TypeScript Zod schema for User",
  "explain how OAuth works",
];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

async function probe(
  baseUrl: string,
  token: string,
  prompt: string,
): Promise<{ ms: number; ok: boolean; taskType: string | null; inferenceMs: number; cacheHit: boolean }> {
  const started = Date.now();
  // Bust cache so we measure REAL classifier latency, not 35ms cache hit.
  const cacheBust = ` /* nonce=${Math.random().toString(36).slice(2)} */`;
  const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/pil-context`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt: prompt + cacheBust }),
    signal: AbortSignal.timeout(10000),
  });
  const ms = Date.now() - started;
  if (!resp.ok) return { ms, ok: false, taskType: null, inferenceMs: 0, cacheHit: false };
  const body = (await resp.json()) as { taskType: string | null; inference_ms?: number; cache_hit?: boolean };
  return {
    ms,
    ok: body.taskType !== null,
    taskType: body.taskType,
    inferenceMs: body.inference_ms ?? 0,
    cacheHit: body.cache_hit ?? false,
  };
}

async function main() {
  const args = parseArgs();
  await loadEEAuthToken();
  const baseUrl = getCachedServerBaseUrl();
  const token = getCachedAuthToken();
  if (!baseUrl || !token) {
    console.error("missing baseUrl/token");
    process.exit(1);
  }

  console.log(`\nProfiling classifier latency — ${baseUrl}`);
  console.log(`samples=${args.samples} fixtures=${FIXTURES.length} total_calls=${args.samples * FIXTURES.length}\n`);

  const all: { fixture: string; ms: number; ok: boolean; inferenceMs: number }[] = [];
  for (const fixture of FIXTURES) {
    const runs: { ms: number; ok: boolean; inferenceMs: number; taskType: string | null }[] = [];
    for (let i = 0; i < args.samples; i++) {
      try {
        const r = await probe(baseUrl, token, fixture);
        runs.push(r);
        all.push({ fixture, ms: r.inferenceMs || r.ms, ok: r.ok, inferenceMs: r.inferenceMs });
      } catch {
        runs.push({ ms: 10000, ok: false, inferenceMs: 0, taskType: null });
        all.push({ fixture, ms: 10000, ok: false, inferenceMs: 0 });
      }
    }
    const sorted = [...runs].map((r) => r.inferenceMs || r.ms).sort((a, b) => a - b);
    const okCount = runs.filter((r) => r.ok).length;
    console.log(`"${fixture.slice(0, 40)}"`);
    console.log(
      `  hits: ${okCount}/${runs.length}  p50=${pct(sorted, 0.5)}ms  p95=${pct(sorted, 0.95)}ms  max=${sorted[sorted.length - 1]}ms`,
    );
  }

  const allMs = all.map((r) => r.ms).sort((a, b) => a - b);
  const totalOk = all.filter((r) => r.ok).length;
  console.log(`\nOVERALL across ${all.length} calls:`);
  console.log(`  success rate: ${totalOk}/${all.length} (${((totalOk / all.length) * 100).toFixed(1)}%)`);
  console.log(`  p50 = ${pct(allMs, 0.5)}ms`);
  console.log(`  p90 = ${pct(allMs, 0.9)}ms`);
  console.log(`  p95 = ${pct(allMs, 0.95)}ms`);
  console.log(`  p99 = ${pct(allMs, 0.99)}ms`);
  console.log(`  max = ${allMs[allMs.length - 1]}ms`);

  console.log(`\nTimeout sizing guidance (% of calls that complete by deadline):`);
  for (const t of [1500, 2000, 2500, 3000, 3500, 4000]) {
    const completed = allMs.filter((ms) => ms <= t).length;
    const pctPass = (completed / allMs.length) * 100;
    const recommend = pctPass >= 99 ? " ← p99 sweet spot" : pctPass >= 95 ? " ← p95" : "";
    console.log(`  ${t}ms → ${completed}/${allMs.length} = ${pctPass.toFixed(1)}%${recommend}`);
  }

  if (args.json) {
    console.log(
      "\n" +
        JSON.stringify(
          { baseUrl, samples: args.samples, all, p50: pct(allMs, 0.5), p95: pct(allMs, 0.95), p99: pct(allMs, 0.99) },
          null,
          2,
        ),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
