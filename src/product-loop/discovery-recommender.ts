// src/product-loop/discovery-recommender.ts

import type { LeaderLike } from "./discovery-prompt-parser.js";
import { type DiscoveryQuestion, getSchemaHintForLeader } from "./discovery-schema.js";
import type { DiscoveryContext, ExistingProjectSignals, RecommendationEntry } from "./types.js";

export interface RecommendInput {
  question: DiscoveryQuestion;
  context: Partial<DiscoveryContext>;
  detection: ExistingProjectSignals;
  priorRunsDigest?: string;
}

export interface RecommendOutput {
  primary: { value: any; rationale: string };
  alternatives: { value: any; rationale: string }[];
  source: "leader" | "council" | "user-only";
  costUsd: number;
  debateRef?: string;
  tiebreakUsed?: boolean;
  synthFailed?: boolean;
}

const LEADER_SYSTEM =
  "You are a product context recommender. Output ONE JSON object with shape: " +
  '{"primary":{"value":<any>,"rationale":"<short>"},"alternatives":[{"value":<any>,"rationale":"<short>"}]} ' +
  "with up to 2 alternatives. No prose, no fences.";

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
}

// ---------------------------------------------------------------------------
// Diagnostic: MUONROI_DEBUG_LEADER=1 → emit JSON line to stderr on each attempt
// Zero cost when envvar is unset.
// ---------------------------------------------------------------------------
interface LeaderDebugPayload {
  attempt: number;
  model: string;
  system: string; // truncated to 500 chars
  prompt: string; // truncated to 500 chars
  rawResponse: string; // full
  outcome: "parse_ok" | "parse_fail";
  parseError?: string;
}

interface LeaderTimingPayload {
  attempt: number;
  durationMs: number;
  outcome: "ok" | "throw" | "parse_fail";
  modelId: string;
}

function emitLeaderDebug(payload: LeaderDebugPayload): void {
  if (process.env.MUONROI_DEBUG_LEADER !== "1") return;
  process.stderr.write("[leader-debug] " + JSON.stringify(payload) + "\n");
}

function emitLeaderTiming(payload: LeaderTimingPayload): void {
  if (process.env.MUONROI_DEBUG_LEADER !== "1") return;
  process.stderr.write("[leader-timing] " + JSON.stringify(payload) + "\n");
}

/**
 * Returns true when the error represents a deterministic auth failure (401).
 * On a 401 there is no point retrying — the same key will fail again.
 */
function isUnauthorizedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; statusCode?: number };
  if (e.status === 401 || e.statusCode === 401) return true;
  const msg = e.message ?? "";
  return msg.includes("401") || /unauthorized/i.test(msg);
}

function parseLeaderResponse(raw: string): { primary: any; alternatives: any[] } | null {
  try {
    const parsed = JSON.parse(stripFences(raw));
    if (!parsed?.primary?.value || typeof parsed.primary.rationale !== "string") return null;
    const alts = Array.isArray(parsed.alternatives) ? parsed.alternatives.slice(0, 2) : [];
    return { primary: parsed.primary, alternatives: alts };
  } catch {
    return null;
  }
}

export async function leaderRecommend(input: RecommendInput, leader: LeaderLike): Promise<RecommendOutput> {
  const prompt = buildLeaderPrompt(input);
  const modelId: string = (leader as any).modelId ?? "unknown";
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      // 4096 (was 1024) — reasoner models (deepseek-v4-pro, o3) consume the
      // output budget for reasoning_tokens, so 1024 routinely truncates the
      // JSON tail and makes parseLeaderResponse fail twice → "leader unavailable".
      const res = await leader.generate({ system: LEADER_SYSTEM, prompt, maxTokens: 4096 });
      const durationMs = Date.now() - t0;
      cost += res.costUsd;
      const parsed = parseLeaderResponse(res.content);
      if (parsed) {
        emitLeaderDebug({
          attempt,
          model: modelId,
          system: LEADER_SYSTEM.slice(0, 500),
          prompt: prompt.slice(0, 500),
          rawResponse: res.content,
          outcome: "parse_ok",
        });
        emitLeaderTiming({ attempt, durationMs, outcome: "ok", modelId });
        return {
          primary: parsed.primary,
          alternatives: parsed.alternatives,
          source: "leader",
          costUsd: cost,
        };
      }
      emitLeaderDebug({
        attempt,
        model: modelId,
        system: LEADER_SYSTEM.slice(0, 500),
        prompt: prompt.slice(0, 500),
        rawResponse: res.content,
        outcome: "parse_fail",
        parseError: "parseLeaderResponse returned null",
      });
      emitLeaderTiming({ attempt, durationMs, outcome: "parse_fail", modelId });
    } catch (err) {
      const durationMs = Date.now() - t0;
      emitLeaderDebug({
        attempt,
        model: modelId,
        system: LEADER_SYSTEM.slice(0, 500),
        prompt: prompt.slice(0, 500),
        rawResponse: "",
        outcome: "parse_fail",
        parseError: err instanceof Error ? err.message : String(err),
      });
      emitLeaderTiming({ attempt, durationMs, outcome: "throw", modelId });
      // 401 is a deterministic auth failure — retrying won't help. Skip to fallback.
      if (isUnauthorizedError(err)) break;
      /* retry on other errors */
    }
  }
  return {
    primary: { value: null, rationale: "leader unavailable; awaiting user" },
    alternatives: [],
    source: "user-only",
    costUsd: cost,
  };
}

