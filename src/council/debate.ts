import { randomUUID } from "node:crypto";
import { getModelInfo } from "../models/registry.js";
import { detectProviderForModel } from "../providers/runtime.js";
import type { CouncilQuestionOption, StreamChunk } from "../types/index.js";
import { pickCouncilTaskModel } from "./leader.js";
import { tracedAsync, tracedGenerate } from "./llm.js";
import { phaseDone, phaseStart } from "./phase-events.js";
import {
  buildFollowupPrompt,
  buildLeaderEvaluationPrompt,
  buildOpeningPrompt,
  buildResponsePrompt,
  buildRoundSummaryPrompt,
} from "./prompts.js";
import type {
  ClarifiedSpec,
  CouncilConfig,
  CouncilLLM,
  CouncilParticipant,
  DebateStance,
  DebateState,
  LeaderEvaluation,
  QuestionResponder,
} from "./types.js";

/**
 * Verification tools default-on for balanced/premium tier.
 *
 * Fast tier (Flash, etc.) ALSO opts in by default — session ea13da132dec
 * showed that Flash-only stances (Browser Extension Engineer with all the
 * PDF.js technical claims) had no way to verify their own assertions when
 * tools were disabled. The empty-completion bug that originally motivated
 * the tier gate was caused by stepCountIs(4) + full bash/edit toolset; we
 * now use stepCountIs(2) + a strict 2-tool allowlist (grep, read_file) so
 * Flash can verify safely without burning step budget on exploration.
 *
 * Safety: a per-session circuit breaker (debateToolBudget below) flips
 * tools off for any model that returns empty completions twice in a row
 * while tools were enabled. After the trip the model continues tool-free
 * for the rest of the session.
 */
function debateAllowsTools(modelId: string): boolean {
  const tier = getModelInfo(modelId)?.tier;
  return tier === "fast" || tier === "balanced" || tier === "premium";
}

/**
 * Per-session counter of consecutive empty-with-tools completions per model.
 * After 2 in a row, the model is "tool-disabled" for the rest of the session
 * (or until a non-empty response resets the counter).
 *
 * Lives on DebateState scope inside runDebate — NOT module-level, because
 * concurrent council runs on the same model must not share circuit state.
 */
type ToolBudget = {
  emptyStreak: Map<string, number>;
  disabled: Set<string>;
};
function makeToolBudget(): ToolBudget {
  return { emptyStreak: new Map(), disabled: new Set() };
}
const MAX_EMPTY_WITH_TOOLS = 2;

/** Hard ceiling — leader can extend `plannedRounds` up to but not past this. */
const ABSOLUTE_MAX_ROUNDS = 8;
/** Default initial round budget when the planner does not propose one. */
const DEFAULT_PLANNED_ROUNDS = 3;

/**
 * Per-kind hard ceiling on debate rounds — the leader may extend up to this, never
 * past it. Discussion-style debates (decision / evaluation / investigation) converge
 * fast, so capping them at 3 stops a simple "X or Y?" from burning 5-8 rounds of
 * diminishing returns. Observed live (2026-06-20): a Redis-vs-in-memory decision ran
 * 5 rounds / ~10 min on a slow provider, and the leader's own round-5 note was
 * "remaining disagreements are minor and further rounds would repeat established
 * positions" — i.e. rounds 4-5 added latency, not signal. Greenfield exploration
 * keeps more breadth (5). Kinds absent here fall back to ABSOLUTE_MAX_ROUNDS.
 */
const KIND_MAX_ROUNDS: Record<string, number> = {
  implementation_plan: 3,
  decision: 3,
  evaluation: 3,
  investigation: 3,
  exploration: 5,
};

/**
 * Resolve the initial round budget + hard ceiling from the plan's output-shape kind
 * and the planner-proposed round count. Pure + exported for unit testing the cap.
 */
export function resolveDebateRoundBudget(
  planKind: string | undefined,
  plannedRounds: number | undefined,
): { maxRounds: number; effectiveCeiling: number; kindCapped: boolean } {
  const kindCap = planKind !== undefined ? KIND_MAX_ROUNDS[planKind] : undefined;
  const effectiveCeiling = Math.min(ABSOLUTE_MAX_ROUNDS, kindCap ?? ABSOLUTE_MAX_ROUNDS);
  const maxRounds = Math.min(
    effectiveCeiling,
    Math.max(1, typeof plannedRounds === "number" && plannedRounds > 0 ? plannedRounds : DEFAULT_PLANNED_ROUNDS),
  );
  return { maxRounds, effectiveCeiling, kindCapped: kindCap !== undefined };
}
/** Cap on the size of a single archived position. Anything longer is
 * trimmed and reported via `length`. Mirrors the goal of keeping the
 * follow-up memory record small enough to be reloaded cheaply. */
const ARCHIVE_EXCERPT_CHARS = 400;

function makeExcerpt(text: string): { excerpt: string; length: number } {
  const trimmed = text.trim();
  return {
    excerpt: trimmed.length > ARCHIVE_EXCERPT_CHARS ? `${trimmed.slice(0, ARCHIVE_EXCERPT_CHARS)}…` : trimmed,
    length: trimmed.length,
  };
}

/**
 * Emit the observe-only `council-turn-length` harness event for one fully-assembled
 * speaker turn (opening statement or discussion turn). Reports char + word count so
 * a harness can measure council verbosity per role/model/round — NO truncation, NO
 * behaviour change. Best-effort: a no-op when the agent runtime is absent (normal
 * user mode) or the event kind is filtered out (MUONROI_HARNESS_EVENTS). Uses the
 * same globalThis.__muonroiAgentRuntime emitter as sprint-runner.ts.
 */
