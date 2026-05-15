/**
 * src/cli/cost-forensics.ts
 *
 * `muonroi-cli usage forensics <session-id-prefix>` — per-event cost
 * breakdown for a single session, joining usage_events with
 * interaction_logs to surface which user prompt triggered which billed
 * input. Built to verify Phase A/B/C cost-optimization wins — e.g.
 * confirm that sub-agent context no longer balloons past 80k input
 * after the cumulative cap kicks in.
 */

import { getDatabase } from "../storage/db.js";

export interface CostForensicsRow {
  id: number;
  source: string;
  model: string;
  messageSeq: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costMicros: number;
  createdAt: string;
}

export interface CostForensicsSummary {
  sessionId: string;
  rowCount: number;
  userPromptCount: number;
  toolCallCount: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalCostUsd: number;
  cacheHitRatio: number;
  peakSingleCallInput: number;
  events: CostForensicsRow[];
}

interface UsageRow {
  id: number;
  source: string;
  model: string;
  message_seq: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_micros: number;
  created_at: string;
}

interface SessionRow {
  id: string;
  model: string;
  created_at: string;
}

interface InteractionCountRow {
  event_type: string;
  c: number;
}

function resolveSessionId(prefix: string): string | null {
  const rows = getDatabase()
    .prepare(`SELECT id FROM sessions WHERE id LIKE ? ORDER BY created_at DESC LIMIT 5`)
    .all(`${prefix}%`) as Array<{ id: string }>;
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0]!.id;
  process.stderr.write(`Ambiguous prefix '${prefix}' matched ${rows.length} sessions:\n`);
  for (const r of rows) process.stderr.write(`  ${r.id}\n`);
  return null;
}

export function collectCostForensics(sessionId: string): CostForensicsSummary {
  const db = getDatabase();

  const session = db.prepare(`SELECT id, model, created_at FROM sessions WHERE id = ?`).get(sessionId) as
    | SessionRow
    | undefined;
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const rows = db
    .prepare(`
    SELECT id, source, model, message_seq, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, cost_micros, created_at
    FROM usage_events
    WHERE session_id = ?
    ORDER BY id ASC
  `)
    .all(sessionId) as UsageRow[];

  const counts = db
    .prepare(`
    SELECT event_type, COUNT(*) AS c
    FROM interaction_logs
    WHERE session_id = ?
    GROUP BY event_type
  `)
    .all(sessionId) as InteractionCountRow[];

  const countMap = new Map(counts.map((r) => [r.event_type, r.c]));

  const events: CostForensicsRow[] = rows.map((r) => ({
    id: r.id,
    source: r.source,
    model: r.model,
    messageSeq: r.message_seq,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    costMicros: r.cost_micros,
    createdAt: r.created_at,
  }));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalCostMicros = 0;
  let peakSingleCallInput = 0;
  for (const e of events) {
    totalInput += e.inputTokens;
    totalOutput += e.outputTokens;
    totalCacheRead += e.cacheReadTokens;
    totalCacheCreation += e.cacheCreationTokens;
    totalCostMicros += e.costMicros;
    if (e.inputTokens > peakSingleCallInput) peakSingleCallInput = e.inputTokens;
  }
  const cacheable = totalInput;
  const cacheHitRatio = cacheable > 0 ? totalCacheRead / cacheable : 0;

  return {
    sessionId,
    rowCount: events.length,
    userPromptCount: countMap.get("user_message") ?? 0,
    toolCallCount: countMap.get("tool_call") ?? 0,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheCreation,
    totalCostUsd: totalCostMicros / 1_000_000,
    cacheHitRatio,
    peakSingleCallInput,
    events,
  };
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function printCostForensics(summary: CostForensicsSummary, opts: { json?: boolean } = {}): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  const w = (s: string) => process.stdout.write(`${s}\n`);
  w(``);
  w(`Cost forensics — session ${summary.sessionId}`);
  w(`${"─".repeat(72)}`);
  w(`User prompts:        ${summary.userPromptCount}`);
  w(`Tool calls (log):    ${summary.toolCallCount}`);
  w(`LLM events:          ${summary.rowCount}`);
  w(``);
  w(`Total input tokens:  ${formatNum(summary.totalInput)}`);
  w(`Total output tokens: ${formatNum(summary.totalOutput)}`);
  w(`Cache read tokens:   ${formatNum(summary.totalCacheRead)} (${formatPct(summary.cacheHitRatio)} of input)`);
  w(`Cache create tokens: ${formatNum(summary.totalCacheCreation)}`);
  w(`Peak single call:    ${formatNum(summary.peakSingleCallInput)} input`);
  w(`Estimated cost:      $${summary.totalCostUsd.toFixed(4)}`);
  w(``);
  w(`Per-event breakdown:`);
  w(
    `${"seq".padEnd(5)}${"src".padEnd(10)}${"input".padStart(9)}${"out".padStart(7)}${"cacheR".padStart(9)}${"cacheC".padStart(8)}  ts`,
  );
  for (const e of summary.events) {
    const seq = e.messageSeq === null ? "-" : String(e.messageSeq);
    w(
      `${seq.padEnd(5)}${e.source.padEnd(10)}${formatNum(e.inputTokens).padStart(9)}${formatNum(e.outputTokens).padStart(7)}${formatNum(e.cacheReadTokens).padStart(9)}${formatNum(e.cacheCreationTokens).padStart(8)}  ${e.createdAt}`,
    );
  }
  w(``);

  // Acceptance hints — surface anomalies relative to Phase A/B/C targets.
  const anomalies: string[] = [];
  if (summary.peakSingleCallInput > 80_000) {
    anomalies.push(
      `peak single-call input ${formatNum(summary.peakSingleCallInput)} > 80,000 — sub-agent cap may not have kicked in (Phase B target breach)`,
    );
  }
  if (summary.events.some((e) => e.messageSeq === null && e.source === "message")) {
    anomalies.push(`some 'message' events have NULL message_seq — Phase A3 fix not active in this session`);
  }
  if (
    summary.totalInput > 50_000 &&
    summary.totalCacheCreation === 0 &&
    summary.events.some((e) => e.model.startsWith("deepseek"))
  ) {
    anomalies.push(
      `deepseek route has zero cache_creation_tokens across ${summary.totalInput} input tokens — prompt caching not wired (Phase C1 open)`,
    );
  }
  if (anomalies.length > 0) {
    w(`Anomalies:`);
    for (const a of anomalies) w(`  ⚠ ${a}`);
    w(``);
  } else {
    w(`✓ No acceptance-target anomalies detected.`);
    w(``);
  }
}

export async function runCostForensics(opts: { prefix: string; json?: boolean }): Promise<void> {
  const sessionId = resolveSessionId(opts.prefix);
  if (!sessionId) {
    process.exitCode = 1;
    return;
  }
  const summary = collectCostForensics(sessionId);
  printCostForensics(summary, { json: opts.json });
}
