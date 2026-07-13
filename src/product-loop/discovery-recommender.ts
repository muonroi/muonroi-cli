// src/product-loop/discovery-recommender.ts

import { buildEcosystemPreamble, shouldApplyEcosystemBias } from "./discovery-ecosystem.js";
import type { LeaderLike } from "./discovery-prompt-parser.js";
import { type DiscoveryQuestion, getSchemaHintForLeader } from "./discovery-schema.js";
import { type RepoBrief, rationaleCitesBrief } from "./repo-brief.js";
import type { DiscoveryContext, ExistingProjectSignals, RecommendationEntry } from "./types.js";

export interface RecommendInput {
  question: DiscoveryQuestion;
  context: Partial<DiscoveryContext>;
  detection: ExistingProjectSignals;
  priorRunsDigest?: string;
  /**
   * User's original prompt verbatim (e.g. "tôi muốn tạo todo app"). Threaded
   * through so the leader can size defaults against the user's stated scope —
   * a 5-word prompt should NOT yield "saas/SMB 100-1k" defaults. See
   * computePromptSpecificity() for the scoring rule. Optional for back-compat
   * with callers that don't have the original prompt at hand.
   */
  userIdea?: string;
  /**
   * Repo brief built by `buildRepoBrief(cwd, detection)` when the user is
   * iterating on an EXISTING project. Replaces the Muonroi vendor preamble
   * (which is greenfield-only) and lets the leader cite real files, deps,
   * and scripts. When set, rationales are post-validated against the brief's
   * citable tokens — uncited rationales trigger one retry with a stronger
   * instruction; persistent miss is recorded via `synthFailed=true`.
   */
  repoBrief?: RepoBrief;
}

/**
 * Prompt-specificity buckets used to drive default scope sizing.
 * - "minimal":  Short prompt with no qualifiers (e.g. "tạo todo app", "build a wiki").
 *               Leader MUST pick the smallest-scope primary (personal, single-user,
 *               simplest stack) so 5-word prompts don't get multi-tenant SaaS plans.
 * - "moderate": Some specifics provided (1-2 of: team/scale/platform/timeline).
 *               Leader picks pragmatic defaults; alternatives include richer scope.
 * - "detailed": Multiple specifics or > ~40 words. Leader respects stated context.
 */
export type PromptSpecificity = "minimal" | "moderate" | "detailed";

const QUALIFIER_KEYWORDS = [
  // Scale / multi-user signals
  "team",
  "teams",
  "org",
  "organization",
  "tenant",
  "tenants",
  "multi-tenant",
  "multitenant",
  "saas",
  "enterprise",
  "b2b",
  "marketplace",
  "users",
  "scale",
  "100k",
  "million",
  // Stack specifics
  "react",
  "vue",
  "angular",
  "next",
  "nuxt",
  "rails",
  "django",
  "spring",
  "dotnet",
  ".net",
  "postgres",
  "mysql",
  "mongodb",
  "redis",
  // Domain specifics
  "auth",
  "oauth",
  "sso",
  "payment",
  "stripe",
  "billing",
  "subscription",
  "realtime",
  "websocket",
];

function countQualifiers(prompt: string): number {
  const lower = prompt.toLowerCase();
  let hits = 0;
  for (const kw of QUALIFIER_KEYWORDS) {
    if (lower.includes(kw)) hits++;
  }
  return hits;
}