function emitCouncilTurnLength(args: {
  role: string;
  round: number;
  text: string;
  model: string;
  correlationId: string;
}): void {
  try {
    const ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    if (!ar || typeof ar.emitEvent !== "function") return;
    const trimmed = args.text.trim();
    ar.emitEvent({
      t: "event",
      kind: "council-turn-length",
      role: args.role,
      round: args.round,
      charCount: trimmed.length,
      wordCount: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).filter(Boolean).length,
      model: args.model,
      correlationId: args.correlationId,
    });
  } catch (err) {
    // Observe-only telemetry — swallow so a harness hiccup can't break a debate turn.
    // Logged only under MUONROI_DEBUG_HARNESS (No-Silent-Catch) to keep TUI output clean.
    if (process.env.MUONROI_DEBUG_HARNESS === "1") {
      console.error(`[council] council-turn-length emit failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }
}

/**
 * Lock-phrase detector. Counts what fraction of pair-turns in the latest round
 * contain explicit convergence signals. When ≥80% of pair-turns signal "lock",
 * we force shouldContinue=false regardless of leader judgment — sessions like
 * ea13da132dec showed leader continuing past 3 rounds of "Everything Locked"
 * statements because per-round leader-eval slice doesn't weight phrase
 * frequency the same way a code-side count does.
 *
 * Phrases are intentionally broad and language-aware — debate prompt forces
 * English but synthesis might leak some Vietnamese in cross-language sessions.
 */
const LOCK_PHRASES = [
  // English — original phrases (kept for backward compatibility)
  /\bever[yi]thing\s+(is\s+)?locked\b/i,
  /\bfully\s+aligned\b/i,
  /\bcomplete\s+agreement\b/i,
  /\bno\s+remaining\s+(disputes|disagreements|concerns)\b/i,
  /\bdesign\s+(is\s+)?locked\b/i,
  /\barchitectural\s+decisions\s+(are\s+)?locked\b/i,
  /\bagree\s+on\s+where\s+we['']?ve\s+landed\b/i,
  /\bready\s+to\s+(proceed|move|start)\s+to\s+implementation\b/i,
  /\blet['']?s\s+proceed\s+to\s+implementation\b/i,
  /\bfinal\s+(position|confirmation)\b/i,
  // English — broader convergence vocabulary (council-mode upgrade A)
  /\b(i\s+)?(fully\s+|completely\s+)?(agree|agreed|concur)\s+(with|on)\b/i,
  /\bsigned?\s+off\b/i,
  /\bship\s+it\b/i,
  /\bno\s+(further\s+|more\s+)?(objections?|concerns?|issues?)\b/i,
  /\bgreen[\s-]?light\b/i,
  /\blooks?\s+good\s+to\s+(me|go)\b/i,
  /\bgood\s+to\s+(go|ship|proceed)\b/i,
  // Vietnamese — cross-language session safety.
  // NOTE: JS regex `\b` is ASCII-only; accented chars like "í", "ý", "ậ" are
  // treated as non-word, so a trailing `\b` after them never matches. Use
  // `(?=\s|[.,!?;:]|$)` as an explicit word-end guard instead.
  /(^|\s)nh[ấâ]t\s+tr[íi](?=\s|[.,!?;:]|$)/i,
  /(^|\s)[đd][ồô]ng\s+[ýy]\s+(ho[àa]n\s+to[àa]n|v[ớơ]i)(?=\s|[.,!?;:]|$)/i,
  /(^|\s)kh[ôo]ng\s+c[òo]n\s+(g[òo]p\s+[ýy]|[ýy]\s+ki[ếê]n|tranh\s+lu[ậâ]n)(?=\s|[.,!?;:]|$)/i,
  /(^|\s)s[ẵã]n\s+s[àa]ng\s+(tri[ểê]n\s+khai|implement)(?=\s|[.,!?;:]|$)/i,
  /(^|\s)ch[ốô]t\s+(s[ổô]|l[ạa]i|design)(?=\s|[.,!?;:]|$)/i,
];

// Negation guard — if a lock-phrase candidate appears inside a negation
// envelope, treat as NOT locked. Common patterns: "we don't agree",
// "not fully aligned", "tôi không nhất trí". Negation must be within 24 chars
// upstream of the match (heuristic: typical clause length).
const NEGATION_HEAD =
  /\b(don'?t|do\s+not|does\s+not|doesn'?t|cannot|can'?t|not|no(t)?\s+yet|haven'?t|hasn'?t|kh[ôo]ng|ch[ưu]a)\b/i;

function looksLocked(text: string): boolean {
  if (!text || text.length < 20) return false;
  for (const re of LOCK_PHRASES) {
    const match = re.exec(text);
    if (!match) continue;
    // Negation guard: scan a small window upstream for a negation head.
    const windowStart = Math.max(0, match.index - 24);
    const upstream = text.slice(windowStart, match.index);
    if (NEGATION_HEAD.test(upstream)) continue;
    return true;
  }
  return false;
}

function convergenceRatio(turns: string[]): number {
  const usable = turns.filter((t) => t && t.trim().length >= 20);
  if (usable.length === 0) return 0;
  const locked = usable.filter(looksLocked).length;
  return locked / usable.length;
}

/** True when a participant turn produced no usable content (provider error
 * or empty completion). Used by the circuit breaker. */
function isFailedTurn(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length === 0) return true;
  return /^\[debate failed:/i.test(t);
}

/**
 * Wraps a single llm.debate() call with one retry attempt on truly-empty
 * output (or transient provider exception). Session cd238632c2bf showed ~50%
 * turn-skip rate because the provider intermittently returned "" mid-debate
 * under load — a single retry with the same prompt recovers most of these
 * cases without inflating cost or context.
 *
 * Only EMPTY responses trigger retry — short-but-non-empty (e.g., a one-line
 * agreement) is valid content. Returns failureReason (instead of throwing)
 * when both attempts fail so the downstream renderer can surface *why* a turn
 * was skipped. The outer try/catch in the pair runner still catches anything
 * that escapes this helper.
 */
/**
 * Retry wrapper for opening statements. `llm.generate` has no built-in retry,
 * so a single timeout/error during the opening phase permanently removes that
 * stance from `active[]` and disables it for every subsequent round. We retry
 * up to MAX_OPENING_ATTEMPTS with linear backoff before giving up.
 */
const MAX_OPENING_ATTEMPTS = 3;
async function openingWithRetry(
  llm: CouncilLLM,
  model: string,
  system: string,
  prompt: string,
): Promise<{ text: string; attempts: number; error?: string }> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= MAX_OPENING_ATTEMPTS; attempt++) {
    try {
      const text = await llm.generate(model, system, prompt);
      if (text && text.trim().length > 0) {
        return { text, attempts: attempt };
      }
      lastError = "empty completion";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_OPENING_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return { text: "", attempts: MAX_OPENING_ATTEMPTS, error: lastError };
}

/**
 * Pick a debate fallback model on a DIFFERENT provider than `failedModel`.
 *
 * When a participant's model fails BOTH same-model attempts (e.g. opencode-go
 * proxy overload "Upstream request failed", or a param-reject that survives the
 * adapter-level degrade), retrying the same endpoint just fails again — live
 * session renders showed the same speaker dropped 3× in a row, silently
 * shrinking the debate. Falling back to any pooled council model on another
 * provider keeps that voice in the discussion. Returns undefined when every
 * pooled model resolves to the same provider (nothing to fall back to).
 */
function pickDebateFallbackModel(failedModel: string, pool: string[]): string | undefined {
  let failedProvider: string | undefined;
  try {
    failedProvider = detectProviderForModel(failedModel);
  } catch {
    failedProvider = undefined;
  }
  for (const candidate of pool) {
    if (candidate === failedModel) continue;
    let candidateProvider: string | undefined;
    try {
      candidateProvider = detectProviderForModel(candidate);
    } catch {
      continue;
    }
    if (candidateProvider && candidateProvider !== failedProvider) return candidate;
  }
  return undefined;
}

/**
 * Marker the CouncilLLM.research catch-block embeds in its return string when a
 * provider crashes (it returns a string, never throws — see llm.ts:737). Used
 * to detect a failed research pass so we can fall back to another provider.
 */
const RESEARCH_FAILED_MARKER = "[Research failed:";

/**
 * Runs council research on `primaryModel`; if the provider crashes (the
 * `[Research failed: …]` marker), retries ONCE on a pooled model resolving to a
 * DIFFERENT provider before giving up. Mirrors {@link pickDebateFallbackModel}.
 *
 * Motivating evidence: session de4bafe5ecb7 routed research to opencode-go
 * (Console Go "Upstream request failed") with no fallback. Research returned
 * only the failure marker → participants had zero citations to tag → evidence
 * density hard-zeroed → the debate scored "Low confidence 0%" despite being
 * substantive. debateWithRetry already had cross-provider fallback; research
 * did not.
 */
async function researchWithFallback(
  llm: CouncilLLM,
  primaryModel: string,
  topic: string,
  conversationContext: string,
  signal: AbortSignal | undefined,
  traceCb: (t: string) => void,
  options: { internetFirst?: boolean },
  fallbackPool: string[],
): Promise<string> {
  const primary = await llm.research(primaryModel, topic, conversationContext, signal, traceCb, options);
  if (!primary.includes(RESEARCH_FAILED_MARKER) || signal?.aborted) return primary;

  const fallbackModel = pickDebateFallbackModel(primaryModel, fallbackPool);
  if (!fallbackModel) return primary;

  traceCb(`[research] ${primaryModel} failed; retrying via ${fallbackModel} (different provider)`);
  try {
    const fb = await llm.research(fallbackModel, topic, conversationContext, signal, traceCb, options);
    if (!fb.includes(RESEARCH_FAILED_MARKER)) {
      traceCb(`[research] recovered via fallback ${fallbackModel}`);
      return fb;
    }
    // Both providers failed — surface the primary's marker so the existing
    // "research produced nothing" rendering still fires.
    return primary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    traceCb(`[research] fallback ${fallbackModel} also failed: ${msg}`);
    return primary;
  }
}

async function debateWithRetry(
  llm: CouncilLLM,
  model: string,
  system: string,
  prompt: string,
  signal: AbortSignal | undefined,
  traceCb: (t: string) => void,
  toolBudget: ToolBudget,
  fallbackPool: string[] = [],
): Promise<{
  text: string;
  toolCalls: Array<{ toolName: string; result?: unknown }>;
  failureReason?: string;
  attempts: number;
}> {
  // Respect the circuit breaker — once a model has tripped, it stays
  // tool-disabled for the rest of this council run.
  const allowTools = debateAllowsTools(model) && !toolBudget.disabled.has(model);
  let firstError: string | undefined;
  try {
    const result = await llm.debate(model, system, prompt, signal, traceCb, { enableVerificationTools: allowTools });
    const text = (result.text ?? "").trim();
    if (text.length > 0) {
      // Non-empty response — reset the streak counter for this model.
      toolBudget.emptyStreak.set(model, 0);
      return { text: result.text, toolCalls: result.toolCalls ?? [], attempts: 1 };
    }
    firstError = "empty completion";
    // Empty WHILE tools were enabled → bump the streak; trip the breaker on
    // the Nth consecutive empty, so subsequent turns skip tools.
    if (allowTools) {
      const next = (toolBudget.emptyStreak.get(model) ?? 0) + 1;
      toolBudget.emptyStreak.set(model, next);
      if (next >= MAX_EMPTY_WITH_TOOLS) {
        toolBudget.disabled.add(model);
      }
    }
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
  }

  // Retry once — if first attempt was tool-enabled and came back empty, the
  // reasoning model likely hit the step cap on a tool call without producing
  // text. Retry WITHOUT tools to guarantee analytical output.
  let retryError: string;
  let retryToolCalls: Array<{ toolName: string; result?: unknown }> = [];
  try {
    const retry = await llm.debate(model, system, prompt, signal, traceCb, { enableVerificationTools: false });
    const text = (retry.text ?? "").trim();
    if (text.length > 0) {
      return { text: retry.text, toolCalls: retry.toolCalls ?? [], attempts: 2 };
    }
    retryToolCalls = retry.toolCalls ?? [];
    retryError = "provider returned empty completion";
  } catch (err) {
    retryError = err instanceof Error ? err.message : String(err);
  }

  // Both same-model attempts failed. Before dropping this speaker from the
  // debate, try ONE cross-provider fallback — the primary endpoint is either
  // overloaded (opencode-go "Upstream request failed") or param-rejecting, and
  // a third same-model hit would just fail identically. Skip when the caller
  // aborted (user cancellation must not be papered over by a fallback call).
  if (!signal?.aborted) {
    const fallbackModel = pickDebateFallbackModel(model, fallbackPool);
    if (fallbackModel) {
      try {
        const fb = await llm.debate(fallbackModel, system, prompt, signal, traceCb, {
          enableVerificationTools: false,
        });
        const text = (fb.text ?? "").trim();
        if (text.length > 0) {
          traceCb(`[debate] ${model} failed both attempts; recovered via fallback ${fallbackModel}`);
          return { text: fb.text, toolCalls: fb.toolCalls ?? [], attempts: 3 };
        }
      } catch (err) {
        const fbMsg = err instanceof Error ? err.message : String(err);
        traceCb(`[debate] fallback ${fallbackModel} for ${model} also failed: ${fbMsg}`);
      }
    }
  }

  return {
    text: "",
    toolCalls: retryToolCalls,
    failureReason: `both attempts failed — initial: ${firstError}; retry: ${retryError}`,
    attempts: 2,
  };
}

export async function* runDebate(
  spec: ClarifiedSpec,
  config: CouncilConfig,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, DebateState, unknown> {
  const { leaderModelId, participants, conversationContext, signal, debatePlan } = config;
  // Cross-provider fallback pool for debateWithRetry: leader + every
  // participant model, deduped. When a speaker's model fails both same-model
  // attempts, debateWithRetry retries once on the first pooled model whose
  // provider differs, so an overloaded provider (opencode-go) can't silently
  // drop a voice from the debate.
  const fallbackPool = Array.from(new Set([leaderModelId, ...participants.map((p) => p.model)]));
  // Correlation id for the observe-only council-turn-length telemetry (groups
  // per-turn length samples by run). sessionId in production; a stable literal
  // for direct callers/tests that omit runId.
  const turnCorrelationId = config.runId ?? "council";
  const researchSkipOverride = config.researchSkipOverride === true;
  const leaderNeedsResearch = config.leaderNeedsResearch;
  const internetFirst = config.internetFirst === true;
  const costAware = config.costAware === true;
  const active: CouncilParticipant[] = [];
  const exchangeLogs: Map<string, string[]> = new Map();
  const archive: import("./types.js").DebateArchiveEntry[] = [];
  let runningSummary = "";
  let researchFindings: string | undefined;
  let lastEvidenceDensity: number | undefined;
  // Per-session circuit breaker for verification tools. Models that return
  // empty completions twice in a row while tools were enabled get bumped to
  // tool-free for the remainder of this council run.
  const toolBudget = makeToolBudget();
  // Track which models we've already announced as tool-disabled so we don't
  // emit the same "circuit breaker tripped" message every round.
  const announcedDisabled = new Set<string>();

  // ── Leader decides: research needed? (skipped if user overrode upstream) ──
  // Reuse the leader's upstream research decision (computed once in runCouncil)
  // when available; only run the classifier here for direct callers that did not
  // pre-compute it. Avoids a duplicate leader-tier LLM call per council run.
  const needsResearch = researchSkipOverride
    ? false
    : (leaderNeedsResearch ?? (yield* evaluateResearchNeed(spec, leaderModelId, conversationContext, llm, costAware)));

  if (researchSkipOverride) {
    yield {
      type: "content",
      content: `\n> Research skipped by user override.\n`,
    };
  }

  if (needsResearch) {
    const p0Start = Date.now();
    const researchCandidate = participants.find((c) => c.role === "research") ?? participants[0];
    yield phaseStart({
      phaseId: "phase:research",
      kind: "research",
      label: internetFirst ? "Research (internet-first)" : "Research",
      detail: `via ${researchCandidate.model}`,
    });

    const researchTraces: string[] = [];
    researchFindings = yield* tracedAsync(
      () =>
        researchWithFallback(
          llm,
          researchCandidate.model,
          spec.problemStatement,
          conversationContext,
          signal,
          (t) => researchTraces.push(t),
          { internetFirst },
          fallbackPool,
        ),
      {
        phase: "research",
        label: internetFirst ? "Researching (internet-first)" : "Researching codebase",
        detail: spec.problemStatement.slice(0, 80),
        role: "research",
      },
    );
    // CQ-22: emit research tool traces as council_status
    for (const trace of researchTraces) {
      yield { type: "council_status" as const, content: trace };
    }
    yield phaseDone({
      phaseId: "phase:research",
      kind: "research",
      label: "Research",
      startedAt: p0Start,
      detail: `via ${researchCandidate.model}`,
    });
    yield {
      type: "council_message" as const,
      councilMessage: {
        kind: "research" as const,
        speaker: { role: researchCandidate.role, model: researchCandidate.model },
        text: researchFindings ?? "",
      },
    };
  }

  const enrichedContext = researchFindings
    ? `${conversationContext}\n\n---\n\n## Research Findings\n${researchFindings}`
    : conversationContext;

  // ── Phase 1: Parallel opening statements ───────────────────────────────────
  const p1Start = Date.now();
  yield phaseStart({
    phaseId: "phase:opening",
    kind: "opening",
    label: "Opening analysis",
    detail: `${participants.length} participants in parallel`,
  });

  const openingPromises = participants.map((self) => {
    const partner = participants.find((c) => c.role !== self.role) ?? participants[0];
    const { system, prompt } = buildOpeningPrompt({
      speakerRole: self.role,
      partnerRole: partner.role,
      speakerStance: self.stance,
      partnerStance: partner.stance,
      spec,
      outputShape: debatePlan?.outputShape,
      conversationContext: enrichedContext,
    });
    return openingWithRetry(llm, self.model, system, prompt).then((r) => ({
      role: self.role,
      model: self.model,
      stance: self.stance,
      position: r.text,
      error: r.text ? null : (r.error ?? "empty completion after retries"),
      attempts: r.attempts,
    }));
  });

  const openings = yield* tracedAsync(() => Promise.all(openingPromises), {
    phase: "opening",
    label: `Generating opening statements (${participants.length} participants in parallel)`,
    // Newline-joined "Name — lens" roster so the composing placeholder shows WHAT
    // each speaker is tasked to argue (A: live debate preview) instead of a bare
    // spinner during the atomic generateText window.
    detail: formatSpeakerRoster(participants),
  });

  yield { type: "content", content: "\n── Opening Analysis ──\n" };
  for (const o of openings) {
    const speakerRole = o.stance?.name ?? o.role;
    if (o.error) {
      yield {
        type: "council_message",
        councilMessage: {
          kind: "debate",
          speaker: { role: speakerRole, model: o.model },
          round: 0,
          text: `[Error: ${o.error}]`,
          attempts: o.attempts,
          failureReason: o.error,
        },
      };
    } else {
      active.push({ role: o.role as any, model: o.model, position: o.position, stance: o.stance });
      archive.push({
        round: 0,
        role: o.role as any,
        model: o.model,
        stanceName: o.stance?.name,
        ...makeExcerpt(o.position),
      });
      yield {
        type: "council_message",
        councilMessage: {
          kind: "debate",
          speaker: { role: speakerRole, model: o.model },
          round: 0,
          text: o.position,
          attempts: o.attempts,
        },
      };
      emitCouncilTurnLength({
        role: speakerRole,
        round: 0,
        text: o.position,
        model: o.model,
        correlationId: turnCorrelationId,
      });
    }
  }

  yield phaseDone({
    phaseId: "phase:opening",
    kind: "opening",
    label: "Opening analysis",
    startedAt: p1Start,
    detail: `${active.length}/${participants.length} participants succeeded`,
  });

  if (active.length < 2) {
    yield { type: "content", content: "\nNot enough successful openings for discussion.\n" };
    return { spec, exchangeLogs, runningSummary: "", roundCount: 0, researchFindings, active, archive };
  }

  // ── Phase 2: Dynamic discussion rounds ─────────────────────────────────────
  // Leader-decided round budget: planner proposes an initial value, leader
  // evaluation can extend it via `extendRounds`, capped at the hard ceiling.
  //
  // implementation_plan kind gets a kind-specific cap of 3 rounds. Observed
  // sessions (f83c278f2162, ea13da132dec) showed that R4 on implementation
  // topics never added new content — it was always "Final Confirmation /
  // Lock Confirmed" wrappers. The kind-cap saves ~150s with zero quality
  // loss on this kind. Other kinds (investigation, exploration) may
  // legitimately benefit from a 4th round of evidence-gathering, so the
  // absolute ceiling still applies there.
  let roundCount = 0;
  const planKind = debatePlan?.outputShape?.kind;
  const {
    maxRounds: plannedMaxRounds,
    effectiveCeiling,
    kindCapped,
  } = resolveDebateRoundBudget(planKind, debatePlan?.plannedRounds);
  let maxRounds = plannedMaxRounds;
  const ceilingNote = kindCapped
    ? ` (hard ceiling ${effectiveCeiling} for ${planKind})`
    : ` (hard ceiling ${ABSOLUTE_MAX_ROUNDS})`;
  yield {
    type: "content",
    content: `\n> Leader-proposed debate budget: ${maxRounds} round${maxRounds === 1 ? "" : "s"}${ceilingNote}.\n`,
  };
  // P3 — structured budget/ceiling for the context rail. These are locals here,
  // invisible to the council entrypoint, so they ride a separate council_meta
  // patch that the UI upsert-merges with the leader/panel patch.
  yield {
    type: "council_meta",
    councilMeta: {
      roundBudget: maxRounds,
      roundCeiling: kindCapped ? effectiveCeiling : ABSOLUTE_MAX_ROUNDS,
    },
  };

  // Pairs that fail twice in a row are dropped from subsequent rounds so the
  // remaining participants don't keep retrying a broken model and inflating
  // the persistent transcript with failure noise.
  const consecutivePairFailures = new Map<string, number>();
  const droppedPairKeys = new Set<string>();
  // Stop debate entirely after two consecutive rounds where ≥50% of pairs fail
  // — the LLM is clearly under provider stress and more rounds won't help.
  let consecutiveRoundFailures = 0;
  // P5 — topic carried from the prior round's leader nextRoundFocus, shown as the
  // next round's heading in the round-grouped transcript.
  let nextTopic: string | undefined;
  // B5 — prior round's aligned criteriaMet, so each round's directive/verdict
  // and the post-debate unmet-flag know what is still open. Empty before round 1
  // → the round-1 directive treats every criterion as unmet.
  let lastCriteriaMet: boolean[] = [];
  // B4 — leader auto-remedy progress tracking. `bestCriteriaMetCount` is the
  // high-water mark of pinned criteria met; `roundsSinceProgress` counts
  // consecutive evaluated rounds that produced no NEW met criterion. Auto-extend
  // fires only while progress is being made; a stuck criterion (no progress for
  // 2 rounds) stops the budget burn and drops to a diagnostic closing verdict.
  let bestCriteriaMetCount = 0;
  let roundsSinceProgress = 0;
  // B4 interactive escalation — fires at most once per debate. `escalation`
  // records the user's choice at a stop-with-unmet boundary for the DebateState.
  let escalated = false;
  let escalation: DebateState["escalation"] | undefined;

  // Shared applier for the two stop-with-unmet boundaries (leader voluntarily
  // stopped, or the budget exhausted while stuck/at ceiling). Reassigns the
  // loop's round budget via closure; returns whether the debate should keep
  // going. Caller must have already checked the gate (responder wired, flag on,
  // not yet escalated, criteria unmet).
  async function* escalateStop(
    stuck: boolean,
    pinnedUnmet: number,
    openList: string[],
  ): AsyncGenerator<StreamChunk, "extend" | "stop", unknown> {
    escalated = true;
    const dec = yield* runEscalationPrompt({
      respondToQuestion: config.respondToQuestion!,
      openCriteria: openList,
      pinnedUnmet,
      stuck,
      atAbsoluteMax: maxRounds >= ABSOLUTE_MAX_ROUNDS,
      currentMax: maxRounds,
    });
    escalation = { action: dec.action, grantedRounds: dec.grantedRounds || undefined };
    if (dec.action === "extend" && dec.grantedRounds > 0) {
      maxRounds += dec.grantedRounds;
      roundsSinceProgress = 0;
      if (!nextTopic) nextTopic = `Close the unmet criteria: ${openList.join("; ")}`;
      return "extend";
    }
    return "stop";
  }

  for (let round = 1; round <= maxRounds; round++) {
    // User cancelled mid-debate — stop before spending another round of
    // parallel pair LLM calls. The caller (runCouncil) re-checks the signal at
    // its next phase boundary and skips synthesis too.
    if (signal?.aborted) {
      yield { type: "content", content: `\n> Debate cancelled by user.\n` };
      break;
    }
    roundCount = round;
    // Set when the user extends the debate at this round's stop boundary (B4
    // escalation). Guards the convergence-exit below so a user "extend" isn't
    // immediately overridden by a lock-phrase convergence break.
    let userExtendedThisRound = false;
    const p2Start = Date.now();
    const roundPhaseId = `phase:round-${round}`;
    yield phaseStart({
      phaseId: roundPhaseId,
      kind: "round",
      label: `Discussion round ${round}`,
    });

    // Canonicalize key by sorting roles so symmetric pairs (A↔B and B↔A)
    // collapse to a single entry. With only 2 active participants the ring
    // topology would otherwise emit both (i=0,i=1) and run the same logical
    // pair twice, producing duplicate "X → Y" turns in every round.
    const pairs: Array<{ a: CouncilParticipant; b: CouncilParticipant; key: string }> = [];
    const seenPairKeys = new Set<string>();
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      const b = active[(i + 1) % active.length];
      const [r1, r2] = [a.role, b.role].sort();
      const key = `${r1}<>${r2}`;
      if (seenPairKeys.has(key)) continue;
      seenPairKeys.add(key);
      if (droppedPairKeys.has(key)) continue;
      if (!exchangeLogs.has(key)) exchangeLogs.set(key, []);
      pairs.push({ a, b, key });
    }
    if (pairs.length === 0) {
      yield {
        type: "content",
        content: `\n> All debate pairs disabled by circuit breaker — ending debate at round ${round - 1}.\n`,
      };
      roundCount = round - 1;
      break;
    }

    // P5 — round lifecycle for the grouped transcript. `roundRec` closes over
    // this round's participants/pairCount/emergent/topic; a running record now,
    // a guaranteed done record on every exit below.
    // Surface the task-adaptive persona (or model id), never the internal
    // implement/verify/research cost-tier slot — that slot is a routing detail
    // that misleads on analysis/decision topics (observed session dd34c59c63e9:
    // an "evaluation" debate showed a bogus "implement" member).
    const roundParticipants = active.map((p) => p.stance?.name ?? p.model);
    const roundEmergent = round > plannedMaxRounds;
    const roundTopic = nextTopic;
    const roundRec = (
      state: "running" | "done",
      patch: Partial<import("../types/index.js").CouncilRoundRecord> = {},
    ): StreamChunk => ({
      type: "council_round" as const,
      councilRound: {
        round,
        state,
        topic: roundTopic,
        participants: roundParticipants,
        pairCount: pairs.length,
        emergent: roundEmergent,
        ...patch,
      },
    });
    yield roundRec("running");

    // B5 — pre-round leader DIRECTIVE. Before the exchanges run, the leader
    // states this round's goal and which pinned criteria are still unmet, so it
    // visibly conducts each round instead of only grading afterwards. Gated on
    // pinned criteria (nothing to steer toward otherwise) + the conductor flag.
    // Captured in `roundDirective` so it also lands on the round record's
    // `directive` field below — durable in the conclusion card, not only the
    // ephemeral live bubble a user misses if they look away mid-debate.
    let roundDirective: string | undefined;
    if (leaderConductorEnabled() && spec.successCriteria.length > 0) {
      roundDirective = buildLeaderDirective(round, spec.successCriteria, lastCriteriaMet, roundTopic);
      yield {
        type: "council_message" as const,
        councilMessage: {
          kind: "leader" as const,
          phase: "directive" as const,
          speaker: { role: "Leader", model: leaderModelId },
          round,
          text: roundDirective,
        },
      };
    }

    const pairResults = yield* tracedAsync(
      () =>
        Promise.all(
          pairs.map(async ({ a, b, key }) => {
            const log = exchangeLogs.get(key)!;
            const chunks: Array<{
              label: string;
              text: string;
              toolCalls?: Array<{ toolName: string; result?: unknown }>;
              traces?: string[];
              failureReason?: string;
              attempts?: number;
            }> = [];

            try {
              let aResponse: string;
              let bResponse: string;
              let aToolCalls: Array<{ toolName: string; result?: unknown }> = [];
              let bToolCalls: Array<{ toolName: string; result?: unknown }> = [];

              const aLabel = a.stance?.name ?? a.role;
              const bLabel = b.stance?.name ?? b.role;
              if (round === 1) {
                const aPrompt = buildResponsePrompt({
                  speakerRole: a.role,
                  partnerRole: b.role,
                  speakerStance: a.stance,
                  partnerStance: b.stance,
                  speakerPosition: a.position,
                  partnerPosition: b.position,
                  spec,
                });
                const aTraces: string[] = [];
                const aResult = await debateWithRetry(
                  llm,
                  a.model,
                  aPrompt.system,
                  aPrompt.prompt,
                  signal,
                  (t) => aTraces.push(t),
                  toolBudget,
                  fallbackPool,
                );
                aResponse = aResult.text;
                aToolCalls = aResult.toolCalls;
                log.push(`[${aLabel}]: ${aResponse}`);
                chunks.push({
                  label: `[${aLabel}] → [${bLabel}]`,
                  text: aResponse,
                  toolCalls: aToolCalls,
                  traces: aTraces,
                  failureReason: aResult.failureReason,
                  attempts: aResult.attempts,
                });

                const bPrompt = buildResponsePrompt({
                  speakerRole: b.role,
                  partnerRole: a.role,
                  speakerStance: b.stance,
                  partnerStance: a.stance,
                  speakerPosition: b.position,
                  partnerPosition: aResponse,
                  spec,
                });
                const bTraces: string[] = [];
                const bResult = await debateWithRetry(
                  llm,
                  b.model,
                  bPrompt.system,
                  bPrompt.prompt,
                  signal,
                  (t) => bTraces.push(t),
                  toolBudget,
                  fallbackPool,
                );
                bResponse = bResult.text;
                bToolCalls = bResult.toolCalls;
                log.push(`[${bLabel}]: ${bResponse}`);
                chunks.push({
                  label: `[${bLabel}] → [${aLabel}]`,
                  text: bResponse,
                  toolCalls: bToolCalls,
                  traces: bTraces,
                  failureReason: bResult.failureReason,
                  attempts: bResult.attempts,
                });
              } else {
                // No longer pass the full exchange history — `runningSummary` (LLM-
                // generated condensation) plus the partner's latest single position
                // is enough for the next stance turn. Replaying every prior message
                // is what caused the 3M-token requests in production.
                const aPrompt = buildFollowupPrompt({
                  speakerRole: a.role,
                  partnerRole: b.role,
                  speakerStance: a.stance,
                  partnerStance: b.stance,
                  partnerPosition: b.position,
                  speakerLastPosition: a.position,
                  round,
                  runningSummary,
                  spec,
                });
                const aTraces: string[] = [];
                const aResult = await debateWithRetry(
                  llm,
                  a.model,
                  aPrompt.system,
                  aPrompt.prompt,
                  signal,
                  (t) => aTraces.push(t),
                  toolBudget,
                  fallbackPool,
                );
                aResponse = aResult.text;
                aToolCalls = aResult.toolCalls;
                log.push(`[${aLabel}] (round ${round}): ${aResponse}`);
                chunks.push({
                  label: `[${aLabel}] → [${bLabel}]`,
                  text: aResponse,
                  toolCalls: aToolCalls,
                  traces: aTraces,
                  failureReason: aResult.failureReason,
                  attempts: aResult.attempts,
                });

                const bPrompt = buildFollowupPrompt({
                  speakerRole: b.role,
                  partnerRole: a.role,
                  speakerStance: b.stance,
                  partnerStance: a.stance,
                  partnerPosition: aResponse,
                  speakerLastPosition: b.position,
                  round,
                  runningSummary,
                  spec,
                });
                const bTraces: string[] = [];
                const bResult = await debateWithRetry(
                  llm,
                  b.model,
                  bPrompt.system,
                  bPrompt.prompt,
                  signal,
                  (t) => bTraces.push(t),
                  toolBudget,
                  fallbackPool,
                );
                bResponse = bResult.text;
                bToolCalls = bResult.toolCalls;
                log.push(`[${bLabel}] (round ${round}): ${bResponse}`);
                chunks.push({
                  label: `[${bLabel}] → [${aLabel}]`,
                  text: bResponse,
                  toolCalls: bToolCalls,
                  traces: bTraces,
                  failureReason: bResult.failureReason,
                  attempts: bResult.attempts,
                });
              }

              // Only update positions when response is non-empty (avoid clearing on LLM error)
              if (bResponse) b.position = bResponse;
              if (aResponse) a.position = aResponse;
              return { key, chunks, error: null as string | null };
            } catch (err: unknown) {
              return { key, chunks, error: err instanceof Error ? err.message : String(err) };
            }
          }),
        ),
      {
        phase: "exchange",
        label: `Discussion round ${round} (${pairs.length} pair${pairs.length === 1 ? "" : "s"})`,
        // Distinct speakers with their lens (A: live debate preview) — dedup by
        // formatted line so a speaker appearing in two pairs shows once.
        detail: formatSpeakerRoster(pairs.flatMap((p) => [p.a, p.b])),
      },
    );

    yield { type: "content", content: `\n── Round ${round} ──\n` };
    // Track failures so the circuit breaker can fire after this round.
    let failedPairCount = 0;
    for (const pr of pairResults) {
      const pairFailed = pr.chunks.every((c) => isFailedTurn(c.text));
      if (pairFailed) {
        failedPairCount++;
        const prev = consecutivePairFailures.get(pr.key) ?? 0;
        const next = prev + 1;
        consecutivePairFailures.set(pr.key, next);
        if (next >= 2) {
          droppedPairKeys.add(pr.key);
          yield {
            type: "content",
            content: `\n> Pair \`${pr.key}\` dropped after 2 consecutive failed rounds.\n`,
          };
        }
      } else {
        consecutivePairFailures.set(pr.key, 0);
      }

      // Archive entries — only successful turns, with size-bounded excerpts.
      for (const chunk of pr.chunks) {
        const labelParts = chunk.label.match(/\[([^\]]+)\] → \[([^\]]+)\]/);
        const speakerName = labelParts?.[1] ?? "speaker";
        const partnerName = labelParts?.[2] ?? "partner";
        const failed = isFailedTurn(chunk.text);
        if (labelParts && !failed) {
          const speaker = active.find((a) => (a.stance?.name ?? a.role) === speakerName);
          if (speaker) {
            archive.push({
              round,
              role: speaker.role,
              model: speaker.model,
              stanceName: speaker.stance?.name,
              ...makeExcerpt(chunk.text),
              toolsUsed: chunk.toolCalls?.map((t) => t.toolName),
            });
          }
        }
        if (failed) {
          // Render a single muted line for failed turns. Always include the
          // failure reason so the user can distinguish "model overloaded" from
          // "prompt rejected" — opaque "turn skipped" hid real provider bugs
          // in past sessions (cd238632c2bf had ~50% skips with no explanation).
          const reason = chunk.failureReason ?? "no content produced (provider returned empty after retry)";
          yield {
            type: "content",
            content: `\n>  ⨯  **${speakerName}** → ${partnerName} _(skipped: ${reason})_\n`,
          };
        } else {
          const modelId = active.find((a) => (a.stance?.name ?? a.role) === speakerName)?.model ?? "";
          yield {
            type: "council_message" as const,
            councilMessage: {
              kind: "debate" as const,
              speaker: { role: speakerName, model: modelId },
              partner: { role: partnerName },
              round,
              text: chunk.text.trim(),
              toolCalls: chunk.toolCalls?.map((t) => ({ name: t.toolName })),
              attempts: chunk.attempts,
            },
          };
          emitCouncilTurnLength({
            role: speakerName,
            round,
            text: chunk.text,
            model: modelId,
            correlationId: turnCorrelationId,
          });
        }
        for (const trace of chunk.traces ?? []) {
          yield { type: "council_status" as const, content: trace };
        }
      }
      if (pr.error) {
        yield { type: "content", content: `[Discussion error: ${pr.error}]\n` };
      }
    }

    yield phaseDone({
      phaseId: roundPhaseId,
      kind: "round",
      label: `Discussion round ${round}`,
      startedAt: p2Start,
      detail: `${pairs.length} pair${pairs.length === 1 ? "" : "s"} exchanged`,
    });

    // Surface circuit-breaker trips so the user knows why a Flash-tier
    // stance suddenly stopped producing [CONFIRMED via …] tags.
    for (const m of toolBudget.disabled) {
      if (!announcedDisabled.has(m)) {
        announcedDisabled.add(m);
        yield {
          type: "content",
          content: `\n> Tool-verification circuit breaker tripped for \`${m}\` after ${MAX_EMPTY_WITH_TOOLS} consecutive empty completions. Subsequent turns from this model will run tool-free.\n`,
        };
      }
    }

    // ── Per-round persistence: emit [Council Round N] system message ──────────
    // Keep successful turns in full; replace failed turns with a one-line
    // stub carrying the failureReason. Stubs are tiny (well under 200 chars)
    // so they don't bloat context, but they preserve enough information that
    // a future /export or /resume can explain why a participant fell silent
    // mid-debate — opaque skip-only persistence hid real provider bugs.
    const roundSummaryText = pairResults
      .flatMap((pr) => pr.chunks)
      .map((c) => {
        if (isFailedTurn(c.text)) {
          const reason = c.failureReason ?? "no content produced";
          return `${c.label} (skipped): ${reason}`;
        }
        const toolSuffix = c.toolCalls?.length ? ` [tools: ${c.toolCalls.map((t) => t.toolName).join(", ")}]` : "";
        const retrySuffix = c.attempts && c.attempts > 1 ? " [recovered on retry]" : "";
        return `${c.label}${retrySuffix}: ${c.text}${toolSuffix}`;
      })
      .join("\n\n");
    if (roundSummaryText) {
      const roundPersistText = `[Council Round ${round}]\n${roundSummaryText}`;
      yield { type: "council_status" as const, content: roundPersistText };
    }

    // ── Circuit breaker: stop early on sustained provider failure ─────────────
    const failureRatio = pairs.length > 0 ? failedPairCount / pairs.length : 0;
    if (failureRatio >= 0.5) {
      consecutiveRoundFailures++;
      yield {
        type: "content",
        content: `\n> Round ${round}: ${failedPairCount}/${pairs.length} pairs failed (provider stress). Consecutive bad rounds: ${consecutiveRoundFailures}.\n`,
      };
      if (consecutiveRoundFailures >= 2) {
        yield {
          type: "content",
          content: `\n> Circuit breaker: aborting debate after ${consecutiveRoundFailures} consecutive failure-heavy rounds — proceeding to synthesis with what we have.\n`,
        };
        yield roundRec("done", {
          leaderDecision: "circuit-break",
          leaderReason: "provider stress — circuit breaker",
          directive: roundDirective,
        });
        break;
      }
    } else {
      consecutiveRoundFailures = 0;
    }

    // ── Leader evaluation (replaces self-evaluated convergence) ──────────────
    const evalPhaseId = `phase:evaluation-${round}`;
    const evalStart = Date.now();
    yield phaseStart({
      phaseId: evalPhaseId,
      kind: "evaluation",
      label: `Leader evaluation (round ${round})`,
    });
    const allExchangeText = [...exchangeLogs.values()].flat().slice(-8).join("\n\n");
    let evaluation = yield* evaluateDebate(spec, allExchangeText, round, leaderModelId, llm, costAware);
    // Eval robustness: the leader's cost-tier eval model can be on a flaky proxy
    // (Console Go glm/kimi → "Upstream request failed") while panel models on
    // other providers stay healthy. Rather than surface "evaluation unavailable"
    // and lose the round outcome, retry the eval on each healthy model in the
    // fallback pool before giving up. Bounded (pool is small) and only runs on the
    // failure path, so successful evals pay nothing.
    if (!evaluation) {
      // Which model the primary eval already tried (skip re-hitting it). Defensive
      // against a partially-mocked leader module in tests — if we can't resolve
      // it, skip the fallback loop rather than throw.
      let firstTried: string | null = null;
      try {
        firstTried = pickCouncilTaskModel("evaluate_round", leaderModelId, costAware);
      } catch {
        firstTried = null;
      }
      if (firstTried) {
        for (const fallbackModel of fallbackPool) {
          if (fallbackModel === firstTried) continue;
          evaluation = yield* evaluateDebate(
            spec,
            allExchangeText,
            round,
            leaderModelId,
            llm,
            costAware,
            fallbackModel,
          );
          if (evaluation) break;
        }
      }
    }

    if (evaluation) {
      if (typeof evaluation.evidenceDensity === "number") {
        lastEvidenceDensity = evaluation.evidenceDensity;
      }
      const metCount = evaluation.criteriaStatus.filter((c) => c.met).length;
      const total = evaluation.criteriaStatus.length;
      // B2/B3: project this round's evaluation onto the PINNED spec criteria
      // (index-aligned, best-effort text match as a fallback) and push it to the
      // rail so the user sees live ✓/○ against the exact outcome they saw — not
      // an opaque "N/M". Only when the spec has real pinned criteria.
      const hasPinned = spec.successCriteria.length > 0;
      const aligned = hasPinned ? alignCriteriaMet(spec.successCriteria, evaluation.criteriaStatus) : [];
      // Count of pinned criteria still open this round — used by both auto-remedy
      // and the interactive escalation boundaries below.
      const pinnedUnmet = hasPinned ? aligned.filter((m) => !m).length : 0;
      if (hasPinned) {
        yield {
          type: "council_meta" as const,
          councilMeta: { criteriaMet: aligned },
        };
        lastCriteriaMet = aligned; // B5: feed next round's directive + final unmet-flag
        // B4: track progress against the PINNED criteria. A round that meets a new
        // criterion resets the stuck counter; a round that meets nothing new
        // increments it. Auto-remedy reads these to decide extend-vs-give-up.
        const pinnedMetNow = aligned.filter(Boolean).length;
        if (pinnedMetNow > bestCriteriaMetCount) {
          bestCriteriaMetCount = pinnedMetNow;
          roundsSinceProgress = 0;
        } else {
          roundsSinceProgress++;
        }
      }
      yield phaseDone({
        phaseId: evalPhaseId,
        kind: "evaluation",
        label: `Leader evaluation (round ${round})`,
        startedAt: evalStart,
        detail: `${metCount}/${total} criteria met · ${evaluation.reason.slice(0, 80)}`,
      });
      // B5: post-round VERDICT. With pinned criteria + conductor on, list each
      // criterion's ✓/○ and the focus handed to the next round; otherwise fall
      // back to the plain one-line eval (pre-B5 behavior).
      const verdictText =
        leaderConductorEnabled() && hasPinned
          ? buildLeaderVerdict(spec.successCriteria, aligned, evaluation.reason, evaluation.nextRoundFocus)
          : `${metCount}/${total} criteria met — ${evaluation.reason}`;
      yield {
        type: "council_message" as const,
        councilMessage: {
          kind: "leader" as const,
          phase: leaderConductorEnabled() && hasPinned ? ("verdict" as const) : undefined,
          speaker: { role: "Leader", model: leaderModelId },
          round,
          text: verdictText,
        },
      };

      // P5 — guaranteed done record for this round. Decision reflects the
      // LEADER's intent (extend / continue / stop); a later code-side convergence
      // override that stops the loop is a separate mechanism and doesn't rewrite
      // the leader's stated call. Carry the leader's nextRoundFocus to the next
      // round's topic.
      const leaderDecision =
        typeof evaluation.extendRounds === "number" && evaluation.extendRounds > 0
          ? ("extend" as const)
          : evaluation.shouldContinue
            ? ("continue" as const)
            : ("stop" as const);
      yield roundRec("done", {
        criteriaMet: metCount,
        criteriaTotal: total,
        leaderReason: evaluation.reason,
        leaderDecision,
        nextRoundFocus: evaluation.nextRoundFocus,
        directive: roundDirective,
      });
      nextTopic = evaluation.nextRoundFocus;

      if (evaluation.needsResearch && evaluation.researchQuery) {
        const midPhaseId = `phase:mid-research-${round}`;
        const midStart = Date.now();
        yield phaseStart({
          phaseId: midPhaseId,
          kind: "mid_research",
          label: "Mid-debate research",
          detail: evaluation.researchQuery.slice(0, 80),
        });
        const researchCandidate = participants.find((c) => c.role === "research") ?? participants[0];
        const midTraces: string[] = [];
        const findings = yield* tracedAsync(
          () =>
            researchWithFallback(
              llm,
              researchCandidate.model,
              evaluation.researchQuery!,
              enrichedContext,
              signal,
              (t) => midTraces.push(t),
              {},
              fallbackPool,
            ),
          {
            phase: "research",
            label: "Mid-debate research",
            detail: evaluation.researchQuery.slice(0, 80),
            role: "research",
          },
        );
        // CQ-22: emit mid-debate research tool traces
        for (const trace of midTraces) {
          yield { type: "council_status" as const, content: trace };
        }
        yield phaseDone({
          phaseId: midPhaseId,
          kind: "mid_research",
          label: "Mid-debate research",
          startedAt: midStart,
          detail: evaluation.researchQuery.slice(0, 80),
        });
        // Research may return empty / whitespace-only when tools fail or the
        // model finds nothing concrete. Render a visible marker so the user
        // sees that research happened but produced nothing — earlier sessions
        // showed a bare "### Mid-debate Research" with empty body which
        // looked like a rendering bug.
        const trimmedFindings = (findings ?? "").trim();
        const renderedFindings =
          trimmedFindings.length > 0
            ? trimmedFindings
            : "_No new evidence found — the research call returned no content. " +
              "This usually means the model could not verify the disputed claim with the available tools._";
        yield { type: "content", content: `\n### Mid-debate Research\n${renderedFindings}\n` };
        // Only feed real findings back into the exchange logs — empty/placeholder
        // text would bloat context without adding signal.
        if (trimmedFindings.length > 0) {
          for (const log of exchangeLogs.values()) {
            log.push(`[research findings]: ${trimmedFindings}`);
          }
        }
      }

      if (!evaluation.shouldContinue) {
        // B4 escalation site 1 — the leader is declaring the debate done. If
        // pinned criteria are still unmet and we have an interactive channel,
        // ask the user before accepting a partial outcome (the "3/5 → stop,
        // synthesize as if done" gap). An "extend" cancels the stop and runs
        // more rounds; accept/rescope confirm it.
        if (
          config.respondToQuestion &&
          leaderEscalationEnabled() &&
          !escalated &&
          hasPinned &&
          pinnedUnmet > 0 &&
          // Respect the leader's own verdict: if it declared every criterion met,
          // don't second-guess it with the fuzzy per-criterion alignment (which
          // can miss a match and show a false unmet). Escalate only on a genuine
          // stop-with-unmet the leader itself signalled.
          !evaluation.allCriteriaMet
        ) {
          const openList = spec.successCriteria.filter((_, i) => !aligned[i]).map((c) => shortCriterion(c, 56));
          const outcome = yield* escalateStop(roundsSinceProgress >= 2, pinnedUnmet, openList);
          if (outcome === "extend") {
            userExtendedThisRound = true;
            // Fall through — the loop runs the user-granted rounds. Skip the
            // convergence + auto-remedy stop-logic below (both assume a natural
            // stop); the inter-round summary still runs.
          } else {
            break;
          }
        } else {
          yield {
            type: "content",
            content: `\n> Leader decided: debate sufficient at round ${round}.\n`,
          };
          break;
        }
      }

      // Code-side convergence override. When the latest round had ≥80% of
      // pair-turns containing lock phrases ("everything locked", "fully
      // aligned", "ready to proceed"), we end the debate regardless of
      // leader judgment. The leader's per-round slice (-8 turns) sometimes
      // misses cross-pair convergence frequency; this catches it explicitly.
      //
      // Round 1 exit is gated on the leader confirming no unresolved points
      // remain — convergence vocabulary alone at round 1 isn't enough since
      // the skeptic stance may still surface fresh risks late in the round.
      // From round 2 onward, lock ratio alone is sufficient.
      const lastRoundTurns = pairResults.flatMap((pr) => pr.chunks).map((c) => c.text);
      const lockRatio = convergenceRatio(lastRoundTurns);
      const skepticClean = Array.isArray(evaluation.unresolvedPoints) && evaluation.unresolvedPoints.length === 0;
      const canExitEarly = (round >= 2 && lockRatio >= 0.8) || (round === 1 && lockRatio >= 0.8 && skepticClean);
      // A user "extend" at this round's stop boundary overrides a convergence
      // break — the user explicitly asked for more rounds to close open criteria.
      if (canExitEarly && !userExtendedThisRound) {
        const reason =
          round === 1
            ? `round 1 converged early (lock=${Math.round(lockRatio * 100)}%, no unresolved points)`
            : `${Math.round(lockRatio * 100)}% of round ${round} turns contained lock phrases`;
        yield {
          type: "content",
          content: `\n> Convergence detected: ${reason}. Ending debate to avoid a redundant confirmation round.\n`,
        };
        break;
      }

      // Budget-exhaustion remedy (B4). At the last planned round with ceiling
      // headroom, two triggers extend the debate:
      //   1. the leader explicitly asked (extendRounds > 0), OR
      //   2. auto-remedy — pinned criteria are still unmet AND progress is being
      //      made (a new criterion was met within the last 2 rounds).
      // "Done = all pinned criteria met"; the ceiling is a leader-managed budget,
      // not a give-up at the initial plan. A stuck criterion (no progress for 2
      // rounds) fails the guard so we don't burn the ceiling chasing it — the
      // closing verdict below then escalates it as stuck. Both the absolute
      // ceiling AND the kind cap still apply (leader can't push an
      // implementation_plan cap of 3 to 4).
      const leaderAskedExtend = typeof evaluation.extendRounds === "number" && evaluation.extendRounds > 0;
      const autoRemedy = leaderAutoRemedyEnabled() && autoRemedyWantsExtend(pinnedUnmet, roundsSinceProgress);
      if (round === maxRounds && maxRounds < effectiveCeiling && (leaderAskedExtend || autoRemedy)) {
        const requested = leaderAskedExtend ? Math.max(1, Math.floor(evaluation.extendRounds as number)) : 1;
        const newMax = Math.min(effectiveCeiling, maxRounds + requested);
        const grantedExtra = newMax - maxRounds;
        if (grantedExtra > 0) {
          const why = leaderAskedExtend
            ? "unresolved points remain"
            : `${pinnedUnmet} pinned criteri${pinnedUnmet === 1 ? "on" : "a"} still unmet`;
          yield {
            type: "content",
            content: `\n> Leader extending debate by ${grantedExtra} round${grantedExtra === 1 ? "" : "s"} (now ${newMax}/${ABSOLUTE_MAX_ROUNDS}) — ${why}.\n`,
          };
          maxRounds = newMax;
          // Steer the extra round at the open criteria when auto-remedy fired and
          // the leader set no focus of its own.
          if (autoRemedy && !leaderAskedExtend && !nextTopic) {
            const openList = spec.successCriteria.filter((_, i) => !aligned[i]).map((c) => shortCriterion(c, 48));
            nextTopic = `Close the unmet criteria: ${openList.join("; ")}`;
          }
        }
      }

      // B4 escalation site 2 — the leader wanted to keep going but we're at the
      // last round and auto-remedy couldn't extend (stuck, or the ceiling is
      // reached). Rather than let the loop exit into a diagnostic-only synthesis,
      // ask the user. An "extend" bumps maxRounds so the loop continues; accept/
      // rescope let it exit naturally. `!escalated` already prevents a double-ask
      // if site 1 fired this round.
      if (
        round === maxRounds &&
        config.respondToQuestion &&
        leaderEscalationEnabled() &&
        !escalated &&
        hasPinned &&
        !evaluation.allCriteriaMet &&
        escalationWanted({
          pinnedUnmet,
          stuck: roundsSinceProgress >= 2,
          atCeiling: maxRounds >= effectiveCeiling,
        })
      ) {
        const openList = spec.successCriteria.filter((_, i) => !aligned[i]).map((c) => shortCriterion(c, 56));
        yield* escalateStop(roundsSinceProgress >= 2, pinnedUnmet, openList);
      }
    } else {
      yield phaseDone({
        phaseId: evalPhaseId,
        kind: "evaluation",
        label: `Leader evaluation (round ${round})`,
        startedAt: evalStart,
        detail: "evaluation unavailable — continuing",
      });
      // P5 — eval parse failed: still close the round with a done record so the
      // grouped transcript never shows a round stuck "running". Do NOT set
      // leaderReason here — the "eval-unavailable" DECISION_LABEL already conveys
      // it, and a redundant reason line rendered the message twice on the card
      // (observed session dd34c59c63e9).
      yield roundRec("done", { leaderDecision: "eval-unavailable", directive: roundDirective });
      nextTopic = undefined;

      // F2 — final-round eval-unavailable must not silently drop an unmet
      // outcome. The eval failed to parse even after the cross-provider fallback
      // loop, so there is no fresh criteria status; fall back to the last
      // successful round's alignment (lastCriteriaMet), treating an empty history
      // as all-unmet. If this is the last round and we have an interactive
      // channel with criteria still open, consult the user (same B4 escalation)
      // instead of proceeding straight to synthesis. stuck=true: a broken eval
      // gives no progress signal, so the diagnostic frames the criteria as
      // needing evidence/rescope rather than "more debate".
      if (
        round === maxRounds &&
        config.respondToQuestion &&
        leaderEscalationEnabled() &&
        !escalated &&
        spec.successCriteria.length > 0
      ) {
        const unmetIdx = spec.successCriteria.map((_, i) => i).filter((i) => lastCriteriaMet[i] !== true);
        if (unmetIdx.length > 0) {
          const openList = unmetIdx.map((i) => shortCriterion(spec.successCriteria[i], 56));
          yield* escalateStop(true, unmetIdx.length, openList);
        }
      }
    }

    // Generate inter-round summary
    if (round < maxRounds) {
      const sumPhaseId = `phase:summary-${round}`;
      const sumStart = Date.now();
      yield phaseStart({
        phaseId: sumPhaseId,
        kind: "summary",
        label: `Round ${round} summary`,
      });
      try {
        const allEx = [...exchangeLogs.values()].flat().slice(-6).join("\n\n");
        const { system, prompt } = buildRoundSummaryPrompt(allEx, spec.problemStatement, round);
        // Round summary is mechanical condensation — drop to "fast" tier on the leader's
        // provider when cost-aware. Fall back to the first participant's model otherwise
        // (matches the pre-cost-aware behavior).
        const summaryModel = pickCouncilTaskModel("round_summary", leaderModelId, costAware);
        runningSummary = yield* tracedGenerate(llm, {
          phase: "summary",
          label: `Summarizing round ${round}`,
          modelId: costAware ? summaryModel : active[0].model,
          system,
          prompt,
          maxTokens: 512,
        });
        const headline = runningSummary
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, 1)
          .join(" ")
          .slice(0, 100);
        yield phaseDone({
          phaseId: sumPhaseId,
          kind: "summary",
          label: `Round ${round} summary`,
          startedAt: sumStart,
          detail: headline,
        });
      } catch {
        yield phaseDone({
          phaseId: sumPhaseId,
          kind: "summary",
          label: `Round ${round} summary`,
          startedAt: sumStart,
          detail: "skipped",
        });
      }
    }
  }

  // B4 leader remedy: the debate has ended — via leader stop, convergence, or
  // budget exhaustion (after auto-remedy exhausted the ceiling). If pinned
  // criteria remain unmet, the leader emits a visible closing verdict that
  // DIAGNOSES why it stopped and gives an actionable next move, instead of
  // letting synthesis proceed as if the outcome were fully achieved (the "3/5 →
  // stop, synthesize as if done" gap). When the user was consulted (B4
  // escalation) and chose to accept/rescope, the remedy reflects that decision
  // instead of a generic "re-run" shrug.
  if (leaderConductorEnabled() && spec.successCriteria.length > 0) {
    const unmet = spec.successCriteria.filter((_, i) => !lastCriteriaMet[i]);
    if (unmet.length > 0) {
      const atCeiling = maxRounds >= effectiveCeiling;
      const stuck = roundsSinceProgress >= 2;
      const remedy =
        escalation?.action === "accept"
          ? "you accepted these as open — synthesis proceeds with them noted as unresolved."
          : escalation?.action === "rescope"
            ? "you asked to narrow the scope — re-run the council on just these criteria with a tighter problem statement."
            : diagnoseUnmetRemedy({ stuck, atCeiling, effectiveCeiling, roundsSinceProgress });
      yield {
        type: "council_message" as const,
        councilMessage: {
          kind: "leader" as const,
          phase: "verdict" as const,
          speaker: { role: "Leader", model: leaderModelId },
          text:
            `Debate ended with ${unmet.length} of ${spec.successCriteria.length} criteri` +
            `${unmet.length === 1 ? "on" : "a"} still unmet: ${unmet.map((c) => shortCriterion(c, 56)).join("; ")}. ` +
            `Synthesis notes these as open — ${remedy}`,
        },
      };
    }
  }

  // Compute cumulative evidence density across the WHOLE debate, not just
  // the leader's last per-round evaluation. Citations are concentrated in
  // early rounds (when partners have fresh fact-claims to verify) while
  // late rounds are mostly opinion convergence. Using only the last round's
  // slice (as lastEvidenceDensity does) reports 0.00 even when the debate
  // actually produced [CONFIRMED via …] tags earlier — that's the bug
  // session ea13da132dec hit despite 2 real web_fetch citations.
  const fullExchangeText = [...exchangeLogs.values()].flat().join("\n\n");
  const cumulativeDensity = computeEvidenceDensity(fullExchangeText);
  // Prefer cumulative when it exceeds the leader's last-round measurement —
  // we don't want a converged final round (which has fewer fact-claims to
  // tag) to wipe out evidence work done earlier in the debate.
  const finalEvidenceDensity = Math.max(cumulativeDensity, lastEvidenceDensity ?? 0);
  // Count of claims participants explicitly TAGGED ([CONFIRMED]/[REFUTED]/
  // [UNVERIFIED]) across the whole debate. Lets the confidence badge tell
  // "measured 0% grounding" apart from "no tags emitted → not measurable"
  // (session de4bafe5ecb7: substantive debate, zero tags → misleading 0%).
  const finalTaggedClaims = countCitations(fullExchangeText) + countUnverified(fullExchangeText);

  return {
    spec,
    exchangeLogs,
    runningSummary,
    roundCount,
    researchFindings,
    active,
    archive,
    finalEvidenceDensity,
    finalTaggedClaims,
    escalation,
  };
}

