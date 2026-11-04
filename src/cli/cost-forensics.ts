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

import type { SessionExperienceCounts } from "../orchestrator/session-experience.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { getDatabase } from "../storage/db.js";
import { getSessionChain } from "../storage/index.js";
import { selectSessionExperience } from "../storage/session-experience-store.js";
import { redactSecrets } from "../utils/logger.js";
import {
  collectForensicsDiagnostics,
  type ForensicsDiagnostics,
  type ForensicsOptions,
  forensicsCutoff,
} from "./forensics-diagnostics.js";

export interface CostForensicsRow {
  sessionId?: string;
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
  /** Phase O1 — JSON-shape of providerOptions on this call (types only). */
  providerOptionsShape: string | null;
  providerOptionsShapeTruncated?: boolean;
}

export interface CostForensicsSummary extends Partial<ForensicsDiagnostics> {
  snapshot?: { capturedAt: string; until: string; usageFrom: string | null; usageTo: string | null };
  usagePage?: { offset: number; returned: number; total: number; nextOffset: number | null };
  cacheCadence?: CacheCadenceDiagnostic;
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
  /** Largest recorded uncached usage event. Aggregated events do not prove a per-request context size. */
  peakSingleCallFresh: number;
  events: CostForensicsRow[];
  /**
   * Characters the C3 cross-turn dedup deliberately RE-SERVED on same-turn
   * re-reads (its policy trade-off) — previously invisible. ~4 chars/token.
   */
  redundantReservedChars: number;
  /** Anti-mù counters for this session (null when none recorded). */
  experience: SessionExperienceCounts | null;
}

