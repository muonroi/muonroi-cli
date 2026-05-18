import { getModelInfo } from "../models/registry.js";
import type { UsageEvent, UsageSource } from "../types/index";
import { getDatabase } from "./db";

interface UsageRow {
  id: number;
  session_id: string;
  message_seq: number | null;
  source: UsageSource;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_micros: number;
  created_at: string;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function recordUsageEvent(
  sessionId: string,
  source: UsageSource,
  model: string,
  usage?: TokenUsageLike,
  messageSeq?: number | null,
  pilActive = false,
  enrichmentDelta = 0,
  providerOptionsShape: string | null = null,
): void {
  if (!usage) return;

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return;

  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const costMicros = estimateCostMicros(model, inputTokens, outputTokens, cacheReadTokens);
  getDatabase()
    .prepare(`
    INSERT INTO usage_events (
      session_id, message_seq, source, model, input_tokens, output_tokens, total_tokens, cost_micros, created_at,
      pil_active, enrichment_delta, cache_read_tokens, cache_creation_tokens, provider_options_shape
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      sessionId,
      messageSeq ?? null,
      source,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      costMicros,
      new Date().toISOString(),
      pilActive ? 1 : 0,
      enrichmentDelta,
      cacheReadTokens,
      cacheCreationTokens,
      providerOptionsShape,
    );
}

export function getSessionTotalTokens(sessionId: string): number {
  const row = getDatabase()
    .prepare(`
    SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM usage_events
    WHERE session_id = ?
  `)
    .get(sessionId) as { total_tokens: number } | undefined;

  return row?.total_tokens ?? 0;
}

export function listSessionUsage(sessionId: string): UsageEvent[] {
  const rows = getDatabase()
    .prepare(`
    SELECT id, session_id, message_seq, source, model, input_tokens, output_tokens, total_tokens, cost_micros, created_at, cache_read_tokens, cache_creation_tokens
    FROM usage_events
    WHERE session_id = ?
    ORDER BY id ASC
  `)
    .all(sessionId) as UsageRow[];

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    messageSeq: row.message_seq,
    source: row.source,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    costMicros: row.cost_micros,
    createdAt: new Date(row.created_at),
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
  }));
}

function estimateCostMicros(model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0): number {
  const info = getModelInfo(model);
  if (!info) return 0;
  const cachedPrice = info.cachedInputPrice ?? info.inputPrice * 0.1;
  const nonCachedInput = Math.max(0, inputTokens - cacheReadTokens);
  return Math.round(nonCachedInput * info.inputPrice + cacheReadTokens * cachedPrice + outputTokens * info.outputPrice);
}