export async function* evaluateResearchNeed(
  spec: ClarifiedSpec,
  leaderModelId: string,
  conversationContext: string,
  llm: CouncilLLM,
  costAware = false,
): AsyncGenerator<StreamChunk, boolean, unknown> {
  try {
    const modelId = pickCouncilTaskModel("research_need", leaderModelId, costAware);
    const raw = yield* tracedGenerate(llm, {
      phase: "evaluate",
      label: "Leader deciding if research is needed",
      modelId,
      system:
        `You are deciding whether a codebase research phase is needed before a multi-expert discussion.\n` +
        `If the discussion topic requires knowledge of specific files, functions, errors, or configurations in the codebase, answer true.\n` +
        `If the discussion is about general strategy, architecture concepts, or trade-offs that don't need codebase data, answer false.\n` +
        `Output ONLY: {"needsResearch": true/false, "reason": "one sentence"}`,
      prompt: `Topic: ${spec.problemStatement}\nConstraints: ${spec.constraints.join("; ")}\nContext: ${conversationContext.slice(0, 3000)}`,
      maxTokens: 256,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { needsResearch?: boolean };
      return parsed.needsResearch === true;
    }
  } catch {
    // Default to research for safety
  }
  return true;
}

async function* evaluateDebate(
  spec: ClarifiedSpec,
  exchangeText: string,
  round: number,
  leaderModelId: string,
  llm: CouncilLLM,
  costAware = false,
  // When set, evaluate with this exact model instead of the cost-tier pick — used
  // by the call-site fallback loop to re-run a round eval on a healthy panel model
  // after the leader's provider rejected the eval payload (Console Go "Upstream
  // request failed" on glm/kimi; observed session dd34c59c63e9).
  modelOverride?: string,
): AsyncGenerator<StreamChunk, LeaderEvaluation | null, unknown> {
  try {
    const { system, prompt } = buildLeaderEvaluationPrompt({ spec, exchangeLogs: exchangeText, round });
    const modelId = modelOverride ?? pickCouncilTaskModel("evaluate_round", leaderModelId, costAware);
    const raw = yield* tracedGenerate(llm, {
      phase: "evaluate",
      label: modelOverride
        ? `Leader evaluating round ${round} (fallback: ${modelOverride})`
        : `Leader evaluating round ${round}`,
      modelId,
      system,
      prompt,
      // Raised from 1024: nextRoundFocus is now the FIRST schema field, and the
      // whole eval is parsed by a single JSON.parse that returns null on any
      // truncation — a tight budget could clip the JSON and null the round's
      // outcome. 1536 keeps the focus line + criteria array intact.
      maxTokens: 1536,
    });
    const jsonStr = extractEvalJson(raw);
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr) as Partial<LeaderEvaluation>;

      const citationCount = countCitations(exchangeText);
      const evidenceDensity = computeEvidenceDensity(exchangeText);
      const disagreementResolved = citationCount;

      let needsResearch = parsed.needsResearch ?? false;
      let researchQuery = parsed.researchQuery;
      if (!needsResearch && round >= 2 && evidenceDensity < 0.3) {
        needsResearch = true;
        researchQuery = `Verify claims from debate round ${round} on: ${spec.problemStatement.slice(0, 80)}`;
      }

      const rawExtend = (parsed as { extendRounds?: unknown }).extendRounds;
      let extendRounds: number | undefined;
      if (typeof rawExtend === "number" && Number.isFinite(rawExtend) && rawExtend > 0) {
        // Hard-cap leader's per-evaluation extension request so a hallucinated
        // 100 doesn't blow past the absolute ceiling check elsewhere.
        extendRounds = Math.min(3, Math.floor(rawExtend));
      }

      return {
        allCriteriaMet: parsed.allCriteriaMet ?? false,
        criteriaStatus: parsed.criteriaStatus ?? [],
        unresolvedPoints: parsed.unresolvedPoints ?? [],
        needsResearch,
        researchQuery,
        shouldContinue: parsed.shouldContinue ?? true,
        reason: parsed.reason ?? "",
        evidenceDensity,
        disagreementResolved,
        extendRounds,
        nextRoundFocus:
          typeof (parsed as { nextRoundFocus?: unknown }).nextRoundFocus === "string" &&
          (parsed as { nextRoundFocus: string }).nextRoundFocus.trim()
            ? (parsed as { nextRoundFocus: string }).nextRoundFocus.trim()
            : undefined,
      };
    }
    // F3a — no JSON object found in the model output. Log a diagnosable snippet
    // (No-Silent-Catch) before falling through to null so eval-unavailable is
    // never a black box — earlier this returned null silently and the only signal
    // was the "evaluation unavailable" round label.
    console.warn(
      `[council] round-${round} eval: no JSON object in output from ${modelOverride ?? leaderModelId} ` +
        `(${raw.length} chars): ${raw.slice(0, 160).replace(/\s+/g, " ")}`,
    );
  } catch (err) {
    // F3a — parse or generate failure. Log with context instead of swallowing:
    // which model, which round, the message. The debate still continues (returns
    // null → eval-unavailable), but the failure is now diagnosable remotely.
    console.error(
      `[council] round-${round} eval failed on ${modelOverride ?? leaderModelId}: ${(err as Error)?.message}`,
      { round, stack: (err as Error)?.stack?.split("\n").slice(0, 3) },
    );
  }
  return null;
}