interface UsageRow {
  session_id: string;
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
  provider_options_shape: string | null;
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

/**
 * Return ALL session ids matching a prefix (newest first, capped at 5).
 * Additive sibling of the private resolveSessionId — exposes the raw match
 * list for callers (e.g. the MCP forensics tool) that need to distinguish
 * "no match" from "ambiguous". The CLI path keeps using resolveSessionId.
 */
export function resolveSessionIds(prefix: string): string[] {
  const rows = getDatabase()
    .prepare(`SELECT id FROM sessions WHERE id LIKE ? ORDER BY created_at DESC LIMIT 5`)
    .all(`${prefix}%`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function collectCostForensics(sessionId: string, options: ForensicsOptions = {}): CostForensicsSummary {
  const until = forensicsCutoff(options);
  return getDatabase().transaction(() => collectSnapshot(sessionId, options, until))();
}

function collectSnapshot(sessionId: string, options: ForensicsOptions, until: string): CostForensicsSummary {
  const db = getDatabase();

  const session = db.prepare(`SELECT id, model, created_at FROM sessions WHERE id = ?`).get(sessionId) as
    | SessionRow
    | undefined;
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const chain = getSessionChain(sessionId);
  const placeholders = chain.map(() => "?").join(",");

  const rows = db
    .prepare(`
    SELECT id, session_id, source, model, message_seq, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, cost_micros, created_at,
           provider_options_shape
    FROM usage_events
    WHERE session_id IN (${placeholders}) AND created_at <= ?
    ORDER BY id ASC
  `)
    .all(...chain, until) as UsageRow[];

  const counts = db
    .prepare(`
    SELECT event_type, COUNT(*) AS c
    FROM interaction_logs
    WHERE session_id IN (${placeholders}) AND created_at <= ?
    GROUP BY event_type
  `)
    .all(...chain, until) as InteractionCountRow[];

  const countMap = new Map(counts.map((r) => [r.event_type, r.c]));

  // Latest cumulative same-turn re-serve cost (C3 dedup policy trade-off). The
  // metric is cumulative per session, so the newest row holds the session total.
  const dedupRow = db
    .prepare(`
    SELECT metadata_json FROM interaction_logs
    WHERE session_id IN (${placeholders}) AND event_type = 'dedup' AND created_at <= ?
    ORDER BY id DESC LIMIT 1
  `)
    .get(...chain, until) as { metadata_json: string } | undefined;
  let redundantReservedChars = 0;
  if (dedupRow) {
    try {
      redundantReservedChars = Number(JSON.parse(dedupRow.metadata_json)?.sameTurnReservedChars) || 0;
    } catch {
      /* malformed row — ignore */
    }
  }

  const events: CostForensicsRow[] = rows.map((r) => ({
    sessionId: r.session_id,
    id: r.id,
    source: r.source,
    model: redactSecrets(r.model).slice(0, 200),
    messageSeq: r.message_seq,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    costMicros: r.cost_micros,
    createdAt: r.created_at,
    providerOptionsShape: r.provider_options_shape ? redactSecrets(r.provider_options_shape).slice(0, 512) : null,
    providerOptionsShapeTruncated: (r.provider_options_shape?.length ?? 0) > 512,
  }));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalCostMicros = 0;
  let peakSingleCallInput = 0;
  let peakSingleCallFresh = 0;
  let usageFrom: string | null = null;
  let usageTo: string | null = null;
  for (const e of events) {
    if (usageFrom === null || e.createdAt < usageFrom) usageFrom = e.createdAt;
    if (usageTo === null || e.createdAt > usageTo) usageTo = e.createdAt;
    totalInput += e.inputTokens;
    totalOutput += e.outputTokens;
    totalCacheRead += e.cacheReadTokens;
    totalCacheCreation += e.cacheCreationTokens;
    totalCostMicros += e.costMicros;
    if (e.inputTokens > peakSingleCallInput) peakSingleCallInput = e.inputTokens;
    const fresh = Math.max(0, e.inputTokens - e.cacheReadTokens);
    if (fresh > peakSingleCallFresh) peakSingleCallFresh = fresh;
  }
  const cacheable = totalInput;
  const cacheHitRatio = cacheable > 0 ? totalCacheRead / cacheable : 0;
  const usageOffset = options.usageOffset ?? 0;
  const page = options.usageOffset === undefined ? events : events.slice(usageOffset, usageOffset + 20);

  return {
    ...collectForensicsDiagnostics(chain, countMap, until, options),
    snapshot: { capturedAt: new Date().toISOString(), until, usageFrom, usageTo },
    usagePage: {
      offset: usageOffset,
      returned: page.length,
      total: events.length,
      nextOffset: usageOffset + page.length < events.length ? usageOffset + page.length : null,
    },
    cacheCadence: computeCacheCadence(events),
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
    peakSingleCallFresh,
    events: page,
    redundantReservedChars,
    experience: selectSessionExperience(sessionId, until),
  };
}

/**
 * Count zero cache reads after a prior hit. Usage rows do not establish that
 * request prefixes stayed identical, or identify provider latency/eviction.
 * The largest hit multiplied by miss count is a hypothetical comparison,
 * not observed rebilling. Inspect prepared requests before assigning a cause.
 */
export interface CacheCadenceDiagnostic {
  /** Largest reported cache_read; does not prove a shared prefix across calls. */
  warmPrefixTokens: number;
  /** Top-level message-loop calls (sub-agent `task` calls excluded). */
  messageCalls: number;
  /** Message calls reading 0% AFTER the first cache hit (cold-start excluded). */
  coldCallsAfterWarmup: number;
  /** Legacy field: hypothetical comparison, not measured avoidable token spend. */
  estReBilledTokens: number;
}

export function computeCacheCadence(events: CostForensicsRow[]): CacheCadenceDiagnostic {
  // Only the top-level message loop shares one cached prefix per session;
  // sub-agent `task` calls carry a different prefix, so exclude them.
  const msgs = events.filter((e) => e.source === "message");
  const warmPrefixTokens = msgs.reduce((m, e) => Math.max(m, e.cacheReadTokens), 0);
  let firstHit = -1;
  for (let i = 0; i < msgs.length; i++) {
    if ((msgs[i]?.cacheReadTokens ?? 0) > 0) {
      firstHit = i;
      break;
    }
  }
  let coldCallsAfterWarmup = 0;
  if (firstHit >= 0) {
    for (let i = firstHit + 1; i < msgs.length; i++) {
      if ((msgs[i]?.cacheReadTokens ?? 0) === 0) coldCallsAfterWarmup += 1;
    }
  }
  return {
    warmPrefixTokens,
    messageCalls: msgs.length,
    coldCallsAfterWarmup,
    estReBilledTokens: coldCallsAfterWarmup * warmPrefixTokens,
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
  if (summary.telemetry) w(`CLI telemetry:       ${summary.telemetry.databasePath} (usage_events / interaction_logs)`);
  if (summary.snapshot) w(`Snapshot cutoff:     ${summary.snapshot.until}`);
  w(``);
  w(`Total input tokens:  ${formatNum(summary.totalInput)}`);
  w(`Total output tokens: ${formatNum(summary.totalOutput)}`);
  w(`Cache read tokens:   ${formatNum(summary.totalCacheRead)} (${formatPct(summary.cacheHitRatio)} of input)`);
  w(`Cache create tokens: ${formatNum(summary.totalCacheCreation)}`);
  w(
    `Peak usage event:    ${formatNum(summary.peakSingleCallInput)} input ` +
      `(${formatNum(summary.peakSingleCallFresh)} fresh)`,
  );
  w(`Estimated cost:      $${summary.totalCostUsd.toFixed(4)}`);
  w(
    `Context interpretation: Cache-read tokens still occupy request context. Aggregated usage and failed requests require separate request/error evidence.`,
  );
  // Cache-cadence diagnostic — surface fast-loop prompt-cache latency loss.
  const cadence = summary.cacheCadence ?? computeCacheCadence(summary.events);
  if (cadence.warmPrefixTokens > 0 && cadence.coldCallsAfterWarmup > 0) {
    w(
      `Cache cadence:       ${cadence.coldCallsAfterWarmup} call(s) after warm-up read 0% ` +
        `with a largest recorded hit of ${formatNum(cadence.warmPrefixTokens)} tokens ` +
        `(hypothetical comparison: ${formatNum(cadence.estReBilledTokens)} tokens). ` +
        `Cause unverified: compare request history, system and tool schemas; usage rows alone do not prove provider latency.`,
    );
  }
  // C3 same-turn re-serve cost — the dedup deliberately re-bills full content on
  // same-turn re-reads (avoiding a worse single-read fallback). Surfaced so the
  // policy's cost is falsifiable rather than hidden inside the `message` bucket.
  if (summary.redundantReservedChars > 0) {
    w(
      `Dedup re-serve:      ~${formatNum(Math.round(summary.redundantReservedChars / 4))} tok ` +
        `(${formatNum(summary.redundantReservedChars)} chars) re-billed by the C3 same-turn re-read policy. ` +
        `If high, batch reads / raise retention so identical same-turn reads stub instead of re-serve.`,
    );
  }
  // Anti-mù counters for this session (rec #1 persisted forensics).
  if (summary.experience) {
    const x = summary.experience;
    const rehydrated = x.rehydratedCache + x.rehydratedDisk + x.rehydratedEe;
    w(
      `Anti-mù:             ${x.compactions} compaction(s), ${x.elided} tool output(s) elided` +
        `${x.elided > 0 ? ` (${formatNum(x.totalElidedChars)} chars)` : ""}, ` +
        `${rehydrated} rehydrated (cache=${x.rehydratedCache} disk=${x.rehydratedDisk} ee=${x.rehydratedEe}), ` +
        `${x.unavailable} needed-but-unavailable.`,
    );
  }
  w(``);
  if (summary.errors) {
    w(`Stored failures:     ${summary.errors.total} (not additional usage; source: interaction_logs)`);
    for (const e of summary.errors.records)
      w(
        `  [record=${e.id} session=${e.sessionId} ${e.createdAt}] ${e.statusCode ? `HTTP ${e.statusCode}: ` : ""}${e.message}`,
      );
  }
  if (summary.requestMeasurements) {
    w(`Request measurements: ${summary.requestMeasurements.total} stored rows; estimates, not HTTP captures`);
    for (const m of summary.requestMeasurements.records)
      w(
        `  [record=${m.id} ${m.kind}] estimated input=${m.estimatedInputTokens ?? "unknown"}; chars=${JSON.stringify(m.components)}`,
      );
  }
  if (summary.usagePage?.nextOffset != null)
    w(
      `Usage page:          ${summary.usagePage.returned}/${summary.usagePage.total}; next offset=${summary.usagePage.nextOffset}`,
    );
  w(`Per-event breakdown (usage events can aggregate model steps):`);
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

  // Phase O1 — providerOptions shapes per event (types only, no values).
  // Surface so post-mortem can answer "what providerOptions did this call carry?"
  const shapedEvents = summary.events.filter((e) => e.providerOptionsShape);
  if (shapedEvents.length > 0) {
    w(`providerOptions shape (types only):`);
    for (const e of shapedEvents) {
      const seq = e.messageSeq === null ? "-" : String(e.messageSeq);
      w(`  [seq=${seq.padEnd(4)} src=${e.source.padEnd(8)}] ${e.providerOptionsShape}`);
    }
    w(``);
  }

  // Acceptance hints — surface anomalies relative to Phase A/B/C targets.
  const anomalies: string[] = [];
  if (summary.events.some((e) => e.messageSeq === null && e.source === "message")) {
    anomalies.push(
      `some 'message' events have NULL message_seq — Phase A5 message write-ahead bypassed (check persistMessageWriteAhead wiring)`,
    );
  }
  // C1 acceptance check: only count DeepSeek-cache-layout events. Earlier
  // versions fired whenever ANY event in the session was deepseek
  // (council/compaction side-calls could trigger the warning on otherwise-pure
  // OAuth sessions). Now we scope the check to providers whose cache metric
  // layout matches DeepSeek's (`promptCacheHitTokens` read field, no
  // creation_tokens emitted) — currently deepseek + siliconflow.
  // Phase 12.2-G5: replaces literal `model.startsWith("deepseek")` with
  // capability-driven detection so adding a new DeepSeek-shaped provider
  // wires through automatically.
  const deepseekCacheLayoutEvents = summary.events.filter((e) => {
    const provider = detectProviderForModel(e.model);
    return getProviderCapabilities(provider).cacheMetricLayout().readField === "promptCacheHitTokens";
  });
  if (deepseekCacheLayoutEvents.length > 0) {
    const deepseekInput = deepseekCacheLayoutEvents.reduce((acc, e) => acc + (e.inputTokens ?? 0), 0);
    const deepseekCacheCreate = deepseekCacheLayoutEvents.reduce((acc, e) => acc + (e.cacheCreationTokens ?? 0), 0);
    if (deepseekInput > 50_000 && deepseekCacheCreate === 0) {
      anomalies.push(
        `deepseek route has zero cache_creation_tokens across ${formatNum(deepseekInput)} deepseek input tokens — DeepSeek does not emit cache_creation (cache reads only); if this fires on a non-deepseek-dominant session, ignore`,
      );
    }
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
