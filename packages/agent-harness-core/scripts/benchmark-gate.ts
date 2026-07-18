// ---------------------------------------------------------------------------
// Sprint 1 gate p95 latency benchmark
//
// Measures the overhead of the in-process sandbox gate against the same file I/O
// performed without the gate (baseline = actual tool operation). Acceptance
// criterion: post-gate p95 overhead <10% of baseline agent-turn latency.
//
// Usage:
//   bun run packages/agent-harness-core/scripts/benchmark-gate.ts
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/sandbox/gate.js";
import type { PhaseSignal, ToolRequest } from "../src/sandbox/types.js";

const WARMUP = 500;
const ITERATIONS = 5000;

function phase(value: PhaseSignal["value"], turnId: string): PhaseSignal {
  return { value, source: "orchestrator-ssot", turnId };
}

function p95(ns: number[]): number {
  const sorted = [...ns].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

async function baselineRead(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "sandbox-bench-"));
  const allowFile = join(tmp, "allowed.txt");
  // Use a representative file size so the baseline I/O dominates the gate decision cost.
  writeFileSync(allowFile, "x".repeat(1024 * 1024));

  const readPhase = phase("Read", "bench-read");
  const readReq: ToolRequest = { kind: "fs", path: allowFile };

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await baselineRead(allowFile);
    await evaluate(readPhase, readReq);
  }

  const baselineNs: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    await baselineRead(allowFile);
    const end = process.hrtime.bigint();
    baselineNs.push(Number(end - start));
  }

  const gateNs: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    await evaluate(readPhase, readReq);
    const end = process.hrtime.bigint();
    gateNs.push(Number(end - start));
  }

  const baselineP95 = p95(baselineNs);
  const gateP95 = p95(gateNs);
  const overheadNs = Math.max(0, gateP95 - baselineP95);
  const overheadPct = (overheadNs / baselineP95) * 100;

  const report = {
    baselineP95Ns: baselineP95,
    gateP95Ns: gateP95,
    overheadNs,
    overheadPct,
    baselineMeanNs: mean(baselineNs),
    gateMeanNs: mean(gateNs),
    iterations: ITERATIONS,
    pass: overheadPct < 10,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