/**
 * F3b — robustly extract the leader-evaluation JSON object from a model's raw
 * output. Replaces a greedy `/\{[\s\S]*\}/` match that could swallow prose,
 * multiple objects, or a trailing partial object into an unparseable span.
 *
 * Strategy: strip code fences, then brace-scan and return the LAST fully
 * balanced top-level `{…}` object (the eval schema is emitted last, after any
 * chain-of-thought prose). Returns null only when no balanced object exists.
 * Deterministic, no LLM call. Braces inside string values are rare in the
 * machine-emitted eval payload; a real tokenizer would be overkill here.
 */
export function extractEvalJson(raw: string): string | null {
  if (!raw) return null;
  const unfenced = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  let best: string | null = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) best = unfenced.slice(start, i + 1);
      }
    }
  }
  return best;
}

/**
 * Format a speaker list as newline-joined "Name — lens" rows for the composing
 * placeholder (A: live debate preview). Prefers the concrete `focus`, falls back
 * to the one-sentence `lens`, then to bare name. Dedups identical rows so a
 * speaker in multiple pairs renders once. Returns undefined when nothing useful
 * is available so the UI falls back to label-only.
 */
/**
 * Project a leader evaluation's `criteriaStatus` onto the PINNED spec criteria,
 * returning a boolean[] index-aligned to `pinned` (B2/B3). The eval prompt asks
 * for one entry per criterion in order, so index alignment is the primary path;
 * when the model drifts (wrong count/order) we fall back to a case-insensitive
 * substring match either direction, defaulting unmatched criteria to not-met so
 * a hallucinated "all met" never silently marks an untouched criterion done.
 */
