/**
 * src/cli/flow-metrics-aggregate.ts
 *
 * Pure aggregation for `muonroi-cli usage flow-metrics`: takes rows already
 * read from the session DB, the delegation job records and the cost log, and
 * turns them into one efficiency report. No I/O here — the collector in
 * `flow-metrics.ts` does the reading, so every number below is reproducible
 * from fixtures in the unit tests.
 */

import { logger } from "../utils/logger.js";
import {
  BOOKKEEPING_TOOLS,
  classifyDelegationPurpose,
  classifyPath,
  classifyPlanReviewCall,
  classifyWorkerFailure,
  DELEGATION_PURPOSES,
  type DelegationPurpose,
  DISPATCH_TOOLS,
  FILE_WRITE_TOOLS,
  type PathKind,
  writeTargetOf,
} from "./flow-metrics-classify.js";

// ---------------------------------------------------------------------------
// Input rows
// ---------------------------------------------------------------------------

export interface FmSession {
  id: string;
  parentSessionId: string | null;
  kind: string;
  createdAt: string;
}

export interface FmToolCall {
  sessionId: string;
  name: string;
  argsJson: string | null;
  startedAt: string;
  /** tool_results.success; null when no result row was recorded. */
  success: boolean | null;
  outputJson: string | null;
}

export interface FmUsageEvent {
  sessionId: string;
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costMicros: number;
  createdAt: string;
}

export interface FmCompaction {
  sessionId: string;
  tokensBefore: number;
  createdAt: string;
}

export interface FmCallAccounting {
  stage: string;
  estInputTokens: number;
  system: number;
  history: number;
  toolResults: number;
  throwHit: boolean;
}

export interface FmWrite {
  tool: string;
  path?: string;
  /** Recorded tool outcome; null when the output carried no success flag. */
  success: boolean | null;
  at: string;
}

export interface FmDelegation {
  id: string;
  parentSessionId: string;
  agent: string;
  kind?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  failureKind?: string;
  hasCouncil: boolean;
  hasPlanReview: boolean;
  hasPlanRevalidation: boolean;
  hasReviewOf: boolean;
  /** Council jobs: the structured council verdict; null = no valid verdict block. */
  councilVerdict?: string | null;
  /** Plan-revalidation jobs: the host review verdict (pass/fail). */
  revalidationVerdict?: string | null;
  writes: FmWrite[];
}

export interface FmCostRow {
  ts: number;
  model: string;
  callsite: string;
  usd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Present on rows written by a worker process after attribution tagging landed. */
  parentSessionId?: string;
  delegationId?: string;
}

/** A delegation job's lifetime, used to attribute untagged worker cost rows. */
export interface FmWindow {
  parentSessionId: string;
  start: number;
  end: number;
}

export interface FlowMetricsInput {
  sessionId: string;
  cwd: string;
  sessions: FmSession[];
  firstHumanMessageAt: string | null;
  lastAssistantAt: string | null;
  /** Orchestrator turns: when each agent response ended and how long it ran. */
  turns: Array<{ endAt: string; durationMs: number }>;
  humanPrompts: number;
  internalWakeups: number;
  toolCalls: FmToolCall[];
  usageEvents: FmUsageEvent[];
  compactions: FmCompaction[];
  callAccounting: FmCallAccounting[];
  delegations: FmDelegation[];
  /** Cost-log rows covering the session's time range (every process). */
  costRows: FmCostRow[];
  /** usage_events of ALL sessions in that range — rows the main processes already billed. */
  usageEventsInRange: Array<{ model: string; inputTokens: number; createdAt: string }>;
  /** Delegation windows of OTHER sessions overlapping the range (ambiguity detection). */
  foreignWindows: FmWindow[];
  /** Narrow the implementation extensions (e.g. [".cs"]). */
  implExtensions?: string[];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface TokenTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheReadPct: number;
  costUsd: number;
}

