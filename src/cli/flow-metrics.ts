/**
 * src/cli/flow-metrics.ts
 *
 * `muonroi-cli usage flow-metrics <session-id-prefix...> [--json]` — the
 * orchestrator-efficiency ruler. For one conversation (plus every linked
 * child session and every background worker job it dispatched) it reports
 * how long it took to reach the first implementation write, where the
 * delegations went, how many plan-review rounds and verdicts there were, how
 * much of the loop was bookkeeping, how workers failed, compaction load, the
 * orchestrator-vs-worker cost split, and whether a completion was claimed
 * without a recorded passing verification.
 *
 * Read-only by construction: the session DB is opened with SQLite's
 * read-only flag (no migrations, no WAL checkpoint writes from us), and the
 * delegation records + cost log are only read. Classification rules live in
 * `flow-metrics-classify.ts`; the arithmetic in `flow-metrics-aggregate.ts`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { CostLogEntry } from "../usage/cost-log.js";
import { logger } from "../utils/logger.js";
import { extractStructuredVerdict } from "../workflow/verdict-schema.js";
import {
  aggregateFlowMetrics,
  type FlowMetricsInput,
  type FlowMetricsReport,
  type FmCallAccounting,
  type FmCompaction,
  type FmCostRow,
  type FmDelegation,
  type FmSession,
  type FmToolCall,
  type FmUsageEvent,
  type FmWindow,
  type FmWrite,
  type TokenTotals,
} from "./flow-metrics-aggregate.js";
import { DELEGATION_PURPOSES, FILE_WRITE_TOOLS, writeTargetOf } from "./flow-metrics-classify.js";

// ---------------------------------------------------------------------------
// Read-only SQLite
// ---------------------------------------------------------------------------

interface RoStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface RoDatabase {
  prepare(sql: string): RoStatement;
  close(): void;
}

const requireSync = createRequire(import.meta.url);

/** Open the session DB read-only (bun:sqlite under Bun, better-sqlite3 under Node). */
export function openReadOnlyDatabase(file: string): RoDatabase {
  if (!existsSync(file)) throw new Error(`Session database not found: ${file}`);
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { Database } = requireSync("bun:sqlite") as {
      Database: new (
        f: string,
        o: { readonly: boolean },
      ) => {
        query(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new Database(file, { readonly: true });
    return {
      prepare: (sql) => {
        const q = db.query(sql);
        return { all: (...p) => q.all(...p), get: (...p) => q.get(...p) ?? undefined };
      },
      close: () => db.close(),
    };
  }
  const BetterSqlite3 = requireSync("better-sqlite3") as new (
    f: string,
    o: { readonly: boolean; fileMustExist: boolean },
  ) => RoDatabase;
  return new BetterSqlite3(file, { readonly: true, fileMustExist: true });
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface FlowMetricsOptions {
  /** muonroi home holding `delegations/` and `usage/` (default ~/.muonroi-cli). */
  home?: string;
  /** Session DB path (default `<home>/muonroi.db`). */
  db?: string;
  /** Narrow what counts as an implementation file, e.g. [".cs"]. */
  implExtensions?: string[];
}

export function resolveHome(opts: FlowMetricsOptions): string {
  return opts.home ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

export function resolveSessionPrefix(db: RoDatabase, prefix: string): string[] {
  return (
    db.prepare(`SELECT id FROM sessions WHERE id LIKE ? ORDER BY created_at DESC LIMIT 5`).all(`${prefix}%`) as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}

function sessionChain(db: RoDatabase, sessionId: string): FmSession[] {
  const root =
    (
      db
        .prepare(`
      WITH RECURSIVE up(id, parent) AS (
        SELECT id, parent_session_id FROM sessions WHERE id = ?
        UNION SELECT s.id, s.parent_session_id FROM sessions s JOIN up ON s.id = up.parent
      ) SELECT id FROM up WHERE parent IS NULL LIMIT 1`)
        .get(sessionId) as { id: string } | undefined
    )?.id ?? sessionId;
  return (
    db
      .prepare(`
      WITH RECURSIVE down(id) AS (
        SELECT ?
        UNION SELECT s.id FROM sessions s JOIN down ON s.parent_session_id = down.id
      )
      SELECT s.id AS id, s.parent_session_id AS parentSessionId, s.kind AS kind, s.created_at AS createdAt
      FROM sessions s JOIN down ON s.id = down.id ORDER BY s.created_at ASC`)
      .all(root) as FmSession[]
  ).map((s) => ({ ...s, kind: s.kind ?? "conversation" }));
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

function isInternalUserMessage(messageJson: string): boolean {
  try {
    const m = JSON.parse(messageJson) as { providerOptions?: { muonroi?: { internalActivity?: unknown } } };
    return m.providerOptions?.muonroi?.internalActivity === true;
  } catch (err) {
    logger.warn("cli", "flow-metrics: unparseable user message row; counted as human", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Tools whose result payload the aggregator reads; other outputs are not loaded. */
const OUTPUT_TOOLS = ["flow_plan_review", "flow_verify", "context_load", "write_file", "edit_file"];

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    logger.warn("cli", "flow-metrics: unreadable JSON file skipped", {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface RawDelegation {
  id?: string;
  agent?: string;
  kind?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  failureKind?: string;
  parentSessionId?: string;
  council?: unknown;
  planReview?: unknown;
  planRevalidation?: unknown;
  reviewOf?: unknown;
  hostReview?: { verdict?: { verdict?: unknown } };
  outputPath?: string;
  toolArtifacts?: Array<{ toolName: string; fileName: string; capturedAt: string }>;
}

/** Every top-level job record under `<home>/delegations/<project>/`. */
function listDelegationRecords(home: string): Array<{ file: string; record: RawDelegation }> {
  const root = path.join(home, "delegations");
  if (!existsSync(root)) return [];
  const out: Array<{ file: string; record: RawDelegation }> = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const record = readJsonFile<RawDelegation>(path.join(dir, name));
      if (record?.id && record.startedAt) out.push({ file: path.join(dir, name), record });
    }
  }
  return out;
}

function loadWrites(file: string, record: RawDelegation): FmWrite[] {
  const toolsDir = file.replace(/\.json$/, ".tools");
  const writes: FmWrite[] = [];
  for (const a of record.toolArtifacts ?? []) {
    if (!FILE_WRITE_TOOLS.has(a.toolName)) continue;
    const artifact = readJsonFile<{ input?: unknown; output?: unknown }>(path.join(toolsDir, a.fileName));
    const output = artifact?.output;
    const success =
      output && typeof output === "object" && typeof (output as { success?: unknown }).success === "boolean"
        ? (output as { success: boolean }).success
        : null;
    writes.push({ tool: a.toolName, path: writeTargetOf(artifact?.input), success, at: a.capturedAt });
  }
  return writes;
}

function councilVerdictOf(file: string, record: RawDelegation): string | null {
  const local = file.replace(/\.json$/, ".md");
  const mdPath = existsSync(local) ? local : record.outputPath;
  if (!mdPath || !existsSync(mdPath)) return null;
  const text = readFileSync(mdPath, "utf8");
  // Same body boundary the host uses when it admits a council verdict.
  const marker = text.indexOf("\n---\n");
  const body = marker >= 0 ? text.slice(marker + 5) : text;
  return extractStructuredVerdict(body)?.verdict ?? null;
}

function toDelegation(file: string, record: RawDelegation): FmDelegation {
  const isCouncil = record.kind === "council" || Boolean(record.council);
  const hostVerdict = record.hostReview?.verdict?.verdict;
  return {
    id: record.id!,
    parentSessionId: record.parentSessionId ?? "",
    agent: record.agent ?? "unknown",
    kind: record.kind,
    status: record.status ?? "unknown",
    startedAt: record.startedAt!,
    completedAt: record.completedAt,
    error: record.error,
    failureKind: record.failureKind,
    hasCouncil: Boolean(record.council),
    hasPlanReview: Boolean(record.planReview),
    hasPlanRevalidation: Boolean(record.planRevalidation),
    hasReviewOf: Boolean(record.reviewOf || record.hostReview),
    councilVerdict: isCouncil ? councilVerdictOf(file, record) : undefined,
    revalidationVerdict: record.planRevalidation ? (typeof hostVerdict === "string" ? hostVerdict : null) : undefined,
    writes: loadWrites(file, record),
  };
}

/**
 * Read one day of the cost log, skipping (and counting) malformed lines — a
 * line torn by a concurrent append must not abort the whole report.
 */
function readCostLogDay(home: string, day: string): CostLogEntry[] {
  const file = path.join(home, "usage", `cost-log-${day}.jsonl`);
  if (!existsSync(file)) return [];
  const out: CostLogEntry[] = [];
  let bad = 0;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CostLogEntry);
    } catch (err) {
      bad += 1;
      if (bad === 1)
        logger.warn("cli", "flow-metrics: malformed cost-log line skipped", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
    }
  }
  if (bad > 1) logger.warn("cli", "flow-metrics: malformed cost-log lines skipped", { file, count: bad });
  return out;
}

function utcDays(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  const d = new Date(
    Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), new Date(fromMs).getUTCDate()),
  );
  for (; d.getTime() <= toMs; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  return days;
}

export async function collectFlowMetricsInput(
  db: RoDatabase,
  sessionId: string,
  opts: FlowMetricsOptions = {},
): Promise<FlowMetricsInput> {
  const home = resolveHome(opts);
  const sessions = sessionChain(db, sessionId);
  if (sessions.length === 0) throw new Error(`Session not found: ${sessionId}`);
  const ids = sessions.map((s) => s.id);
  const ph = placeholders(ids.length);

  const cwd =
    (db.prepare(`SELECT cwd_at_start AS cwd FROM sessions WHERE id = ?`).get(sessions[0]!.id) as { cwd: string })
      ?.cwd ?? "";

  const userRows = db
    .prepare(
      `SELECT message_json AS mj, created_at AS at FROM messages WHERE session_id IN (${ph}) AND role = 'user' ORDER BY created_at ASC`,
    )
    .all(...ids) as Array<{ mj: string; at: string }>;
  let firstHumanMessageAt: string | null = null;
  let humanPrompts = 0;
  let internalWakeups = 0;
  for (const r of userRows) {
    if (isInternalUserMessage(r.mj)) internalWakeups += 1;
    else {
      humanPrompts += 1;
      firstHumanMessageAt ??= r.at;
    }
  }
  const lastAssistantAt =
    (
      db
        .prepare(`SELECT MAX(created_at) AS at FROM messages WHERE session_id IN (${ph}) AND role = 'assistant'`)
        .get(...ids) as { at: string | null } | undefined
    )?.at ?? null;

  const turns = db
    .prepare(
      `SELECT created_at AS endAt, duration_ms AS durationMs FROM interaction_logs WHERE session_id IN (${ph}) AND event_type = 'agent_response' AND duration_ms IS NOT NULL`,
    )
    .all(...ids) as Array<{ endAt: string; durationMs: number }>;

  const toolCalls = (
    db
      .prepare(`
      SELECT tc.session_id AS sessionId, tc.tool_name AS name, tc.args_json AS argsJson, tc.started_at AS startedAt,
             tr.success AS success,
             CASE WHEN tc.tool_name IN (${placeholders(OUTPUT_TOOLS.length)}) THEN tr.output_json END AS outputJson
      FROM tool_calls tc LEFT JOIN tool_results tr ON tr.tool_call_row_id = tc.id
      WHERE tc.session_id IN (${ph}) ORDER BY tc.id ASC`)
      .all(...OUTPUT_TOOLS, ...ids) as Array<Omit<FmToolCall, "success"> & { success: number | null }>
  ).map((c) => ({ ...c, success: c.success === null || c.success === undefined ? null : c.success === 1 }));

  const usageEvents = db
    .prepare(`
      SELECT session_id AS sessionId, source, model, input_tokens AS inputTokens, output_tokens AS outputTokens,
             cache_read_tokens AS cacheReadTokens, cost_micros AS costMicros, created_at AS createdAt
      FROM usage_events WHERE session_id IN (${ph}) ORDER BY id ASC`)
    .all(...ids) as FmUsageEvent[];

  const compactions = db
    .prepare(
      `SELECT session_id AS sessionId, tokens_before AS tokensBefore, created_at AS createdAt FROM compactions WHERE session_id IN (${ph})`,
    )
    .all(...ids) as FmCompaction[];

  const callAccounting: FmCallAccounting[] = [];
  for (const row of db
    .prepare(
      `SELECT event_subtype AS stage, input_tokens AS est, metadata_json AS meta FROM interaction_logs WHERE session_id IN (${ph}) AND event_type = 'call_accounting'`,
    )
    .all(...ids) as Array<{ stage: string | null; est: number | null; meta: string | null }>) {
    let meta: { bySegment?: { system?: number; history?: number; toolResults?: number }; throwHit?: boolean } = {};
    try {
      meta = row.meta ? JSON.parse(row.meta) : {};
    } catch (err) {
      logger.warn("cli", "flow-metrics: malformed call_accounting metadata; segments counted as 0", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    callAccounting.push({
      stage: row.stage ?? "unattributed",
      estInputTokens: row.est ?? 0,
      system: meta.bySegment?.system ?? 0,
      history: meta.bySegment?.history ?? 0,
      toolResults: meta.bySegment?.toolResults ?? 0,
      throwHit: meta.throwHit === true,
    });
  }

  // Delegations: this chain's jobs + everyone else's windows (attribution ambiguity).
  const idSet = new Set(ids);
  const all = listDelegationRecords(home);
  const delegations = all
    .filter(({ record }) => record.parentSessionId && idSet.has(record.parentSessionId))
    .map(({ file, record }) => toDelegation(file, record));

  const times = [
    ...sessions.map((s) => Date.parse(s.createdAt)),
    ...delegations.flatMap((d) => [Date.parse(d.startedAt), Date.parse(d.completedAt ?? d.startedAt)]),
    ...usageEvents.map((e) => Date.parse(e.createdAt)),
  ].filter(Number.isFinite);
  const pad = 15 * 60 * 1000;
  const fromMs = Math.min(...times) - pad;
  const toMs = Math.max(...times) + pad;

  const foreignWindows: FmWindow[] = all
    .filter(({ record }) => !record.parentSessionId || !idSet.has(record.parentSessionId))
    .map(({ record }) => ({
      parentSessionId: record.parentSessionId ?? "",
      start: Date.parse(record.startedAt!),
      end: Date.parse(record.completedAt ?? record.startedAt!),
    }))
    .filter((w) => Number.isFinite(w.start) && w.end >= fromMs && w.start <= toMs);

  const usageEventsInRange = db
    .prepare(
      `SELECT model, input_tokens AS inputTokens, created_at AS createdAt FROM usage_events WHERE created_at >= ? AND created_at <= ?`,
    )
    .all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as FlowMetricsInput["usageEventsInRange"];

  const costRows: FmCostRow[] = [];
  for (const day of utcDays(fromMs, toMs)) {
    for (const e of readCostLogDay(home, day)) {
      if (e.ts < fromMs || e.ts > toMs) continue;
      const tagged = e as typeof e & { parentSessionId?: string; delegationId?: string };
      costRows.push({
        ts: e.ts,
        model: e.model,
        callsite: e.callsite ?? "unknown",
        usd: e.estimatedUsd ?? 0,
        inputTokens: e.actualInputTokens ?? 0,
        cachedInputTokens: e.cachedInputTokens ?? 0,
        outputTokens: e.actualOutputTokens ?? 0,
        parentSessionId: tagged.parentSessionId,
        delegationId: tagged.delegationId,
      });
    }
  }

  return {
    sessionId,
    cwd,
    sessions,
    firstHumanMessageAt,
    lastAssistantAt,
    turns,
    humanPrompts,
    internalWakeups,
    toolCalls,
    usageEvents,
    compactions,
    callAccounting,
    delegations,
    costRows,
    usageEventsInRange,
    foreignWindows,
    implExtensions: opts.implExtensions,
  };
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

const n = (v: number): string => Math.round(v).toLocaleString("en-US");
const p1 = (v: number): string => `${v.toFixed(1)}%`;
const h1 = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(1)}h`);
const usd = (v: number): string => `$${v.toFixed(2)}`;
const kv = (m: Record<string, number>): string =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "none";

function totalsLine(t: TokenTotals): string {
  return `${usd(t.costUsd)} · ${n(t.inputTokens)} in · ${n(t.outputTokens)} out · cache-read ${p1(t.cacheReadPct)} · ${n(t.calls)} calls`;
}

export function formatFlowMetrics(r: FlowMetricsReport): string {
  const lines: string[] = [];
  const w = (s = "") => lines.push(s);
  w(`Flow metrics — session ${r.sessionId}`);
  w("─".repeat(72));
  w(`cwd:                 ${r.cwd}`);
  w(`sessions:            ${r.sessions.map((s) => `${s.id}(${s.kind})`).join(", ")}`);
  w(`human prompts:       ${r.timing.humanPrompts} (+${r.timing.internalWakeups} background wake-ups)`);
  w();
  w("Timing (from first human prompt)");
  w(`  request:                   ${r.timing.requestAt ?? "n/a"}`);
  w(`  plan verified:             ${r.timing.planVerifiedAt ?? "never"} (${h1(r.timing.hoursToPlanVerified)})`);
  w(`  first file write:          ${r.timing.firstFileWriteAt ?? "none"} (${h1(r.timing.hoursToFirstFileWrite)})`);
  w(
    `  first implementation write: ${r.timing.firstImplementationWriteAt ?? "none"} (${h1(r.timing.hoursToFirstImplementationWrite)})` +
      (r.timing.firstImplementationPath ? ` ${r.timing.firstImplementationPath}` : ""),
  );
  w(`  final answer:              ${r.timing.finalAnswerAt ?? "n/a"} (${h1(r.timing.hoursToFinalAnswer)})`);
  const a0 = r.activeHours;
  w(
    `  orchestrator turn time:    ${h1(a0.total)} = plan-gate ${h1(a0.planGate)} + preflight ${h1(a0.preflight)} + implementation ${h1(a0.implementation)}`,
  );
  w();
  w(`Delegations: ${r.delegations.total} jobs (${r.delegations.dispatchToolCalls} task/delegate dispatch calls)`);
  w(`  ${"purpose".padEnd(16)}${"jobs".padStart(6)}${"share".padStart(8)}${"worker-h".padStart(10)}`);
  for (const p of DELEGATION_PURPOSES) {
    const b = r.delegations.byPurpose[p];
    if (b.count === 0) continue;
    w(
      `  ${p.padEnd(16)}${String(b.count).padStart(6)}${p1(b.pct).padStart(8)}${b.workerHours.toFixed(1).padStart(10)}`,
    );
  }
  w();
  w(`Plan review: ${r.planReview.calls} flow_plan_review calls`);
  w(`  by action:   ${kv(r.planReview.byAction)}`);
  w(`  by outcome:  ${kv(r.planReview.byOutcome)}`);
  w(`  refusals:    ${kv(r.planReview.refusalReasons)}`);
  w(`  recorded round verdicts: ${kv(r.planReview.recordedVerdicts)}`);
  w(`  council jobs ${r.planReview.councilJobs}: verdicts ${kv(r.planReview.councilVerdicts)}`);
  w(`  revalidation jobs ${r.planReview.revalidationJobs}: verdicts ${kv(r.planReview.revalidationVerdicts)}`);
  w();
  w(
    `Bookkeeping tool calls: ${r.bookkeeping.total} of ${r.bookkeeping.totalToolCalls} orchestrator tool calls (${p1(r.bookkeeping.pct)})`,
  );
  w(`  ${kv(r.bookkeeping.byTool)}`);
  w();
  w(
    `Worker jobs: ${r.workers.total} — complete ${r.workers.complete}, error ${r.workers.failed}, cancelled ${r.workers.cancelled}` +
      `${r.workers.running ? `, running ${r.workers.running}` : ""} (${p1(r.workers.failurePct)} not completed)`,
  );
  w(`  failure categories: ${kv(r.workers.byFailureCategory)}`);
  w();
  w(
    `Compactions: ${r.compactions.count} (tokens before: total ${n(r.compactions.tokensBeforeTotal)}, max ${n(r.compactions.tokensBeforeMax)})`,
  );
  w();
  w("Cost");
  w(`  orchestrator: ${totalsLine(r.cost.orchestrator)}`);
  for (const [src, t] of Object.entries(r.cost.orchestrator.bySource)) w(`    ${src.padEnd(12)} ${totalsLine(t)}`);
  const a = r.cost.workers.attribution;
  w(`  workers:      ${totalsLine(r.cost.workers)}`);
  for (const [cs, t] of Object.entries(r.cost.workers.byCallsite)) w(`    ${cs.padEnd(26)} ${totalsLine(t)}`);
  w(
    `    attribution: ${a.exactRows} tagged rows, ${a.windowRows} by job window` +
      (a.ambiguousRows ? `, ${a.ambiguousRows} ambiguous rows (${usd(a.ambiguousUsd)}) excluded` : "") +
      (a.duplicateCompactionRows ? `; ${a.duplicateCompactionRows} double-logged compaction rows collapsed` : ""),
  );
  const ca = Object.entries(r.cost.callAccounting);
  if (ca.length) {
    w("  call_accounting (est tokens; real ≈ 2× est):");
    for (const [stage, s] of ca)
      w(
        `    ${stage.padEnd(12)} calls=${s.calls} est=${n(s.estInputTokens)} peak=${n(s.peakEst)} sys=${p1(s.sysPct)} hist=${p1(s.histPct)} tool=${p1(s.toolPct)} throwHits=${s.throwHits}`,
      );
  }
  w();
  const c = r.completion;
  w("Completion vs verification");
  w(`  flow_verify: ${c.flowVerifyCalls} calls (${c.flowVerifyPasses} pass, ${c.flowVerifyFails} fail)`);
  w(
    `  structured root_status=complete claims: ${c.structuredCompleteClaims} (${c.refusedCompleteClaims} refused, ${c.acceptedCompleteClaimsWithoutRecordedPass} accepted without a recorded pass)`,
  );
  w(
    `  final answer after implementation with no recorded verify pass: ${
      c.finalAnswerAfterImplementationWithoutRecordedPass === null
        ? "n/a"
        : c.finalAnswerAfterImplementationWithoutRecordedPass
          ? "YES"
          : "no"
    }`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function computeFlowMetrics(prefix: string, opts: FlowMetricsOptions = {}): Promise<FlowMetricsReport> {
  const dbPath = opts.db ?? path.join(resolveHome(opts), "muonroi.db");
  const db = openReadOnlyDatabase(dbPath);
  try {
    const matches = resolveSessionPrefix(db, prefix);
    if (matches.length === 0) throw new Error(`No session matches prefix '${prefix}' in ${dbPath}`);
    if (matches.length > 1) throw new Error(`Ambiguous prefix '${prefix}': ${matches.join(", ")}`);
    return aggregateFlowMetrics(await collectFlowMetricsInput(db, matches[0]!, opts));
  } finally {
    db.close();
  }
}

export async function runFlowMetrics(prefixes: string[], opts: FlowMetricsOptions & { json?: boolean }): Promise<void> {
  const reports: FlowMetricsReport[] = [];
  for (const prefix of prefixes) {
    try {
      reports.push(await computeFlowMetrics(prefix, opts));
    } catch (err) {
      process.stderr.write(`flow-metrics: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${reports.map(formatFlowMetrics).join("\n\n")}\n`);
}