export function alignCriteriaMet(pinned: string[], status: Array<{ criterion?: string; met?: boolean }>): boolean[] {
  const aligned = status.length === pinned.length;
  return pinned.map((crit, i) => {
    if (aligned) return status[i]?.met === true;
    const norm = crit.trim().toLowerCase();
    const hit = status.find((s) => {
      const sc = (s.criterion ?? "").trim().toLowerCase();
      return sc.length > 0 && (sc.includes(norm) || norm.includes(sc));
    });
    return hit?.met === true;
  });
}

/**
 * B5 leader-conductor visibility. Default ON; opt out with
 * MUONROI_LEADER_CONDUCTOR=0 (fallback = pre-B5 behavior, no directive/verdict
 * messages — keeps headless/legacy transcripts unchanged).
 */
export function leaderConductorEnabled(): boolean {
  return process.env.MUONROI_LEADER_CONDUCTOR !== "0";
}

/**
 * B4 leader auto-remedy. When pinned criteria remain unmet at the round budget's
 * end, the leader auto-extends toward them (up to the hard ceiling) instead of
 * stopping at the initial plan — "done = all criteria met", ceiling is a managed
 * budget. Default ON under the conductor; opt out with
 * MUONROI_COUNCIL_AUTO_REMEDY=0 (fallback = only leader-requested extensions).
 */