export function computePromptSpecificity(userIdea: string | undefined): PromptSpecificity {
  if (!userIdea) return "minimal";
  const trimmed = userIdea.trim();
  if (trimmed.length === 0) return "minimal";
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const qualifiers = countQualifiers(trimmed);

  // Detailed: >40 words OR >=3 qualifiers
  if (wordCount > 40 || qualifiers >= 3) return "detailed";
  // Moderate: 10-40 words with some context, OR 1-2 qualifiers
  if (wordCount > 10 || qualifiers >= 1) return "moderate";
  // Minimal: <=10 words and no qualifiers (e.g. "tạo todo app", "build a wiki")
  return "minimal";
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
  "with up to 2 alternatives. No prose, no fences.\n\n" +
  "## Scope-sizing discipline\n" +
  "You will be told the user's original prompt and its specificity bucket (minimal/moderate/detailed).\n" +
  '- When specificity is "minimal" (e.g. user typed "build a todo app" or "tạo wiki"), pick the SMALLEST-SCOPE primary that still works: ' +
  'productType="consumer-app" for a small app, or "cli-tool"/"script"/"library" for a stand-alone tool/snippet ' +
  '(prefer these over the catch-all "other" — a hello-world script is a "script", not "other"), audience scale="1-100" (NOT "100-1k" or above), ' +
  "single-user / no auth / web-only / simplest stack. Put richer multi-tenant/team-scale alternatives in `alternatives`, NOT primary. " +
  "Rationale: short prompts mean the user has NOT asked for enterprise complexity. Inflating scope here cascades into wasted debate and over-built code.\n" +
  '- When specificity is "moderate", pick pragmatic defaults grounded in any stated context; surface ONE richer alternative.\n' +
  '- When specificity is "detailed", respect the stated context fully; alternatives explore adjacent design choices.\n' +
  "This rule applies to EVERY question (productType, audience, backendStack, etc.). The user accepts defaults by reflex — wrong defaults become locked-in spec.\n\n" +
  "## Existing-project citation discipline\n" +
  "If the prompt contains a `## Repo brief` section, you are recommending changes INSIDE an existing project.\n" +
  "Every `rationale` field MUST cite at least one concrete token from the brief: a file path, directory, dependency, " +
  "script name, framework, or manifest name. Generic rationales (e.g. 'industry standard', 'simple choice', " +
  "'good for SaaS') are INVALID when a brief is present — they signal you ignored the repo.\n" +
  'Format: weave the citation naturally, e.g. "reuses `src/product-loop/discovery-recommender.ts` to avoid a parallel path" ' +
  'or "extends the existing `bun run build` script". Cite by name in backticks when possible.\n' +
  "If no token from the brief fits the question, that is a signal you need MORE exploration — say so in the rationale rather than fabricating one.";

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
  process.stderr.write(`[leader-debug] ${JSON.stringify(payload)}\n`);
}

function emitLeaderTiming(payload: LeaderTimingPayload): void {
  if (process.env.MUONROI_DEBUG_LEADER !== "1") return;
  process.stderr.write(`[leader-timing] ${JSON.stringify(payload)}\n`);
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
  const basePrompt = buildLeaderPrompt(input);
  const modelId: string = (leader as any).modelId ?? "unknown";
  let cost = 0;
  // Track whether we already retried with a stronger citation instruction —
  // we only do this once to bound cost.
  let citationRetryDone = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const prompt = citationRetryDone
      ? `${basePrompt}\n\nPREVIOUS ATTEMPT FAILED citation check — your rationale referenced no concrete artifact from the repo brief. RETRY: every rationale field MUST embed at least one backticked token from the brief (file path, dep, script). If you cannot, say so explicitly in the rationale instead of inventing a generic one.`
      : basePrompt;
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

        // Citation validation: only when we sent a repoBrief (existing-project
        // path). If the primary rationale doesn't cite, retry ONCE with a
        // stronger instruction. After retry, accept but flag synthFailed so
        // callers know the rationale is weakly grounded.
        if (input.repoBrief && !rationaleCitesBrief(String(parsed.primary.rationale), input.repoBrief)) {
          if (!citationRetryDone) {
            citationRetryDone = true;
            continue;
          }
          return {
            primary: parsed.primary,
            alternatives: parsed.alternatives,
            source: "leader",
            costUsd: cost,
            synthFailed: true,
          };
        }
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
  const specificity = computePromptSpecificity(input.userIdea);
  const parts: string[] = [];
  const ecosystemOn = shouldApplyEcosystemBias({ detection: input.detection });
  if (ecosystemOn) {
    parts.push(buildEcosystemPreamble(), "");
  } else if (input.repoBrief) {
    // Existing project: replace vendor preamble with the actual repo brief so
    // the leader has something concrete to cite (per LEADER_SYSTEM addendum).
    parts.push(input.repoBrief.markdown, "");
  }
  parts.push(
    input.userIdea ? `User's original prompt: ${JSON.stringify(input.userIdea)}` : "",
    `Prompt specificity: ${specificity}`,
    `Question: ${input.question.prompt}`,
    `Field id: ${input.question.id}`,
    constraint ? `Constraint: ${constraint}` : "",
    `Detected project: ${input.detection.classification} (${input.detection.languages?.join(", ") || "no languages"})`,
    `Context so far: ${JSON.stringify(input.context)}`,
    input.priorRunsDigest ? `Prior similar runs: ${input.priorRunsDigest}` : "",
  );
  return parts.filter(Boolean).join("\n");
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
