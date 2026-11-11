/**
 * src/cli/flow-metrics-compare.ts
 *
 * Side-by-side view of two flow-metrics reports (a recorded baseline vs a
 * replay of the same request). Used by scripts/bench/replay-tcis.ts; kept in
 * src so the row set is type-checked against the report shape and unit-tested.
 */

import type { FlowMetricsReport } from "./flow-metrics-aggregate.js";

export interface ComparisonRow {
  metric: string;
  baseline: number | string | null;
  replay: number | string | null;
  /** replay − baseline for numeric rows; null otherwise. */
  delta: number | null;
}

const overheadPurposes = ["preflight", "plan-edit", "council", "plan-review"] as const;

function share(r: FlowMetricsReport, purposes: readonly string[]): number {
  const n = purposes.reduce(
    (s, p) => s + (r.delegations.byPurpose[p as keyof typeof r.delegations.byPurpose]?.count ?? 0),
    0,
  );
  return r.delegations.total > 0 ? (n / r.delegations.total) * 100 : 0;
}

function verdictCount(m: Record<string, number>, key: string): number {
  return m[key] ?? 0;
}

export function compareFlowMetrics(baseline: FlowMetricsReport, replay: FlowMetricsReport): ComparisonRow[] {
  const pick: Array<[string, (r: FlowMetricsReport) => number | string | null]> = [
    ["hours to plan verified", (r) => r.timing.hoursToPlanVerified],
    ["hours to first implementation write", (r) => r.timing.hoursToFirstImplementationWrite],
    ["hours to final answer", (r) => r.timing.hoursToFinalAnswer],
    ["orchestrator turn hours (total)", (r) => r.activeHours.total],
    ["  plan-gate", (r) => r.activeHours.planGate],
    ["  preflight", (r) => r.activeHours.preflight],
    ["  implementation", (r) => r.activeHours.implementation],
    ["delegations", (r) => r.delegations.total],
    ["  implementation share %", (r) => share(r, ["implementation"])],
    ["  preflight+plan+council share %", (r) => share(r, overheadPurposes)],
    ["flow_plan_review calls", (r) => r.planReview.calls],
    ["council jobs", (r) => r.planReview.councilJobs],
    ["  council verdict=revise", (r) => verdictCount(r.planReview.councilVerdicts, "revise")],
    ["bookkeeping tool calls", (r) => r.bookkeeping.total],
    ["  bookkeeping % of tool calls", (r) => r.bookkeeping.pct],
    ["worker jobs not completed %", (r) => r.workers.failurePct],
    ["compactions", (r) => r.compactions.count],
    ["orchestrator cost $", (r) => r.cost.orchestrator.costUsd],
    ["worker cost $", (r) => r.cost.workers.costUsd],
    ["total cost $", (r) => r.cost.orchestrator.costUsd + r.cost.workers.costUsd],
    ["orchestrator input tokens", (r) => r.cost.orchestrator.inputTokens],
    ["orchestrator cache-read %", (r) => r.cost.orchestrator.cacheReadPct],
    [
      "final answer w/o recorded verify pass",
      (r) => {
        const v = r.completion.finalAnswerAfterImplementationWithoutRecordedPass;
        return v === null ? "n/a" : v ? "yes" : "no";
      },
    ],
  ];
  return pick.map(([metric, f]) => {
    const b = f(baseline);
    const r = f(replay);
    return { metric, baseline: b, replay: r, delta: typeof b === "number" && typeof r === "number" ? r - b : null };
  });
}

function cell(v: number | string | null): string {
  if (v === null) return "n/a";
  if (typeof v === "string") return v;
  return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(2);
}

export function formatComparison(rows: ComparisonRow[], labels = { baseline: "baseline", replay: "replay" }): string {
  const w = [40, 16, 16, 12];
  const line = (a: string, b: string, c: string, d: string) =>
    `${a.padEnd(w[0]!)}${b.padStart(w[1]!)}${c.padStart(w[2]!)}${d.padStart(w[3]!)}`;
  const out = [line("metric", labels.baseline, labels.replay, "delta"), "─".repeat(w.reduce((s, x) => s + x, 0))];
  for (const r of rows)
    out.push(
      line(
        r.metric,
        cell(r.baseline),
        cell(r.replay),
        r.delta === null ? "" : `${r.delta >= 0 ? "+" : ""}${cell(r.delta)}`,
      ),
    );
  return out.join("\n");
}