export function leaderAutoRemedyEnabled(): boolean {
  return leaderConductorEnabled() && process.env.MUONROI_COUNCIL_AUTO_REMEDY !== "0";
}

/**
 * B4: does auto-remedy want to extend the budget this round? True while pinned
 * criteria remain unmet AND progress is still being made (a new criterion was
 * met within the last 2 rounds). A stuck debate (roundsSinceProgress ≥ 2) returns
 * false so the ceiling isn't burned chasing a criterion that isn't moving.
 */
export function autoRemedyWantsExtend(pinnedUnmet: number, roundsSinceProgress: number): boolean {
  return pinnedUnmet > 0 && roundsSinceProgress < 2;
}

/**
 * B4: the diagnostic closing-remedy line for a debate that ended with unmet
 * pinned criteria — distinguishes a stuck criterion (needs evidence/rescope)
 * from a genuine ceiling hit (needs a higher budget) from an ordinary early
 * stop, so the leader's final word is an actionable next move, not a shrug.
 */
export function diagnoseUnmetRemedy(opts: {
  stuck: boolean;
  atCeiling: boolean;
  effectiveCeiling: number;
  roundsSinceProgress: number;
}): string {
  if (opts.stuck) {
    return (
      `these made no progress across the last ${opts.roundsSinceProgress} rounds — ` +
      `they likely need external evidence (research) or a narrower scope, not more debate.`
    );
  }
  if (opts.atCeiling) {
    return (
      `the debate hit its ${opts.effectiveCeiling}-round ceiling with these open — ` +
      `re-run with a higher round budget or split the scope.`
    );
  }
  return `re-run with an extended round budget or a narrower scope to close them.`;
}

