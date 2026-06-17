/**
 * src/cli/experience-report.ts
 *
 * `muonroi-cli usage experience` — cross-session anti-mù telemetry. Aggregates
 * the per-session session_experience snapshots to answer the measure-before-
 * re-architecting question: how often does compaction actually elide a tool
 * output, and when the agent goes back for one, can it recover it?
 *
 * This is the data gate for the deferred anti-mù re-architecture (auto-protect /
 * auto-rehydrate). Low elision rate or high recovery rate ⇒ the friction is rare
 * or cognitive, not data-loss ⇒ defer. High unavailable / low recovery ⇒ real
 * loss ⇒ justified.
 */

import { aggregateSessionExperience, type ExperienceAggregate } from "../storage/session-experience-store.js";

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—";
}
function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** Pure renderer — returns the report lines so it is unit-testable without a DB. */
export function renderExperienceAggregate(agg: ExperienceAggregate, limit: number): string[] {
  const t = agg.totals;
  const rehydrated = t.rehydratedCache + t.rehydratedDisk + t.rehydratedEe;
  const out: string[] = [];
  out.push("");
  out.push(`Session-experience aggregate — latest ${agg.sessionCount} session(s) with a snapshot (cap ${limit})`);
  out.push("─".repeat(72));

  if (agg.sessionCount === 0) {
    out.push("No session_experience snapshots recorded yet.");
    out.push("Run some real (non-meta) sessions, then re-check — compaction only");
    out.push("persists a snapshot once it actually elides / rehydrates something.");
    return out;
  }

  out.push(
    `Sessions with compaction elision:   ${agg.sessionsWithElision} (${pct(agg.sessionsWithElision, agg.sessionCount)})`,
  );
  out.push(
    `Sessions hitting needed-but-unavail: ${agg.sessionsWithUnavailable} (${pct(agg.sessionsWithUnavailable, agg.sessionCount)})`,
  );
  out.push("");
  out.push("Totals across those sessions:");
  out.push(`  Compactions fired:       ${num(t.compactions)}`);
  out.push(`  Tool outputs elided:     ${num(t.elided)} (${num(t.totalElidedChars)} chars)`);
  out.push(
    `  Rehydrated via ee_query: ${num(rehydrated)} (cache=${t.rehydratedCache} disk=${t.rehydratedDisk} ee=${t.rehydratedEe})`,
  );
  out.push(`  Needed-but-unavailable:  ${num(t.unavailable)}`);
  out.push(`  EE timeouts / errors:    ${num(t.eeTimeouts)} / ${num(t.eeErrors)}`);
  out.push("");
  out.push(
    `Rehydrate recovery rate: ${(agg.rehydrateRecoveryRate * 100).toFixed(0)}%  (rehydrated / (rehydrated + unavailable))`,
  );
  out.push("");

  // Decision signal for the deferred re-architecture.
  out.push("Re-architecture decision signal:");
  if (t.elided === 0) {
    out.push("  • Compaction has not elided anything — friction is not occurring. DEFER.");
  } else {
    const elisionRate = agg.sessionsWithElision / agg.sessionCount;
    if (elisionRate < 0.2) {
      out.push(
        `  • Elision bites in only ${pct(agg.sessionsWithElision, agg.sessionCount)} of sessions — rare. Likely DEFER.`,
      );
    }
    if (agg.rehydrateRecoveryRate >= 0.9 || t.unavailable === 0) {
      out.push(
        "  • Recovery rate high / no unavailable — manual rehydrate works; friction is cognitive, not data-loss. Manifest+keepLast likely enough.",
      );
    } else {
      out.push(
        `  • Recovery rate ${(agg.rehydrateRecoveryRate * 100).toFixed(0)}% with ${num(t.unavailable)} unrecoverable — real data loss. Auto-protect/auto-rehydrate JUSTIFIED.`,
      );
    }
  }
  return out;
}

export async function runExperienceReport(opts: { limit?: number; json?: boolean } = {}): Promise<void> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
  const agg = aggregateSessionExperience(limit);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(agg, null, 2)}\n`);
    return;
  }
  for (const line of renderExperienceAggregate(agg, limit)) process.stdout.write(`${line}\n`);
}
