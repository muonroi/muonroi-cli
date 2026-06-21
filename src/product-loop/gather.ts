// src/product-loop/gather.ts
// Dispatcher that wires the discover phase into the adaptive interview flow.
// buildDiscoveryDebateRunner ← Task 16
// buildGatherUserPrompt      ← Task 17

import { resolveLeaderModelDetailed } from "../council/leader.js";
import type { ClarifiedSpec } from "../council/types.js";
import type { StreamChunk } from "../types/index.js";
import { detectExistingProject } from "./discovery-detection.js";
import {
  iterateInterview,
  type UserPromptArgs,
  type UserPromptFn,
  type UserPromptResult,
} from "./discovery-interview.js";
import {
  acquireRunLock,
  initDiscoveryState,
  readDiscoveryState,
  readProjectContext,
  releaseRunLock,
  resumeArtifactWriteIfNeeded,
} from "./discovery-persistence.js";
import type { LeaderLike } from "./discovery-prompt-parser.js";
import { parsePromptForContext } from "./discovery-prompt-parser.js";
import type { CouncilDebateRunner } from "./discovery-recommender.js";
import { councilRecommend, leaderRecommend, shouldFallbackToLeader } from "./discovery-recommender.js";
import type { BackendStackCtx, DiscoveryContext, ExistingProjectSignals, ProjectContext } from "./types.js";

/**
 * Decide whether detection signals are STRONG enough to synthesize a
 * backendStack answer (skipping the interview question). Returns null when
 * the signal is ambiguous — in that case the interview asks the user.
 *
 * Exported for unit testing; consumers should prefer this over reaching
 * into the detection shape directly.
 */
export function pickBackendStackFromDetection(detection: ExistingProjectSignals): BackendStackCtx | null {
  // Path 1 — single dominant manifest. classify() guarantees weight > 0 +
  // srcFileCount > 5 for "existing", so this is the highest-confidence case.
  if (detection.classification === "existing" && detection.manifests.length === 1) {
    const m = detection.manifests[0];
    return {
      language: m.inferredLang,
      framework: m.inferredFrameworks[0] ?? "(none detected)",
    };
  }
  // Path 2 — ambiguous classification but exactly one language detected
  // (e.g. a folder of .ts files with no package.json, or a single manifest
  // with weight=0). Lang is high signal; framework unknown.
  if (detection.classification === "ambiguous" && detection.languages.length === 1) {
    return {
      language: detection.languages[0],
      framework: "(none detected)",
    };
  }
  // Path 3 — polyglot OR no signal. Bail out and let the interview ask.
  return null;
}

// ---------------------------------------------------------------------------
// Forward-reference stubs (replaced in Tasks 16 and 17)
// ---------------------------------------------------------------------------

/** Replaced by Task 16: discovery-council-runner.ts */
// biome-ignore lint/suspicious/noExplicitAny: stub replaced in Task 16
function buildDiscoveryDebateRunner(_deps?: any): CouncilDebateRunner {
  throw new Error("buildDiscoveryDebateRunner not yet wired — complete Task 16");
}

/**
 * Translate gather's `tuiAsk(label, options)` contract onto the council askcard
 * machinery. Each call emits a `council_question` chunk that the UI renders as
 * an interactive card, then awaits the resolver for the user's chosen value.
 * Info messages (empty options) are emitted as a plain content chunk so they
 * don't block.
 */
function buildLiveTuiAsk(
  emit: (chunk: StreamChunk) => void,
  respondToQuestion: (questionId: string) => Promise<string>,
): (label: string, options?: string[]) => Promise<string> {
  return async (label, options) => {
    const _dbg = process.env.MUONROI_DEBUG_LEADER === "1";
    if (!options || options.length === 0) {
      if (_dbg) {
        process.stderr.write(`[tuiask] info-emit: ${JSON.stringify({ labelPreview: label.slice(0, 80) })}\n`);
      }
      emit({ type: "content", content: `\n> ${label}\n` } as StreamChunk);
      return "";
    }
    const questionId = crypto.randomUUID();
    if (_dbg) {
      process.stderr.write(
        `[tuiask] emit-question: ${JSON.stringify({ questionId, labelPreview: label.slice(0, 80), optionCount: options.length })}\n`,
      );
    }
    emit({
      type: "council_question",
      content: label,
      councilQuestion: {
        questionId,
        phase: "clarify",
        question: label,
        isRequired: true,
        options: options.map((o) => ({ label: o, value: o, kind: "choice" as const })),
        defaultIndex: 0,
      },
    } as StreamChunk);
    const _awaitStart = Date.now();
    if (_dbg) {
      process.stderr.write(`[tuiask] await-start: ${JSON.stringify({ questionId })}\n`);
    }
    const result = await respondToQuestion(questionId);
    if (_dbg) {
      process.stderr.write(
        `[tuiask] await-resolved: ${JSON.stringify({ questionId, durationMs: Date.now() - _awaitStart, resultPreview: result.slice(0, 40) })}\n`,
      );
    }
    return result;
  };
}