export interface FlowMetricsReport {
  sessionId: string;
  cwd: string;
  sessions: Array<{ id: string; kind: string }>;
  timing: {
    requestAt: string | null;
    firstFileWriteAt: string | null;
    firstImplementationWriteAt: string | null;
    firstImplementationPath: string | null;
    /** First flow_plan_review round the host marked planVerified (plan gate passed). */
    planVerifiedAt: string | null;
    hoursToPlanVerified: number | null;
    finalAnswerAt: string | null;
    hoursToFirstFileWrite: number | null;
    hoursToFirstImplementationWrite: number | null;
    hoursToFinalAnswer: number | null;
    humanPrompts: number;
    internalWakeups: number;
  };
  delegations: {
    total: number;
    dispatchToolCalls: number;
    byPurpose: Record<DelegationPurpose, { count: number; pct: number; workerHours: number }>;
    jobs: Array<{ id: string; purpose: DelegationPurpose; status: string; startedAt: string; hours: number }>;
  };
  planReview: {
    calls: number;
    byAction: Record<string, number>;
    byOutcome: Record<string, number>;
    /** Verdicts of rounds the host recorded (completed outcome). */
    recordedVerdicts: Record<string, number>;
    refusalReasons: Record<string, number>;
    councilJobs: number;
    councilVerdicts: Record<string, number>;
    revalidationJobs: number;
    revalidationVerdicts: Record<string, number>;
  };
  /** Orchestrator turn time (sum of agent_response durations) split by phase. */
  activeHours: { total: number; planGate: number; preflight: number; implementation: number };
  bookkeeping: { total: number; totalToolCalls: number; pct: number; byTool: Record<string, number> };
  workers: {
    total: number;
    complete: number;
    failed: number;
    cancelled: number;
    running: number;
    failurePct: number;
    byFailureCategory: Record<string, number>;
  };
  compactions: { count: number; tokensBeforeTotal: number; tokensBeforeMax: number };
  cost: {
    orchestrator: TokenTotals & { bySource: Record<string, TokenTotals> };
    workers: TokenTotals & {
      byCallsite: Record<string, TokenTotals>;
      attribution: {
        exactRows: number;
        windowRows: number;
        ambiguousRows: number;
        ambiguousUsd: number;
        duplicateCompactionRows: number;
      };
    };
    callAccounting: Record<
      string,
      {
        calls: number;
        estInputTokens: number;
        peakEst: number;
        sysPct: number;
        histPct: number;
        toolPct: number;
        throwHits: number;
      }
    >;
  };
  completion: {
    flowVerifyCalls: number;
    flowVerifyPasses: number;
    flowVerifyFails: number;
    structuredCompleteClaims: number;
    refusedCompleteClaims: number;
    acceptedCompleteClaimsWithoutRecordedPass: number;
    finalAnswerAfterImplementationWithoutRecordedPass: boolean | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MATCH_TOLERANCE_MS = 15 * 60 * 1000;
const WINDOW_SLACK_MS = 5_000;

function ms(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}

function hoursBetween(from: string | null, to: string | null): number | null {
  const a = ms(from);
  const b = ms(to);
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 3_600_000 : null;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function emptyTotals(): TokenTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheReadPct: 0, costUsd: 0 };
}

function addTotals(t: TokenTotals, input: number, output: number, cacheRead: number, usd: number): void {
  t.calls += 1;
  t.inputTokens += input;
  t.outputTokens += output;
  t.cacheReadTokens += cacheRead;
  t.costUsd += usd;
}

function finishTotals<T extends TokenTotals>(t: T): T {
  t.cacheReadPct = pct(t.cacheReadTokens, t.inputTokens);
  return t;
}

function innerJson(outputJson: string | null): Record<string, unknown> | null {
  if (!outputJson) return null;
  try {
    const wrapper = JSON.parse(outputJson) as { output?: unknown };
    if (typeof wrapper?.output !== "string") return null;
    const inner = JSON.parse(wrapper.output) as unknown;
    return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : null;
  } catch (err) {
    // A non-JSON tool payload has no structured fields to read; callers count
    // it as "no structured outcome". Logged so a format change is visible.
    logger.debug("cli", "flow-metrics: non-JSON tool output", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function parseArgs(argsJson: string | null): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const v = JSON.parse(argsJson) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch (err) {
    logger.debug("cli", "flow-metrics: unparseable tool args", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

// ---------------------------------------------------------------------------
// Worker cost attribution
// ---------------------------------------------------------------------------

export interface WorkerCostAttribution {
  rows: FmCostRow[];
  exactRows: number;
  windowRows: number;
  ambiguousRows: number;
  ambiguousUsd: number;
  /** Second copies of compaction calls the orchestrator logs twice (dropped). */
  duplicateCompactionRows: number;
}

/** The orchestrator writes each compaction to the cost log twice (see attributeWorkerCost). */
const COMPACTION_CALLSITE = "orchestrator.compaction";

/**
 * Pick out the cost-log rows a session's background workers produced.
 *
 * Workers run with `persistSession: false`, so their calls reach ONLY the
 * cost log, never usage_events. The cost log carries no session id on rows
 * written before attribution tagging, so:
 *  0. Compaction rows are collapsed in pairs: the orchestrator appends every
 *     compaction to the cost log twice - once from recordUsage("compaction")
 *     and once from the compaction path itself (orchestrator.ts) - so two rows
 *     with the same model, input and output tokens within 15 min are one call.
 *  1. Rows matching a usage_events row (same model + input tokens, within
 *     15 min) are main-process calls already billed to some session → dropped.
 *  2. A row tagged with `parentSessionId` is attributed exactly.
 *  3. An untagged row inside one of THIS session's delegation windows (±5 s)
 *     and inside no other session's window is attributed by window; inside
 *     both it is "ambiguous" and reported but not attributed.
 */
export function attributeWorkerCost(
  costRows: FmCostRow[],
  usageEventsInRange: Array<{ model: string; inputTokens: number; createdAt: string }>,
  sessionIds: ReadonlySet<string>,
  ownWindows: FmWindow[],
  foreignWindows: FmWindow[],
): WorkerCostAttribution {
  const byKey = new Map<string, number[]>();
  usageEventsInRange.forEach((u, i) => {
    const key = `${u.model}\u0000${u.inputTokens}`;
    const list = byKey.get(key);
    if (list) list.push(i);
    else byKey.set(key, [i]);
  });
  const used = new Set<number>();
  const within = (ts: number, w: FmWindow) => ts >= w.start - WINDOW_SLACK_MS && ts <= w.end + WINDOW_SLACK_MS;

  const out: WorkerCostAttribution = {
    rows: [],
    exactRows: 0,
    windowRows: 0,
    ambiguousRows: 0,
    ambiguousUsd: 0,
    duplicateCompactionRows: 0,
  };
  const unpairedCompactions: FmCostRow[] = [];
  for (const row of [...costRows].sort((a, b) => a.ts - b.ts)) {
    if (row.callsite === COMPACTION_CALLSITE) {
      const twin = unpairedCompactions.findIndex(
        (c) =>
          c.model === row.model &&
          c.inputTokens === row.inputTokens &&
          c.outputTokens === row.outputTokens &&
          row.ts - c.ts <= MATCH_TOLERANCE_MS,
      );
      if (twin >= 0) {
        unpairedCompactions.splice(twin, 1);
        out.duplicateCompactionRows += 1;
        continue;
      }
      unpairedCompactions.push(row);
    }
    const candidates = (byKey.get(`${row.model}\u0000${row.inputTokens}`) ?? []).filter(
      (i) => !used.has(i) && Math.abs(ms(usageEventsInRange[i]!.createdAt) - row.ts) <= MATCH_TOLERANCE_MS,
    );
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) =>
        Math.abs(ms(usageEventsInRange[a]!.createdAt) - row.ts) <=
        Math.abs(ms(usageEventsInRange[b]!.createdAt) - row.ts)
          ? a
          : b,
      );
      used.add(best);
      continue;
    }
    if (row.parentSessionId) {
      if (sessionIds.has(row.parentSessionId)) {
        out.rows.push(row);
        out.exactRows += 1;
      }
      continue;
    }
    if (!ownWindows.some((w) => within(row.ts, w))) continue;
    if (foreignWindows.some((w) => within(row.ts, w))) {
      out.ambiguousRows += 1;
      out.ambiguousUsd += row.usd;
      continue;
    }
    out.rows.push(row);
    out.windowRows += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export function aggregateFlowMetrics(input: FlowMetricsInput): FlowMetricsReport {
  const implExt = input.implExtensions?.length
    ? new Set(input.implExtensions.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()))
    : undefined;
  const kindOf = (p: string | undefined): PathKind => classifyPath(p, input.cwd, implExt);

  // --- writes (main chain + workers) → first implementation write ---------
  const allWrites: Array<{ at: string; path?: string; kind: PathKind }> = [];
  for (const call of input.toolCalls) {
    if (!FILE_WRITE_TOOLS.has(call.name) || call.success !== true) continue;
    const path = writeTargetOf(parseArgs(call.argsJson));
    allWrites.push({ at: call.startedAt, path, kind: kindOf(path) });
  }
  const jobWriteKinds = new Map<string, PathKind[]>();
  for (const job of input.delegations) {
    const kinds: PathKind[] = [];
    for (const w of job.writes) {
      if (!FILE_WRITE_TOOLS.has(w.tool) || w.success !== true) continue;
      const kind = kindOf(w.path);
      kinds.push(kind);
      allWrites.push({ at: w.at, path: w.path, kind });
    }
    jobWriteKinds.set(job.id, kinds);
  }
  allWrites.sort((a, b) => ms(a.at) - ms(b.at));
  const firstWrite = allWrites.find((w) => w.kind !== "outside-workspace") ?? null;
  const firstImpl = allWrites.find((w) => w.kind === "implementation") ?? null;
  const requestAt = input.firstHumanMessageAt;

  // --- delegations by purpose ---------------------------------------------
  const byPurpose = Object.fromEntries(
    DELEGATION_PURPOSES.map((p) => [p, { count: 0, pct: 0, workerHours: 0 }]),
  ) as FlowMetricsReport["delegations"]["byPurpose"];
  const jobs: FlowMetricsReport["delegations"]["jobs"] = [];
  for (const job of [...input.delegations].sort((a, b) => ms(a.startedAt) - ms(b.startedAt))) {
    const purpose = classifyDelegationPurpose(
      {
        agent: job.agent,
        kind: job.kind,
        startedAt: job.startedAt,
        hasCouncil: job.hasCouncil,
        hasPlanReview: job.hasPlanReview,
        hasPlanRevalidation: job.hasPlanRevalidation,
        hasReviewOf: job.hasReviewOf,
        successfulWriteKinds: jobWriteKinds.get(job.id) ?? [],
      },
      firstImpl?.at ?? null,
    );
    const hours = Math.max(0, hoursBetween(job.startedAt, job.completedAt ?? null) ?? 0);
    byPurpose[purpose].count += 1;
    byPurpose[purpose].workerHours += hours;
    jobs.push({ id: job.id, purpose, status: job.status, startedAt: job.startedAt, hours });
  }
  for (const p of DELEGATION_PURPOSES) byPurpose[p].pct = pct(byPurpose[p].count, input.delegations.length);

  // --- tool calls: bookkeeping, plan review, completion -------------------
  const bookkeepingByTool: Record<string, number> = {};
  let bookkeeping = 0;
  let dispatchToolCalls = 0;
  const planReview: FlowMetricsReport["planReview"] = {
    calls: 0,
    byAction: {},
    byOutcome: {},
    refusalReasons: {},
    recordedVerdicts: {},
    councilJobs: 0,
    councilVerdicts: {},
    revalidationJobs: 0,
    revalidationVerdicts: {},
  };
  const completion: FlowMetricsReport["completion"] = {
    flowVerifyCalls: 0,
    flowVerifyPasses: 0,
    flowVerifyFails: 0,
    structuredCompleteClaims: 0,
    refusedCompleteClaims: 0,
    acceptedCompleteClaimsWithoutRecordedPass: 0,
    finalAnswerAfterImplementationWithoutRecordedPass: null,
  };
  let recordedPass = false;
  let planVerifiedAt: string | null = null;
  for (const call of [...input.toolCalls].sort((a, b) => ms(a.startedAt) - ms(b.startedAt))) {
    if (BOOKKEEPING_TOOLS.has(call.name)) {
      bookkeeping += 1;
      bump(bookkeepingByTool, call.name);
    }
    if (DISPATCH_TOOLS.has(call.name)) dispatchToolCalls += 1;
    if (call.name === "flow_plan_review") {
      const r = classifyPlanReviewCall(call.argsJson, call.outputJson);
      planReview.calls += 1;
      bump(planReview.byAction, r.action);
      bump(planReview.byOutcome, r.outcome);
      if (r.reason) bump(planReview.refusalReasons, r.reason);
      if (r.outcome === "completed") bump(planReview.recordedVerdicts, r.verdict ?? "unknown");
      if (r.planVerified && planVerifiedAt === null) planVerifiedAt = call.startedAt;
    }
    if (call.name === "flow_verify") {
      completion.flowVerifyCalls += 1;
      const inner = innerJson(call.outputJson);
      if (inner?.ok === true && inner.passed === true) {
        completion.flowVerifyPasses += 1;
        recordedPass = true;
      } else if (inner?.ok === true && inner.passed === false) {
        completion.flowVerifyFails += 1;
        recordedPass = false;
      }
    }
    if (call.name === "context_load" && parseArgs(call.argsJson).root_status === "complete") {
      completion.structuredCompleteClaims += 1;
      const inner = innerJson(call.outputJson);
      if (call.success !== true || typeof inner?.error === "string") completion.refusedCompleteClaims += 1;
      else if (!recordedPass) completion.acceptedCompleteClaimsWithoutRecordedPass += 1;
    }
  }
  if (firstImpl && input.lastAssistantAt && ms(input.lastAssistantAt) > ms(firstImpl.at)) {
    completion.finalAnswerAfterImplementationWithoutRecordedPass = !recordedPass;
  }

  for (const job of input.delegations) {
    if (job.kind === "council" || job.hasCouncil) {
      planReview.councilJobs += 1;
      bump(planReview.councilVerdicts, job.councilVerdict ?? "no-structured-verdict");
    } else if (job.hasPlanRevalidation) {
      planReview.revalidationJobs += 1;
      bump(planReview.revalidationVerdicts, job.revalidationVerdict ?? "no-structured-verdict");
    }
  }

  // --- workers ------------------------------------------------------------
  const workers: FlowMetricsReport["workers"] = {
    total: input.delegations.length,
    complete: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    failurePct: 0,
    byFailureCategory: {},
  };
  for (const job of input.delegations) {
    if (job.status === "complete") workers.complete += 1;
    else if (job.status === "running") workers.running += 1;
    else if (job.status === "cancelled") workers.cancelled += 1;
    else workers.failed += 1;
    const category = classifyWorkerFailure(job);
    if (category) bump(workers.byFailureCategory, category);
  }
  workers.failurePct = pct(workers.failed + workers.cancelled, workers.total);

  // --- compactions ----------------------------------------------------------
  const compactions = {
    count: input.compactions.length,
    tokensBeforeTotal: input.compactions.reduce((s, c) => s + c.tokensBefore, 0),
    tokensBeforeMax: input.compactions.reduce((m, c) => Math.max(m, c.tokensBefore), 0),
  };

  // --- cost -----------------------------------------------------------------
  const orchestrator = { ...emptyTotals(), bySource: {} as Record<string, TokenTotals> };
  for (const e of input.usageEvents) {
    const usd = e.costMicros / 1_000_000;
    addTotals(orchestrator, e.inputTokens, e.outputTokens, e.cacheReadTokens, usd);
    orchestrator.bySource[e.source] ??= emptyTotals();
    addTotals(orchestrator.bySource[e.source]!, e.inputTokens, e.outputTokens, e.cacheReadTokens, usd);
  }
  finishTotals(orchestrator);
  for (const t of Object.values(orchestrator.bySource)) finishTotals(t);

  const sessionIds = new Set(input.sessions.map((s) => s.id));
  const ownWindows: FmWindow[] = input.delegations.map((d) => ({
    parentSessionId: d.parentSessionId,
    start: ms(d.startedAt),
    end: Number.isFinite(ms(d.completedAt)) ? ms(d.completedAt) : ms(d.startedAt),
  }));
  const attributed = attributeWorkerCost(
    input.costRows,
    input.usageEventsInRange,
    sessionIds,
    ownWindows,
    input.foreignWindows,
  );
  const workerCost = {
    ...emptyTotals(),
    byCallsite: {} as Record<string, TokenTotals>,
    attribution: {
      exactRows: attributed.exactRows,
      windowRows: attributed.windowRows,
      ambiguousRows: attributed.ambiguousRows,
      ambiguousUsd: attributed.ambiguousUsd,
      duplicateCompactionRows: attributed.duplicateCompactionRows,
    },
  };
  for (const r of attributed.rows) {
    addTotals(workerCost, r.inputTokens, r.outputTokens, r.cachedInputTokens, r.usd);
    workerCost.byCallsite[r.callsite] ??= emptyTotals();
    addTotals(workerCost.byCallsite[r.callsite]!, r.inputTokens, r.outputTokens, r.cachedInputTokens, r.usd);
  }
  finishTotals(workerCost);
  for (const t of Object.values(workerCost.byCallsite)) finishTotals(t);

  const callAccounting: FlowMetricsReport["cost"]["callAccounting"] = {};
  const segChars: Record<string, { sys: number; hist: number; tool: number }> = {};
  for (const c of input.callAccounting) {
    const s = (callAccounting[c.stage] ??= {
      calls: 0,
      estInputTokens: 0,
      peakEst: 0,
      sysPct: 0,
      histPct: 0,
      toolPct: 0,
      throwHits: 0,
    });
    const seg = (segChars[c.stage] ??= { sys: 0, hist: 0, tool: 0 });
    s.calls += 1;
    s.estInputTokens += c.estInputTokens;
    s.peakEst = Math.max(s.peakEst, c.estInputTokens);
    if (c.throwHit) s.throwHits += 1;
    seg.sys += c.system;
    seg.hist += c.history;
    seg.tool += c.toolResults;
  }
  for (const [stage, s] of Object.entries(callAccounting)) {
    const seg = segChars[stage]!;
    const total = seg.sys + seg.hist + seg.tool;
    s.sysPct = pct(seg.sys, total);
    s.histPct = pct(seg.hist, total);
    s.toolPct = pct(seg.tool, total);
  }

  // --- orchestrator active time by phase ------------------------------------
  // A turn belongs to the phase it STARTED in: plan-gate until the plan is
  // verified, preflight until the first implementation write, then
  // implementation. Idle time waiting for a human is not a turn, so it is
  // excluded - this is the orchestrator's own working time.
  const activeHours = { total: 0, planGate: 0, preflight: 0, implementation: 0 };
  const passMs = ms(planVerifiedAt);
  const implMs = ms(firstImpl?.at ?? null);
  for (const t of input.turns) {
    const hours = t.durationMs / 3_600_000;
    const start = ms(t.endAt) - t.durationMs;
    activeHours.total += hours;
    if (Number.isFinite(implMs) && start >= implMs) activeHours.implementation += hours;
    else if (Number.isFinite(passMs) && start >= passMs) activeHours.preflight += hours;
    else activeHours.planGate += hours;
  }

  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    sessions: input.sessions.map((s) => ({ id: s.id, kind: s.kind })),
    timing: {
      requestAt,
      firstFileWriteAt: firstWrite?.at ?? null,
      firstImplementationWriteAt: firstImpl?.at ?? null,
      firstImplementationPath: firstImpl?.path ?? null,
      planVerifiedAt,
      hoursToPlanVerified: hoursBetween(requestAt, planVerifiedAt),
      finalAnswerAt: input.lastAssistantAt,
      hoursToFirstFileWrite: hoursBetween(requestAt, firstWrite?.at ?? null),
      hoursToFirstImplementationWrite: hoursBetween(requestAt, firstImpl?.at ?? null),
      hoursToFinalAnswer: hoursBetween(requestAt, input.lastAssistantAt),
      humanPrompts: input.humanPrompts,
      internalWakeups: input.internalWakeups,
    },
    delegations: { total: input.delegations.length, dispatchToolCalls, byPurpose, jobs },
    planReview,
    activeHours,
    bookkeeping: {
      total: bookkeeping,
      totalToolCalls: input.toolCalls.length,
      pct: pct(bookkeeping, input.toolCalls.length),
      byTool: bookkeepingByTool,
    },
    workers,
    compactions,
    cost: { orchestrator, workers: workerCost, callAccounting },
    completion,
  };
}
