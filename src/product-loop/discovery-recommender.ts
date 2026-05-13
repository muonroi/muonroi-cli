// src/product-loop/discovery-recommender.ts

import type { LeaderLike } from "./discovery-prompt-parser.js";
import type { DiscoveryQuestion } from "./discovery-schema.js";
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
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await leader.generate({ system: LEADER_SYSTEM, prompt, maxTokens: 1024 });
      cost += res.costUsd;
      const parsed = parseLeaderResponse(res.content);
      if (parsed) {
        return {
          primary: parsed.primary,
          alternatives: parsed.alternatives,
          source: "leader",
          costUsd: cost,
        };
      }
    } catch {
      /* retry */
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
  return [
    `Question: ${input.question.prompt}`,
    `Field id: ${input.question.id}`,
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
  let synthCost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await leader.generate({ system: SYNTH_SYSTEM, prompt: synthPrompt, maxTokens: 800 });
      synthCost += res.costUsd;
      const parsed = parseLeaderResponse(res.content);
      if (parsed) {
        return {
          primary: parsed.primary,
          alternatives: parsed.alternatives,
          source: "council",
          costUsd: chunks.costUsd + synthCost,
          tiebreakUsed: true,
        };
      }
    } catch {
      /* retry */
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

export async function withRateLimitBackoff<T>(
  fn: () => Promise<T>,
  opts: { delays?: number[]; maxRetries?: number } = {},
): Promise<T> {
  const delays = opts.delays ?? [1000, 4000, 16000];
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e ?? "");
      const is429 = e?.status === 429 || /429|rate.?limit/i.test(msg);
      if (!is429 || attempt === maxRetries - 1) throw e;
      const ms = delays[Math.min(attempt, delays.length - 1)];
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  throw lastErr;
}