/** Extra rounds a user "extend" grants — can push past effectiveCeiling, never past ABSOLUTE_MAX_ROUNDS. */
const ESCALATION_EXTEND_ROUNDS = 2;

/**
 * B4 interactive escalation. When the debate is about to stop with pinned
 * criteria unmet AND auto-remedy can't help (stuck / at ceiling), hand the
 * decision to the user instead of silently synthesizing a partial outcome.
 * Default ON under the conductor; opt out with MUONROI_COUNCIL_ESCALATE=0
 * (fallback = diagnostic closing verdict only, no askcard).
 */
export function leaderEscalationEnabled(): boolean {
  return leaderConductorEnabled() && process.env.MUONROI_COUNCIL_ESCALATE !== "0";
}

/**
 * B4: should we interrupt to ask the user at this stop boundary? True only when
 * pinned criteria remain unmet AND the leader can no longer self-remedy — it is
 * stuck (no progress for ≥2 rounds) or has hit the round ceiling. While progress
 * is still being made under the ceiling, auto-remedy handles it silently and we
 * don't nag the user.
 */
export function escalationWanted(opts: { pinnedUnmet: number; stuck: boolean; atCeiling: boolean }): boolean {
  return opts.pinnedUnmet > 0 && (opts.stuck || opts.atCeiling);
}