export function buildGatherUserPrompt(tuiAsk: (label: string, options?: string[]) => Promise<string>): UserPromptFn {
  return async (args: UserPromptArgs): Promise<UserPromptResult> => {
    if (args.questionId === "__user_gate__") {
      // G2-b: when required answers were auto-filled from the recommender
      // (minimal/well-specified prompt), this single card IS the summary — list
      // the assumptions so the user reviews them in one place instead of N
      // sequential per-question cards. "ask-more" lets them revisit/expand.
      const label =
        args.assumptions && args.assumptions.length > 0
          ? `Assumed from your prompt:\n${args.assumptions
              .map((a) => `  • ${a.id} = ${JSON.stringify(a.value)}`)
              .join("\n")}\n\nProceed, or ask more to adjust/expand?`
          : "All required questions answered. Proceed to research or ask more?";
      const choice = await tuiAsk(label, ["proceed", "ask-more", "abort"]);
      if (choice === "proceed") return { action: "proceed" };
      if (choice === "abort") return { action: "abort" };
      return { action: "ask-more" };
    }
    if (args.message) {
      await tuiAsk(args.message, []);
      return { action: "more-options" };
    }
    const lines: string[] = [];
    if (args.recommendation) {
      lines.push(`Question: ${args.questionId}`);
      lines.push(
        `Recommended: ${JSON.stringify(args.recommendation.primary.value)} — ${args.recommendation.primary.rationale}`,
      );
      args.recommendation.alternatives.forEach((alt, i) => {
        lines.push(`  alt ${i + 1}: ${JSON.stringify(alt.value)} — ${alt.rationale}`);
      });
    }
    // D — selectable alternatives.
    //
    // Old behaviour: options were 5 hardcoded verbs (accept/override/
    // more-options/skip/abort). Alternatives appeared in the question
    // preamble but to pick one the user had to choose `override` then
    // retype the JSON value — equivalent to a free-text answer, even
    // though the leader had already proposed concrete options.
    //
    // New behaviour: every concrete option from the leader becomes its
    // own clickable card row. `more-options` is dropped (was a re-prompt
    // no-op). `override` is renamed `custom value` for clarity.
    //
    // When the leader returns null (source="user-only"), `accept` would
    // feed null into validateAnswer and silently loop on the same askcard.
    // Hide accept + the alt rows in that case so the user MUST type or skip.
    const hasRecommendation = args.recommendation?.primary?.value != null;
    const ALT_PREFIX = "use alt "; // must match parse below
    const ALT_OPT = (i: number, v: unknown): string => `${ALT_PREFIX}${i + 1}: ${JSON.stringify(v)}`;
    const altLabels = hasRecommendation
      ? (args.recommendation?.alternatives ?? []).map((alt, i) => ALT_OPT(i, alt.value))
      : [];
    const options = hasRecommendation
      ? ["accept", ...altLabels, "custom value", "skip", "abort"]
      : ["custom value", "skip", "abort"];
    const choice = await tuiAsk(lines.join("\n"), options);
    if (choice === "accept") return { action: "accept" };
    if (choice === "skip") return { action: "skip" };
    if (choice === "abort") return { action: "abort" };
    if (choice.startsWith(ALT_PREFIX)) {
      const m = choice.match(/^use alt (\d+):/);
      const idx = m ? Number.parseInt(m[1], 10) - 1 : -1;
      const alt = args.recommendation?.alternatives?.[idx];
      if (alt) {
        return { action: "override", value: alt.value, reason: `selected alt ${idx + 1} from AskCard` };
      }
      // Fallthrough to manual entry if parse fails (defensive).
    }
    // custom value
    const value = await tuiAsk("Enter override value (JSON):", []);
    const reason = await tuiAsk("Why override?", []);
    try {
      return { action: "override", value: JSON.parse(value), reason };
    } catch {
      return { action: "override", value, reason };
    }
  };
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export interface GatherIO {
  /** Stream chunks back to the loop driver so the UI can render question askcards. */
  emit?: (chunk: StreamChunk) => void;
  /** Resolve once the user answers the question on this id. Returns the chosen option's `value`. */
  respondToQuestion?: (questionId: string) => Promise<string>;
}

export async function runGatherPhase(
  flowDir: string,
  runId: string,
  idea: string,
  capUsd: number,
  // biome-ignore lint/suspicious/noExplicitAny: llm injected from driver
  llm: any,
  sessionModelId: string,
  io?: GatherIO,
): Promise<ProjectContext> {
  const cwd = process.cwd();
  await acquireRunLock(flowDir, runId);
  try {
    await resumeArtifactWriteIfNeeded(flowDir, runId, idea, await detectExistingProject(cwd));
    const existing = await readProjectContext(flowDir, runId);
    if (existing) return existing;

    const detection = await detectExistingProject(cwd);
    const leaderResolution = await resolveLeaderModelDetailed(sessionModelId);
    const leaderModelId = leaderResolution.modelId;
    if (process.env.MUONROI_DEBUG_LEADER === "1") {
      process.stderr.write(
        "[leader-resolve] leaderModelId=" +
          leaderModelId +
          " sessionModelId=" +
          sessionModelId +
          (leaderResolution.promotedFrom ? ` promotedFrom=${leaderResolution.promotedFrom.modelId}` : "") +
          (leaderResolution.defaulted ? " defaulted=true" : "") +
          "\n",
      );
    }

    // Minimal LeaderLike adapter for parsePromptForContext / recommender.
    // LeaderLike expects {content, costUsd} but council llm.generate returns
    // just the text string — wrap it so leaderRecommend can parse the result
    // (otherwise res.content is undefined → falls back to "leader unavailable").
    // modelId is set so emitLeaderDebug logs the actual model instead of "unknown".
    const leader: LeaderLike & { modelId: string } = {
      modelId: leaderModelId,
      generate: async (args: { system: string; prompt: string; maxTokens: number }) => {
        const text = await llm.generate(leaderModelId, args.system, args.prompt, args.maxTokens);
        return { content: text, costUsd: 0 };
      },
    };

    const { partial: prompted } = await parsePromptForContext(idea, leader);

    // Synthesize a `backendStack` answer from detection so the interview can
    // SKIP the question AND downstream consumers
    // (formatProjectContextForPrompt) find a real value. Session e2660a052918
    // crashed because the prefillSource flag claimed backendStack was
    // answered but no actual value lived in prefillAnswers.
    //
    // Selection rule (NOT just languages[0] — polyglot would pick arbitrarily):
    //   1. classification === "existing" → use the single dominant manifest's
    //      inferredLang + first framework. Deterministic + weight-grounded
    //      since classify() requires manifest.weight > 0 + srcFileCount > 5.
    //   2. classification === "ambiguous" with EXACTLY ONE detected language
    //      → use it (no framework signal in this case).
    //   3. classification === "ambiguous" with multiple detected languages
    //      (polyglot, e.g. ["TypeScript", "Python"]) → DO NOT synthesize.
    //      The interview SHOULD ask the user which stack the change targets.
    //   4. greenfield → not in this path (no languages detected).
    //
    // When we don't synthesize, we also don't flag fromDetection — so the
    // interview asks the question normally rather than skipping a question
    // whose answer never materialized.
    const backendStackFromDetection = pickBackendStackFromDetection(detection);
    const fromDetectionIds: string[] = [];
    const prefillFromDetection: Partial<DiscoveryContext> = {};
    if (backendStackFromDetection) {
      prefillFromDetection.backendStack = backendStackFromDetection;
      fromDetectionIds.push("backendStack");
    }

    await initDiscoveryState(flowDir, runId, {
      classification: detection.classification,
      prefillSource: {
        fromDetection: fromDetectionIds,
        fromPrompt: Object.keys(prompted),
      },
      prefillAnswers: { ...prefillFromDetection, ...prompted },
    });

    // Recommender: always leader-only. The council debate runner (Task 16) is
    // a stub that throws; until it is wired we delegate council asks to the
    // leader so the gather phase doesn't crash on greenfield projects with
    // unused budget.
    const recommender = {
      leaderRecommend: async (input: Parameters<typeof leaderRecommend>[0]) => leaderRecommend(input, leader),
      councilRecommend: async (input: Parameters<typeof councilRecommend>[0]) => leaderRecommend(input, leader),
    };
    // Silence unused-import warning for the stub-only recommender helpers we
    // intentionally bypass above.
    void buildDiscoveryDebateRunner;
    void councilRecommend;
    void shouldFallbackToLeader;
    void readDiscoveryState;

    // Build a real tuiAsk if the driver wired emit + respondToQuestion. The
    // stub `async () => ""` falls back to the old infinite-loop behavior
    // (only hit by tests that don't supply io).
    const tuiAsk = io?.emit && io?.respondToQuestion ? buildLiveTuiAsk(io.emit, io.respondToQuestion) : async () => "";
    const userPrompt: UserPromptFn = buildGatherUserPrompt(tuiAsk);

    return await iterateInterview({
      flowDir,
      runId,
      idea,
      capUsd,
      detection,
      userPrompt,
      recommender,
    });
  } finally {
    await releaseRunLock(flowDir, runId);
  }
}

// ---------------------------------------------------------------------------
// ClarifiedSpec bridge
// ---------------------------------------------------------------------------

/**
 * Map a completed ProjectContext (from runGatherPhase) into the ClarifiedSpec
 * shape expected by the research/scoping stages.  All six SEED_DIMENSIONS are
 * marked "answered" because iterateInterview only returns after the user gate
 * has passed (or all required questions are answered).
 */
export function clarifiedSpecFromContext(pc: ProjectContext): ClarifiedSpec {
  const ctx: DiscoveryContext = pc.context;

  const problemStatement = pc.idea;

  const constraints: string[] = [];
  if (ctx.backendStack?.language) constraints.push(`Language: ${ctx.backendStack.language}`);
  if (ctx.backendStack?.framework) constraints.push(`Framework: ${ctx.backendStack.framework}`);
  if (ctx.backendArchitecture) constraints.push(`Architecture: ${ctx.backendArchitecture}`);

  const successCriteria: string[] = [];
  if (ctx.audience?.persona) successCriteria.push(`Persona: ${ctx.audience.persona}`);
  if (ctx.audience?.scale) successCriteria.push(`Scale: ${ctx.audience.scale}`);

  const scope = ctx.productType ?? "unknown";

  const rawQA = Object.entries(ctx).map(([key, value]) => ({
    question: key,
    answer: typeof value === "object" ? JSON.stringify(value) : String(value ?? ""),
  }));

  // Map gather answers onto the 6 SEED_DIMENSIONS. We mark a dimension
  // "answered" whenever ANY relevant gather field has a truthy value — even
  // when the LLM returned a free-form string instead of the structured shape
  // (e.g. backendStack: "Node.js with Express" vs {language, framework}). The
  // alternative is to halt the run on every shape mismatch, which makes the
  // gather phase brittle to LLM output variance for fields the discovery
  // schema does not strictly validate.
  const truthy = (v: unknown): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return Boolean(v);
  };
  const resolved: Record<string, "answered" | "unspecified" | "skipped"> = {
    persona: ctx.audience?.persona ? "answered" : "unspecified",
    "core-features": ctx.productType ? "answered" : "unspecified",
    "non-functional": ctx.audience?.scale || truthy(ctx.deployment) ? "answered" : "unspecified",
    "tech-constraints": truthy(ctx.backendStack) || truthy(ctx.backendArchitecture) ? "answered" : "unspecified",
    "success-metric": ctx.audience?.persona ? "answered" : "unspecified",
    // cost-tolerance has no dedicated DISCOVERY_QUESTION — the per-run capUsd
    // flag (default $50) is the canonical answer. Treat it as answered when
    // gather completes (any non-null context means the user accepted defaults
    // by passing the gate).
    "cost-tolerance": Object.keys(ctx).length > 0 ? "answered" : "unspecified",
  };

  return { problemStatement, constraints, successCriteria, scope, rawQA, resolved };
}
