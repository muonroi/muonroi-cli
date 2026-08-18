#!/usr/bin/env bun
/**
 * analyze-cost-leak.ts — flag cost leaks from the local muonroi.db.
 *
 * Evidence-first cost forensics. Reads ~/.muonroi-cli/muonroi.db (read-only) and
 * reports three leak classes the codebase is structurally vulnerable to:
 *
 *   1. UNBOUNDED TOOL LOOPS — a single user turn (session_id + message_seq)
 *      billed N LLM calls. Heuristic: N >= 15 calls or input grew >2x within
 *      the turn. Live evidence: session d0fbdd730b08 seq=4 logged 35 calls /
 *      2M tokens on a 29-byte user prompt.
 *
 *   2. TOKEN-INFLATION PER SESSION — input_tokens growing turn-over-turn
 *      without compaction cutting it back. Heuristic: max_in / min_in >= 3
 *      across the session's `source='message'` events.
 *
 *   3. ACCOUNTING LEAK — usage rows with cost_micros=0 for models that ARE
 *      priced (i.e. NOT subscription-billed). Subscription models (gpt-5.4,
 *      opencode/*) legitimately carry price=0; flag only priced models.
 *
 * Usage:
 *   bun run scripts/analyze-cost-leak.ts            # all three checks
 *   bun run scripts/analyze-cost-leak.ts --loops    # only tool-loop check
 *   bun run scripts/analyze-cost-leak.ts --inflation
 *   bun run scripts/analyze-cost-leak.ts --accounting
 *   bun run scripts/analyze-cost-leak.ts --since 7d # limit to last 7 days
 *
 * Exit code: 0 always (this is a report, not a gate). Pipe to grep/head as needed.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── CLI args ────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const sinceArg =
  process.argv.find((a) => a.startsWith("--since="))?.slice(8) ??
  process.argv.find((_, i, a) => a[i - 1] === "--since");
const only = args.size === 0 ? new Set(["--loops", "--inflation", "--accounting"]) : args;
const wantAll = only.size === 0 || only.has("--all");

const dbPath = process.env.MUONROI_DB ?? resolve(homedir(), ".muonroi-cli", "muonroi.db");
const db = new Database(dbPath, { readonly: true });

// `--since 7d` → cutoff ISO string. Accepts: 30m, 4h, 7d, 2w.
function sinceCutoff(input?: string): string | null {
  if (!input) return null;
  const m = /^(\d+)\s*([mhdw])$/.exec(input.trim().toLowerCase());
  if (!m) return null;
  const [, nStr, unit] = m;
  const n = Number(nStr);
  const ms =
    unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : unit === "d" ? n * 86_400_000 : n * 7 * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}
const cutoff = sinceCutoff(sinceArg);
const sinceClause = cutoff ? `AND created_at >= '${cutoff}'` : "";
const sinceLabel = cutoff ? `since ${cutoff.slice(0, 10)}` : "all-time";

type Row = Record<string, unknown>;
const q = (sql: string): Row[] => db.prepare(sql).all() as Row[];
const usd = (micros: number): string => (micros / 1e6).toFixed(4);

console.log(`# Cost-leak report — ${dbPath}`);
console.log(`# Window: ${sinceLabel}  |  DB: ${dbPath}`);
console.log("");

// ── Overall totals ──────────────────────────────────────────────────────────
const totals = q(`SELECT
  COUNT(*) AS events,
  COUNT(DISTINCT session_id) AS sessions,
  SUM(input_tokens) AS input_t,
  SUM(output_tokens) AS output_t,
  SUM(total_tokens) AS total_t,
  ROUND(SUM(cost_micros)/1e6, 4) AS usd
FROM usage_events WHERE 1=1 ${sinceClause}`)[0];
console.log("## Overall");
console.log(
  `  events=${totals.events}  sessions=${totals.sessions}  total_tokens=${totals.total_t}  cost=$${totals.usd}`,
);
console.log("");

// ── Check 1: unbounded tool loops ───────────────────────────────────────────
if (wantAll || only.has("--loops")) {
  console.log("## 1. Unbounded tool loops (single user turn with N LLM calls)");
  console.log("   Heuristic: ≥15 calls on one (session_id, message_seq) OR input grew >2x.");
  const loops = q(`
    SELECT session_id, message_seq, COUNT(*) AS calls,
      SUM(total_tokens) AS total_t,
      ROUND(SUM(cost_micros)/1e6, 4) AS usd,
      MIN(input_tokens) AS min_in,
      MAX(input_tokens) AS max_in,
      ROUND(1.0 * MAX(input_tokens) / NULLIF(MIN(input_tokens),0), 1) AS growth_x,
      MIN(created_at) AS first_at,
      MAX(created_at) AS last_at
    FROM usage_events
    WHERE source='message' AND message_seq IS NOT NULL ${sinceClause}
    GROUP BY session_id, message_seq
    HAVING calls >= 15 OR growth_x >= 3
    ORDER BY total_t DESC
    LIMIT 20`);
  if (loops.length === 0) {
    console.log("   ✓ none — every user turn stayed within bounds");
  } else {
    console.log("   session       seq  calls   total_t     $    min_in  max_in  grow  window");
    for (const r of loops) {
      const dur = (new Date(String(r.last_at)).getTime() - new Date(String(r.first_at)).getTime()) / 1000;
      console.log(
        `   ${String(r.session_id).slice(0, 12)}  ${String(r.message_seq).padStart(3)}  ${String(r.calls).padStart(5)}  ${String(r.total_t).padStart(8)}  ${String(r.usd).padStart(6)}  ${String(r.min_in).padStart(7)} ${String(r.max_in).padStart(7)}  ${String(r.growth_x).padStart(4)}x  ${dur.toFixed(0)}s`,
      );
    }
  }
  console.log("");
}

// ── Check 2: token inflation per session ────────────────────────────────────
if (wantAll || only.has("--inflation")) {
  console.log("## 2. Token-inflation per session (input grew turn-over-turn)");
  console.log("   Heuristic: source='message' rows where max_in / min_in >= 3 across ≥3 turns.");
  const infl = q(`
    SELECT session_id, COUNT(*) AS turns,
      MIN(input_tokens) AS min_in, MAX(input_tokens) AS max_in,
      ROUND(AVG(input_tokens)) AS avg_in,
      ROUND(1.0 * MAX(input_tokens) / NULLIF(MIN(input_tokens),0), 1) AS growth_x
    FROM usage_events
    WHERE source='message' ${sinceClause}
    GROUP BY session_id
    HAVING turns >= 3 AND growth_x >= 3
    ORDER BY growth_x DESC
    LIMIT 15`);
  if (infl.length === 0) {
    console.log("   ✓ none — input stayed bounded across turns");
  } else {
    console.log("   session         turns   min_in   max_in   avg_in   grow");
    for (const r of infl) {
      console.log(
        `   ${String(r.session_id).slice(0, 12).padEnd(14)}  ${String(r.turns).padStart(5)}  ${String(r.min_in).padStart(7)}  ${String(r.max_in).padStart(7)}  ${String(r.avg_in).padStart(7)}  ${String(r.growth_x).padStart(5)}x`,
      );
    }
  }
  console.log("");
}

// ── Check 3: accounting leak (priced models with cost=0) ─────────────────────
if (wantAll || only.has("--accounting")) {
  console.log("## 3. Accounting leak (priced models with cost_micros=0)");
  console.log("   Flags models whose catalog entry carries a non-zero price yet recorded $0.");
  console.log("   Subscription models (gpt-5.4, opencode/*) legitimately cost $0 — excluded.");
  const acct = q(`
    SELECT model, COUNT(*) AS events,
      SUM(input_tokens) AS input_t,
      SUM(output_tokens) AS output_t,
      SUM(cost_micros) AS micros
    FROM usage_events
    WHERE 1=1 ${sinceClause}
    GROUP BY model
    HAVING micros = 0 AND SUM(input_tokens) > 0
    ORDER BY input_t DESC`);
  if (acct.length === 0) {
    console.log("   ✓ none — every billed model has a non-zero cost recorded");
  } else {
    // Subscription-billed: model resolves to a catalog entry with price=0 by design.
    const SUBSCRIPTION_HINTS = /^(gpt-5|opencode\/|chatgpt)/i;
    console.log("   model                            events   input_t   output_t   likely_subscription");
    for (const r of acct) {
      const isSub = SUBSCRIPTION_HINTS.test(String(r.model));
      console.log(
        `   ${String(r.model).padEnd(30)}  ${String(r.events).padStart(6)}  ${String(r.input_t).padStart(8)}  ${String(r.output_t).padStart(9)}   ${isSub ? "yes (ok)" : "?? INVESTIGATE"}`,
      );
    }
    console.log("");
    console.log("   NOTE: subscription models cost $0 by design. Investigate rows flagged ?? above.");
  }
  console.log("");
}

// ── Cache efficiency bonus ──────────────────────────────────────────────────
if (wantAll || only.has("--cache")) {
  console.log("## Bonus: cache efficiency per model");
  console.log("   Low hit% with high input_t = paying full price repeatedly (cache not warming).");
  const cache = q(`
    SELECT model,
      SUM(input_tokens) AS input_t,
      SUM(cache_read_tokens) AS cache_read_t,
      ROUND(100.0 * SUM(cache_read_tokens) / NULLIF(SUM(input_tokens),0), 1) AS hit_pct
    FROM usage_events
    WHERE 1=1 ${sinceClause}
    GROUP BY model HAVING input_t > 10000
    ORDER BY hit_pct ASC`);
  console.log("   model                            input_t   cache_read   hit%");
  for (const r of cache) {
    console.log(
      `   ${String(r.model).padEnd(30)}  ${String(r.input_t).padStart(8)}  ${String(r.cache_read_t).padStart(11)}  ${String(r.hit_pct).padStart(5)}%`,
    );
  }
  console.log("");
}

db.close();
