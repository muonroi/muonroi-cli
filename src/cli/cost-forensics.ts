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
import { selectSessionExperience } from "../storage/session-experience-store.js";

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
  /** Phase O1 — JSON-shape of providerOptions on this call (types only). */
  providerOptionsShape: string | null;
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
  /** Anti-mù counters for this session (null when none recorded). */
  experience: SessionExperienceCounts | null;
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

export function collectCostForensics(sessionId: string): CostForensicsSummary {
  const db = getDatabase();

  const session = db.prepare(`SELECT id, model, created_at FROM sessions WHERE id = ?`).get(sessionId) as
    | SessionRow
    | undefined;
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const rows = db
    .prepare(`
    SELECT id, source, model, message_seq, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, cost_micros, created_at,
           provider_options_shape
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
    providerOptionsShape: r.provider_options_shape,
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
    experience: selectSessionExperience(sessionId),
  };
}

/**
 * Cache-cadence diagnostic. OpenAI's automatic prompt cache has a population
 * latency (~5-8s observed): in a fast tool loop where calls land ~2s apart, a
 * prefix written on call N is not yet readable on call N+1, so the call reads
 * 0% even though the prefix is identical and provably cacheable. This surfaces
 * that cost: it counts only the message-loop calls that read 0% AFTER the cache
 * has demonstrably warmed at least once (so cold-start misses are NOT blamed),
 * and estimates the tokens re-billed = those calls × the warmed prefix size.
 *
 * It is a cost OBSERVATION, not a target breach — the fix is fewer/batched tool
 * rounds (or a slower cadence), not a code change, since the prefix is stable
 * (F1 promptCacheKey + A3 idempotent compaction already hold it byte-stable).
 */
export interface CacheCadenceDiagnostic {
  /** Largest cache_read seen on a message call = the stable cacheable prefix. */
  warmPrefixTokens: number;
  /** Top-level message-loop calls (sub-agent `task` calls excluded). */
  messageCalls: number;
  /** Message calls reading 0% AFTER the first cache hit (cold-start excluded). */
  coldCallsAfterWarmup: number;
  /** Estimated tokens re-billed by those misses (coldCallsAfterWarmup × warmPrefixTokens). */
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
  w(``);
  w(`Total input tokens:  ${formatNum(summary.totalInput)}`);
  w(`Total output tokens: ${formatNum(summary.totalOutput)}`);
  w(`Cache read tokens:   ${formatNum(summary.totalCacheRead)} (${formatPct(summary.cacheHitRatio)} of input)`);
  w(`Cache create tokens: ${formatNum(summary.totalCacheCreation)}`);
  w(`Peak single call:    ${formatNum(summary.peakSingleCallInput)} input`);
  w(`Estimated cost:      $${summary.totalCostUsd.toFixed(4)}`);
  // Cache-cadence diagnostic — surface fast-loop prompt-cache latency loss.
  const cadence = computeCacheCadence(summary.events);
  if (cadence.warmPrefixTokens > 0 && cadence.coldCallsAfterWarmup > 0) {
    w(
      `Cache cadence:       ${cadence.coldCallsAfterWarmup} call(s) after warm-up read 0% ` +
        `despite a cacheable ~${formatNum(cadence.warmPrefixTokens)}-tok prefix ` +
        `(~${formatNum(cadence.estReBilledTokens)} tok re-billed). ` +
        `Likely fast tool-loop latency — fewer/batched tool rounds recover this.`,
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
  if (summary.peakSingleCallInput > 80_000) {
    anomalies.push(
      `peak single-call input ${formatNum(summary.peakSingleCallInput)} > 80,000 — sub-agent cap may not have kicked in (Phase B target breach)`,
    );
  }
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