/**
 * B4: the three escalation choices. When the debate is already at the absolute
 * safety ceiling, the "extend" option degrades to a disabled-looking accept
 * (label says so) — we never let the user push past ABSOLUTE_MAX_ROUNDS.
 */
export function buildEscalationOptions(unmetCount: number, atAbsoluteMax: boolean): CouncilQuestionOption[] {
  const noun = `${unmetCount} unmet criteri${unmetCount === 1 ? "on" : "a"}`;
  return [
    atAbsoluteMax
      ? {
          label: "Extend (unavailable — at hard ceiling)",
          description: `The debate already reached the ${ABSOLUTE_MAX_ROUNDS}-round safety ceiling; more rounds aren't allowed. Picking this accepts the outcome as-is.`,
          value: "escalate_accept",
          kind: "choice" as const,
        }
      : {
          label: `Extend ${ESCALATION_EXTEND_ROUNDS} more rounds`,
          description: `Push past the round budget to keep working the ${noun}.`,
          value: "escalate_extend",
          kind: "choice" as const,
        },
    {
      label: "Accept as-is",
      description: `Proceed to synthesis with the ${noun} noted as open.`,
      value: "escalate_accept",
      kind: "choice" as const,
    },
    {
      label: "Narrow the scope",
      description: "Stop and re-scope — synthesis notes the open criteria for a narrower follow-up.",
      value: "escalate_rescope",
      kind: "choice" as const,
    },
  ];
}

/**
 * B4: emit the escalation askcard and resolve the user's choice. Yields the
 * council_question chunk (rendered by the same consumer as clarifier/post-debate
 * askcards), awaits the responder, echoes the choice, and returns the decision.
 * `grantedRounds` is pre-computed here (bounded by ABSOLUTE_MAX_ROUNDS) so the
 * caller only mutates loop state. Any unmatched / empty answer is treated as
 * "accept" — never a silent hang.
 */
export async function* runEscalationPrompt(opts: {
  respondToQuestion: QuestionResponder;
  openCriteria: string[];
  pinnedUnmet: number;
  stuck: boolean;
  atAbsoluteMax: boolean;
  currentMax: number;
}): AsyncGenerator<StreamChunk, { action: "extend" | "accept" | "rescope"; grantedRounds: number }, unknown> {
  const { respondToQuestion, openCriteria, pinnedUnmet, stuck, atAbsoluteMax, currentMax } = opts;
  const noun = `${pinnedUnmet} criteri${pinnedUnmet === 1 ? "on" : "a"}`;
  const openList = openCriteria.join("; ");
  const questionId = randomUUID();
  yield {
    type: "council_question" as const,
    content: `**Debate stalled with ${noun} still unmet.**\n> Open: ${openList}`,
    councilQuestion: {
      questionId,
      // Reuse the existing post-debate phase — same askcard renderer, no new UI.
      phase: "post-debate" as const,
      question:
        `The debate reached its ${stuck ? "progress limit" : "round ceiling"} with ${noun} still unmet. ` +
        `How do you want to proceed?`,
      context: `Open criteria: ${openList}`,
      isRequired: false,
      options: buildEscalationOptions(pinnedUnmet, atAbsoluteMax),
      defaultIndex: 0,
    },
  } as StreamChunk;

  let answer = "";
  try {
    answer = (await respondToQuestion(questionId))?.trim() ?? "";
  } catch (err) {
    // A failed responder must not hang or crash the debate — treat as accept and
    // log so a broken UI channel is diagnosable (No-Silent-Catch).
    console.error(`[council] escalation responder failed — accepting outcome as-is: ${(err as Error)?.message}`, {
      questionId,
      stack: (err as Error)?.stack?.split("\n").slice(0, 3),
    });
    answer = "";
  }

  if (answer === "escalate_extend" && !atAbsoluteMax) {
    const newMax = Math.min(ABSOLUTE_MAX_ROUNDS, currentMax + ESCALATION_EXTEND_ROUNDS);
    const grantedRounds = Math.max(0, newMax - currentMax);
    if (grantedRounds > 0) {
      yield {
        type: "content",
        content: `\n> User extended debate by ${grantedRounds} round${grantedRounds === 1 ? "" : "s"} (now ${newMax}/${ABSOLUTE_MAX_ROUNDS}) — pushing past the budget to close the open criteria.\n`,
      };
      return { action: "extend", grantedRounds };
    }
    // No headroom left even though the option showed — fall through to accept.
  }
  if (answer === "escalate_rescope") {
    yield {
      type: "content",
      content: `\n  ↳ Narrow the scope — ending the debate; synthesis will note the open criteria for a re-scoped follow-up.\n`,
    };
    return { action: "rescope", grantedRounds: 0 };
  }
  yield {
    type: "content",
    content: `\n  ↳ Accepted the current outcome with ${noun} open.\n`,
  };
  return { action: "accept", grantedRounds: 0 };
}

/** One-line criterion label for directive/verdict bodies. */
export function shortCriterion(c: string, max = 64): string {
  const t = c.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * B5: build the leader's pre-round DIRECTIVE body — the round goal plus the
 * criteria still unmet going into this round. `metSoFar` is the prior round's
 * aligned criteriaMet (empty before round 1 → everything is unmet).
 */
export function buildLeaderDirective(round: number, criteria: string[], metSoFar: boolean[], focus?: string): string {
  const pending = criteria.filter((_, i) => !metSoFar[i]);
  const lines: string[] = [];
  const trimmedFocus = focus?.trim();
  lines.push(
    trimmedFocus
      ? `Focus: ${trimmedFocus}`
      : round === 1
        ? "Establish concrete evidence for every outcome criterion."
        : "Drive the remaining criteria to done.",
  );
  lines.push(
    pending.length > 0
      ? `Unmet (${pending.length}/${criteria.length}): ${pending.map((c) => shortCriterion(c, 56)).join("; ")}`
      : "All criteria met so far — pressure-test the weakest before closing.",
  );
  return lines.join("\n");
}

/**
 * B5: build the leader's post-round VERDICT body — per-criterion ✓/○ against the
 * pinned outcome, the leader's reason, and the focus it hands to the next round.
 */
export function buildLeaderVerdict(criteria: string[], met: boolean[], reason: string, nextFocus?: string): string {
  const metCount = met.filter(Boolean).length;
  const lines: string[] = [`${metCount}/${criteria.length} criteria met — ${reason.trim()}`];
  criteria.forEach((c, i) => {
    lines.push(`${met[i] ? "✓" : "○"} ${shortCriterion(c, 56)}`);
  });
  const nf = nextFocus?.trim();
  if (nf && metCount < criteria.length) lines.push(`→ Next: ${nf}`);
  return lines.join("\n");
}

export function formatSpeakerRoster(list: Array<{ stance?: DebateStance; model: string }>): string | undefined {
  const rows: string[] = [];
  for (const s of list) {
    const name = s.stance?.name ?? s.model;
    const angle = s.stance?.focus?.trim() || s.stance?.lens?.trim();
    const row = angle ? `${name} — ${angle}` : name;
    if (row && !rows.includes(row)) rows.push(row);
  }
  return rows.length > 0 ? rows.join("\n") : undefined;
}

function countCitations(text: string): number {
  const matches = text.match(/\[(REFUTED|CONFIRMED) via [^\]]+\]/g);
  return matches?.length ?? 0;
}

function countUnverified(text: string): number {
  const matches = text.match(/\[UNVERIFIED[^\]]*\]/g);
  return matches?.length ?? 0;
}

/**
 * Evidence density = verified / (verified + unverified).
 *
 * Previous definition was `citations / total-sentences`, which fundamentally
 * couldn't exceed ~0.05 because most debate sentences are not citable claims
 * (opinions, transitions, questions). Session ea13da132dec hit "Low
 * confidence 0.00" despite having 2 real [CONFIRMED via web_fetch] tags
 * because they were drowned in ~700 sentences of debate prose.
 *
 * New definition only counts claims that participants explicitly FLAGGED as
 * needing evidence — either by verifying them ([CONFIRMED]/[REFUTED]) or by
 * marking them unverified ([UNVERIFIED:…]). This measures how much of the
 * debate's own factual claim-tagging was actually backed up.
 *
 * If participants tagged zero claims, density is 0 — no evidence awareness
 * shown, low confidence is correct. This biases participants (via the
 * EVIDENCE_RULE prompt) to either verify or explicitly mark unverified.
 */
function computeEvidenceDensity(text: string): number {
  const cited = countCitations(text);
  const unverified = countUnverified(text);
  const totalTagged = cited + unverified;
  if (totalTagged === 0) return 0;
  return cited / totalTagged;
}
