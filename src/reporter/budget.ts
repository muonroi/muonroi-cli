/**
 * src/reporter/budget.ts
 *
 * Tracks per-run-per-UTC-day LLM spend for the reporter agent.
 * Storage: .planning/runs/<runId>/reporter-budget.json
 *
 * Format: { "<YYYY-MM-DD UTC>": <spentUsd> }
 * Old day entries are kept up to 30 days; older entries are pruned on write.
 */

import * as path from "node:path";
import { atomicReadJSON, atomicWriteJSON } from "../storage/atomic-io.js";

type BudgetRecord = Record<string, number>;

const KEEP_DAYS = 30;

function budgetPath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, "reporter-budget.json");
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function prunedRecord(record: BudgetRecord): BudgetRecord {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const pruned: BudgetRecord = {};
  for (const [day, spent] of Object.entries(record)) {
    if (day >= cutoffStr) {
      pruned[day] = spent;
    }
  }
  return pruned;
}

/**
 * Return today's LLM spend (USD) for this run. Returns 0 when no record exists.
 */
export async function getReporterDailySpend(flowDir: string, runId: string): Promise<number> {
  const record = await atomicReadJSON<BudgetRecord>(budgetPath(flowDir, runId));
  if (!record) return 0;
  return record[todayUtc()] ?? 0;
}

/**
 * Append costUsd to today's spend for this run. Atomic write.
 */
export async function recordReporterSpend(flowDir: string, runId: string, costUsd: number): Promise<void> {
  const existing = (await atomicReadJSON<BudgetRecord>(budgetPath(flowDir, runId))) ?? {};
  const today = todayUtc();
  const updated: BudgetRecord = {
    ...existing,
    [today]: (existing[today] ?? 0) + costUsd,
  };
  await atomicWriteJSON(budgetPath(flowDir, runId), prunedRecord(updated));
}
