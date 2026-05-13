import { getModelInfo } from "../models/registry.js";
import type { StreamChunk } from "../types/index.js";
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
  DebateState,
  LeaderEvaluation,
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
/** Cap on the size of a single archived position. Anything longer is
 * trimmed and reported via `length`. Mirrors the goal of keeping the
 * follow-up memory record small enough to be reloaded cheaply. */
const ARCHIVE_EXCERPT_CHARS = 400;

function makeExcerpt(text: string): { excerpt: string; length: number } {
  const trimmed = text.trim();
  return {
    excerpt: trimmed.length > ARCHIVE_EXCERPT_CHARS ? trimmed.slice(0, ARCHIVE_EXCERPT_CHARS) + "…" : trimmed,
    length: trimmed.length,
  };
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
];

function looksLocked(text: string): boolean {
  if (!text || text.length < 20) return false;
  return LOCK_PHRASES.some((re) => re.test(text));
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

async function debateWithRetry(
  llm: CouncilLLM,
  model: string,
  system: string,
  prompt: string,
  signal: AbortSignal | undefined,
  traceCb: (t: string) => void,
  toolBudget: ToolBudget,
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
  try {
    const retry = await llm.debate(model, system, prompt, signal, traceCb, { enableVerificationTools: false });
    const text = (retry.text ?? "").trim();
    if (text.length > 0) {
      return { text: retry.text, toolCalls: retry.toolCalls ?? [], attempts: 2 };
    }
    return {
      text: "",
      toolCalls: retry.toolCalls ?? [],
      failureReason: `provider returned empty completion on both attempts (initial: ${firstError})`,
      attempts: 2,
    };
  } catch (err) {
    const retryMsg = err instanceof Error ? err.message : String(err);
    return {
      text: "",
      toolCalls: [],
      failureReason: `both attempts failed — initial: ${firstError}; retry: ${retryMsg}`,
      attempts: 2,
    };
  }
}

export async function* runDebate(
  spec: ClarifiedSpec,
  config: CouncilConfig,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, DebateState, unknown> {
  const { leaderModelId, participants, conversationContext, signal, debatePlan } = config;
  const researchSkipOverride = config.researchSkipOverride === true;
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
  const needsResearch = researchSkipOverride
    ? false
    : yield* evaluateResearchNeed(spec, leaderModelId, conversationContext, llm, costAware);

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
        llm.research(
          researchCandidate.model,
          spec.problemStatement,
          conversationContext,
          signal,
          (t) => researchTraces.push(t),
          { internetFirst },
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
    detail: participants.map((p) => p.role).join(", "),
  });

  yield { type: "content", content: "\n## Opening Analysis\n" };
  for (const o of openings) {
    const heading = o.stance ? `${o.stance.name} (\`${o.role}\` · ${o.model})` : `\`[${o.role}]\` ${o.model}`;
    yield { type: "content", content: `\n### ${heading}\n` };
    if (o.error) {
      yield { type: "content", content: `[Error: ${o.error}]\n` };
    } else {
      active.push({ role: o.role as any, model: o.model, position: o.position, stance: o.stance });
      archive.push({
        round: 0,
        role: o.role as any,
        model: o.model,
        stanceName: o.stance?.name,
        ...makeExcerpt(o.position),
      });
      yield { type: "content", content: `${o.position}\n` };
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
  const KIND_MAX_ROUNDS: Record<string, number> = {
    implementation_plan: 3,
  };
  const kindCap = planKind ? KIND_MAX_ROUNDS[planKind] : undefined;
  const initialPlanned = debatePlan?.plannedRounds;
  const effectiveCeiling = Math.min(ABSOLUTE_MAX_ROUNDS, kindCap ?? ABSOLUTE_MAX_ROUNDS);
  let maxRounds = Math.min(
    effectiveCeiling,
    Math.max(1, typeof initialPlanned === "number" && initialPlanned > 0 ? initialPlanned : DEFAULT_PLANNED_ROUNDS),
  );
  const ceilingNote = kindCap
    ? ` (hard ceiling ${effectiveCeiling} for ${planKind})`
    : ` (hard ceiling ${ABSOLUTE_MAX_ROUNDS})`;
  yield {
    type: "content",
    content: `\n> Leader-proposed debate budget: ${maxRounds} round${maxRounds === 1 ? "" : "s"}${ceilingNote}.\n`,
  };

  // Pairs that fail twice in a row are dropped from subsequent rounds so the
  // remaining participants don't keep retrying a broken model and inflating
  // the persistent transcript with failure noise.
  const consecutivePairFailures = new Map<string, number>();
  const droppedPairKeys = new Set<string>();
  // Stop debate entirely after two consecutive rounds where ≥50% of pairs fail
  // — the LLM is clearly under provider stress and more rounds won't help.
  let consecutiveRoundFailures = 0;

  for (let round = 1; round <= maxRounds; round++) {
    roundCount = round;
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
        detail: pairs.map((p) => `${p.a.role}↔${p.b.role}`).join(", "),
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
          const modelId =
            active.find((a) => (a.stance?.name ?? a.role) === speakerName)?.model ?? "";
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
    const evaluation = yield* evaluateDebate(spec, allExchangeText, round, leaderModelId, llm, costAware);

    if (evaluation) {
      if (typeof evaluation.evidenceDensity === "number") {
        lastEvidenceDensity = evaluation.evidenceDensity;
      }
      const metCount = evaluation.criteriaStatus.filter((c) => c.met).length;
      const total = evaluation.criteriaStatus.length;
      yield phaseDone({
        phaseId: evalPhaseId,
        kind: "evaluation",
        label: `Leader evaluation (round ${round})`,
        startedAt: evalStart,
        detail: `${metCount}/${total} criteria met · ${evaluation.reason.slice(0, 80)}`,
      });
      yield {
        type: "council_message" as const,
        councilMessage: {
          kind: "leader" as const,
          speaker: { role: "Leader", model: leaderModelId },
          round,
          text: `${metCount}/${total} criteria met — ${evaluation.reason}`,
        },
      };

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
            llm.research(researchCandidate.model, evaluation.researchQuery!, enrichedContext, signal, (t) =>
              midTraces.push(t),
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
        yield {
          type: "content",
          content: `\n> Leader decided: debate sufficient at round ${round}.\n`,
        };
        break;
      }

      // Code-side convergence override. When the latest round had ≥80% of
      // pair-turns containing lock phrases ("everything locked", "fully
      // aligned", "ready to proceed"), we end the debate regardless of
      // leader judgment. The leader's per-round slice (-8 turns) sometimes
      // misses cross-pair convergence frequency; this catches it explicitly.
      const lastRoundTurns = pairResults.flatMap((pr) => pr.chunks).map((c) => c.text);
      const lockRatio = convergenceRatio(lastRoundTurns);
      if (round >= 2 && lockRatio >= 0.8) {
        yield {
          type: "content",
          content:
            `\n> Convergence detected: ${Math.round(lockRatio * 100)}% of round ${round} turns contained lock phrases. ` +
            `Ending debate to avoid a redundant confirmation round.\n`,
        };
        break;
      }

      // Leader asked for more rounds and we still have ceiling headroom.
      // Both the absolute ceiling AND the kind-specific cap apply — leader
      // can't override an implementation_plan cap of 3 by asking for 4.
      if (
        round === maxRounds &&
        typeof evaluation.extendRounds === "number" &&
        evaluation.extendRounds > 0 &&
        maxRounds < effectiveCeiling
      ) {
        const requested = Math.max(1, Math.floor(evaluation.extendRounds));
        const newMax = Math.min(effectiveCeiling, maxRounds + requested);
        const grantedExtra = newMax - maxRounds;
        if (grantedExtra > 0) {
          yield {
            type: "content",
            content: `\n> Leader extending debate by ${grantedExtra} round${grantedExtra === 1 ? "" : "s"} (now ${newMax}/${ABSOLUTE_MAX_ROUNDS}) — unresolved points remain.\n`,
          };
          maxRounds = newMax;
        }
      }
    } else {
      yield phaseDone({
        phaseId: evalPhaseId,
        kind: "evaluation",
        label: `Leader evaluation (round ${round})`,
        startedAt: evalStart,
        detail: "evaluation unavailable — continuing",
      });
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

  return {
    spec,
    exchangeLogs,
    runningSummary,
    roundCount,
    researchFindings,
    active,
    archive,
    finalEvidenceDensity,
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
): AsyncGenerator<StreamChunk, LeaderEvaluation | null, unknown> {
  try {
    const { system, prompt } = buildLeaderEvaluationPrompt({ spec, exchangeLogs: exchangeText, round });
    const modelId = pickCouncilTaskModel("evaluate_round", leaderModelId, costAware);
    const raw = yield* tracedGenerate(llm, {
      phase: "evaluate",
      label: `Leader evaluating round ${round}`,
      modelId,
      system,
      prompt,
      maxTokens: 1024,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<LeaderEvaluation>;

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
      };
    }
  } catch {
    // Continue debate if evaluation fails
  }
  return null;
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
