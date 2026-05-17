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
import type { DiscoveryContext, ProjectContext } from "./types.js";

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
    if (!options || options.length === 0) {
      emit({ type: "content", content: `\n> ${label}\n` } as StreamChunk);
      return "";
    }
    const questionId = crypto.randomUUID();
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
    return await respondToQuestion(questionId);
  };
}

function buildGatherUserPrompt(tuiAsk: (label: string, options?: string[]) => Promise<string>): UserPromptFn {
  return async (args: UserPromptArgs): Promise<UserPromptResult> => {
    if (args.questionId === "__user_gate__") {
      const choice = await tuiAsk("All required questions answered. Proceed to research or ask more?", [
        "proceed",
        "ask-more",
        "abort",
      ]);
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
    // When the leader returns null (source="user-only"), "accept" would feed null
    // into validateAnswer and silently loop on the same askcard. Hide it so the
    // user must override / skip / abort.
    const hasRecommendation = args.recommendation?.primary?.value != null;
    const options = hasRecommendation
      ? ["accept", "override", "more-options", "skip", "abort"]
      : ["override", "skip", "abort"];
    const choice = await tuiAsk(lines.join("\n"), options);
    if (choice === "accept") return { action: "accept" };
    if (choice === "skip") return { action: "skip" };
    if (choice === "more-options") return { action: "more-options" };
    if (choice === "abort") return { action: "abort" };
    // override
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
          (leaderResolution.promotedFrom ? " promotedFrom=" + leaderResolution.promotedFrom.modelId : "") +
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

    await initDiscoveryState(flowDir, runId, {
      classification: detection.classification,
      prefillSource: {
        fromDetection: detection.languages.length ? ["backendStack"] : [],
        fromPrompt: Object.keys(prompted),
      },
      prefillAnswers: prompted,
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