function buildLeaderPrompt(input: RecommendInput): string {
  const constraint = getSchemaHintForLeader(input.question.id);
  return [
    `Question: ${input.question.prompt}`,
    `Field id: ${input.question.id}`,
    constraint ? `Constraint: ${constraint}` : "",
    `Detected project: ${input.detection.classification} (${input.detection.languages?.join(", ") || "no languages"})`,
    `Context so far: ${JSON.stringify(input.context)}`,
    input.priorRunsDigest ? `Prior similar runs: ${input.priorRunsDigest}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function toEntry(out: RecommendOutput): RecommendationEntry {
  return {
    chosen: out.primary.value,
    alternatives: out.alternatives.map((a) => a.value),
    rationale: out.primary.rationale,
    source: out.source,
    debateRef: out.debateRef,
    tiebreakUsed: out.tiebreakUsed,
    synthFailed: out.synthFailed,
  };
}

export interface DebateChunk {
  type: "stance" | "cost" | "summary";
  name?: string;
  value?: any;
  rationale?: string;
  confidence?: number;
  costUsd?: number;
}

export interface CouncilDebateRunner {
  runDebate: (config: { questionId: string; intentSummary: string; context: any }) => AsyncIterable<DebateChunk>;
}

const SYNTH_SYSTEM =
  "You break ties between three stance recommendations. Output JSON: " +
  '{"primary":{"value":<any>,"rationale":"<why>"},"alternatives":[{"value":<any>,"rationale":"<why>"},{"value":<any>,"rationale":"<why>"}]}';

async function consumeDebateChunks(
  it: AsyncIterable<DebateChunk>,
): Promise<{ stances: Array<{ name: string; value: any; rationale: string; confidence?: number }>; costUsd: number }> {
  const stances: Array<{ name: string; value: any; rationale: string; confidence?: number }> = [];
  let costUsd = 0;
  for await (const c of it) {
    if (c.type === "stance" && c.name && c.value !== undefined) {
      stances.push({ name: c.name, value: c.value, rationale: c.rationale ?? "", confidence: c.confidence });
    }
    if (c.type === "cost" && typeof c.costUsd === "number") {
      costUsd += c.costUsd;
    }
  }
  return { stances, costUsd };
}

function tallyMajority(stances: Array<{ value: any }>): { value: any; count: number } | null {
  const counts = new Map<string, { value: any; count: number }>();
  for (const s of stances) {
    const key = JSON.stringify(s.value);
    const cur = counts.get(key) ?? { value: s.value, count: 0 };
    cur.count += 1;
    counts.set(key, cur);
  }
  let best: { value: any; count: number } | null = null;
  for (const v of counts.values()) {
    if (!best || v.count > best.count) best = v;
  }
  if (best && best.count >= 2) return best;
  return null;
}

export async function councilRecommend(
  input: RecommendInput,
  leader: LeaderLike,
  runner: CouncilDebateRunner,
): Promise<RecommendOutput> {
  let chunks: { stances: Awaited<ReturnType<typeof consumeDebateChunks>>["stances"]; costUsd: number };
  try {
    chunks = await consumeDebateChunks(
      runner.runDebate({
        questionId: input.question.id,
        intentSummary: `Decide ${input.question.id} for product context: ${input.detection.classification}, langs=[${input.detection.languages?.join(",") ?? ""}]`,
        context: input.context,
      }),
    );
  } catch {
    const fallback = await leaderRecommend(input, leader);
    return fallback;
  }

  if (chunks.stances.length === 0) {
    return await leaderRecommend(input, leader);
  }

  const majority = tallyMajority(chunks.stances);
  if (majority) {
    const winner = chunks.stances.find((s) => JSON.stringify(s.value) === JSON.stringify(majority.value))!;
    const altsRaw = chunks.stances.filter((s) => JSON.stringify(s.value) !== JSON.stringify(majority.value));
    const alts = dedupByValue(altsRaw).slice(0, 2);
    return {
      primary: { value: winner.value, rationale: winner.rationale },
      alternatives: alts.map((a) => ({ value: a.value, rationale: a.rationale })),
      source: "council",
      costUsd: chunks.costUsd,
      tiebreakUsed: false,
    };
  }

  // Three-way split → synth tiebreak
  const synthPrompt = chunks.stances.map((s) => `[${s.name}] ${JSON.stringify(s.value)} :: ${s.rationale}`).join("\n");
  const synthModelId: string = (leader as any).modelId ?? "unknown";
  let synthCost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await leader.generate({ system: SYNTH_SYSTEM, prompt: synthPrompt, maxTokens: 4096 });
      const durationMs = Date.now() - t0;
      synthCost += res.costUsd;
      const parsed = parseLeaderResponse(res.content);
      if (parsed) {
        emitLeaderDebug({
          attempt,
          model: synthModelId,
          system: SYNTH_SYSTEM.slice(0, 500),
          prompt: synthPrompt.slice(0, 500),
          rawResponse: res.content,
          outcome: "parse_ok",
        });
        emitLeaderTiming({ attempt, durationMs, outcome: "ok", modelId: synthModelId });
        return {
          primary: parsed.primary,
          alternatives: parsed.alternatives,
          source: "council",
          costUsd: chunks.costUsd + synthCost,
          tiebreakUsed: true,
        };
      }
      emitLeaderDebug({
        attempt,
        model: synthModelId,
        system: SYNTH_SYSTEM.slice(0, 500),
        prompt: synthPrompt.slice(0, 500),
        rawResponse: res.content,
        outcome: "parse_fail",
        parseError: "parseLeaderResponse returned null",
      });
      emitLeaderTiming({ attempt, durationMs, outcome: "parse_fail", modelId: synthModelId });
    } catch (err) {
      const durationMs = Date.now() - t0;
      emitLeaderDebug({
        attempt,
        model: synthModelId,
        system: SYNTH_SYSTEM.slice(0, 500),
        prompt: synthPrompt.slice(0, 500),
        rawResponse: "",
        outcome: "parse_fail",
        parseError: err instanceof Error ? err.message : String(err),
      });
      emitLeaderTiming({ attempt, durationMs, outcome: "throw", modelId: synthModelId });
      // 401 is deterministic — skip retry
      if (isUnauthorizedError(err)) break;
      /* retry on other errors */
    }
  }
  // Synth failed → confidence fallback
  const byConfidence = [...chunks.stances].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const winner = byConfidence[0];
  const alts = byConfidence.slice(1, 3).map((s) => ({ value: s.value, rationale: s.rationale }));
  return {
    primary: { value: winner.value, rationale: winner.rationale },
    alternatives: alts,
    source: "council",
    costUsd: chunks.costUsd + synthCost,
    tiebreakUsed: true,
    synthFailed: true,
  };
}

function dedupByValue<T extends { value: any }>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const a of arr) {
    const key = JSON.stringify(a.value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

export const COUNCIL_HARD_FLOOR_USD = 2.5;
export const ESTIMATED_NEXT_COUNCIL_COST_USD = 0.45;

export function computeCostGuard(capUsd: number): number {
  return Math.max(COUNCIL_HARD_FLOOR_USD, 0.15 * capUsd);
}

export function shouldFallbackToLeader(opts: { cumulative: number; capUsd: number }): boolean {
  return opts.cumulative + ESTIMATED_NEXT_COUNCIL_COST_USD > computeCostGuard(opts.capUsd);
}

export { withRateLimitBackoff } from "../utils/rate-limit.js";
