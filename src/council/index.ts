import type { ModelMessage } from "ai";
import type { StreamChunk } from "../types/index.js";
import { appendSystemMessage } from "../storage/index.js";
import { isCouncilMultiProviderPreferred } from "../utils/settings.js";
import type {
  ClarifiedSpec,
  CouncilLLM,
  CouncilParticipant,
  CouncilStats,
  PreflightResponder,
  QuestionResponder,
} from "./types.js";
import { resolveLeaderModel, resolveParticipants } from "./leader.js";
import { buildCouncilContext } from "./context.js";
import { runClarification, buildSpecFromTopic } from "./clarifier.js";
import { runPreflight } from "./preflight.js";
import { runDebate } from "./debate.js";
import { runPlanning } from "./planner.js";
import { runExecution } from "./executor.js";
import { COUNCIL_COLOR_RESET } from "../orchestrator/agent-options.js";

export interface RunCouncilOptions {
  skipClarification?: boolean;
  userModelMessage?: ModelMessage;
  signal?: AbortSignal;
}

export async function* runCouncil(
  topic: string,
  sessionModelId: string,
  messages: Array<{ role: string; content: string | unknown }>,
  sessionId: string | undefined,
  llm: CouncilLLM,
  respondToQuestion: QuestionResponder,
  respondToPreflight: PreflightResponder,
  processMessageFn: (message: string) => AsyncGenerator<StreamChunk, void, unknown>,
  options?: RunCouncilOptions,
): AsyncGenerator<StreamChunk, string | null, unknown> {
  const stats: CouncilStats = { calls: 0, startMs: Date.now(), phases: [] };

  // ── Resolve models ──────────────────────────────────────────────────────────
  const leaderModelId = resolveLeaderModel(sessionModelId);
  const participants = await resolveParticipants(sessionModelId, isCouncilMultiProviderPreferred());

  if (participants.length < 2) {
    yield { type: "content", content: "\nNo reachable provider. Check API keys in user-settings.json or environment.\n" };
    yield { type: "done" };
    return null;
  }

  yield { type: "content", content: `\n[Leader: \x1b[32m${leaderModelId}${COUNCIL_COLOR_RESET} | Participants: ${participants.map((p) => `${p.role}:${p.model}`).join(", ")}]\n` };

  const conversationContext = buildCouncilContext(messages);
  const active: CouncilParticipant[] = participants.map((p) => ({ ...p, position: "" }));

  // ── Phase A + B loop: Clarify → Confirm ─────────────────────────────────────
  let spec: ClarifiedSpec = buildSpecFromTopic(topic, conversationContext);
  let approved = false;
  const phaseAStart = Date.now();

  while (!approved) {
    if (!options?.skipClarification) {
      const clarifyGen = runClarification(topic, leaderModelId, conversationContext, respondToQuestion, llm, options?.signal);
      let clarifyResult: IteratorResult<StreamChunk, ClarifiedSpec>;
      do {
        clarifyResult = await clarifyGen.next();
        if (!clarifyResult.done && clarifyResult.value) {
          yield clarifyResult.value;
        }
      } while (!clarifyResult.done);
      spec = clarifyResult.value;
    } else {
      spec = buildSpecFromTopic(topic, conversationContext);
      yield { type: "content", content: `\n> Auto-council: skipping clarification (PIL pre-classified).\n` };
    }

    const researchNeeded = true;
    const preflightGen = runPreflight(spec, participants, researchNeeded, respondToPreflight);
    let preflightResult: IteratorResult<StreamChunk, boolean>;
    do {
      preflightResult = await preflightGen.next();
      if (!preflightResult.done && preflightResult.value) {
        yield preflightResult.value;
      }
    } while (!preflightResult.done);
    approved = preflightResult.value;
  }

  stats.phases.push({ name: "clarify+preflight", durationMs: Date.now() - phaseAStart });

  // ── Phase C: Dynamic Debate ─────────────────────────────────────────────────
  const debateStart = Date.now();
  const debateGen = runDebate(spec, {
    topic,
    conversationContext,
    leaderModelId,
    participants: active,
    signal: options?.signal,
  }, llm);

  let debateResult: IteratorResult<StreamChunk, import("./types.js").DebateState>;
  do {
    debateResult = await debateGen.next();
    if (!debateResult.done && debateResult.value) {
      yield debateResult.value;
    }
  } while (!debateResult.done);
  const debateState = debateResult.value;
  stats.phases.push({ name: "debate", durationMs: Date.now() - debateStart });

  // ── Phase D: Plan ───────────────────────────────────────────────────────────
  const planStart = Date.now();
  const planGen = runPlanning(debateState, spec, active, leaderModelId, respondToPreflight, llm);

  let planResult: IteratorResult<StreamChunk, { outcome: import("./types.js").EnhancedCouncilOutcome | null; plan: import("./types.js").ActionPlan | null; synthesisText: string }>;
  do {
    planResult = await planGen.next();
    if (!planResult.done && planResult.value) {
      yield planResult.value;
    }
  } while (!planResult.done);
  const { outcome, plan, synthesisText } = planResult.value;
  stats.phases.push({ name: "planning", durationMs: Date.now() - planStart });

  // ── Persist outcome ─────────────────────────────────────────────────────────
  if (sessionId) {
    try {
      if (outcome) {
        appendSystemMessage(sessionId, `[Council Decision]\nTopic: ${topic}\n${outcome.summary}\nAgreed: ${outcome.agreed.join("; ")}\nRecommendation: ${outcome.recommendation}`);
        appendSystemMessage(sessionId, `[Council Outcome]\n${JSON.stringify(outcome)}`);
      }
      const councilRecord = {
        topic,
        spec,
        participants: active.map((a) => ({ role: a.role, model: a.model })),
        finalPositions: active.map((a) => ({ role: a.role, position: a.position.slice(0, 1000) })),
        synthesis: synthesisText.slice(0, 2000),
        stats: { calls: stats.calls, durationMs: Date.now() - stats.startMs, phases: stats.phases },
        timestamp: new Date().toISOString(),
      };
      appendSystemMessage(sessionId, `[Council Memory] ${JSON.stringify(councilRecord)}`);
    } catch { /* non-critical */ }
  }

  // ── Phase E: Execute (if plan approved) ─────────────────────────────────────
  if (plan && plan.steps.length > 0) {
    const execStart = Date.now();
    yield* runExecution(plan, processMessageFn);
    stats.phases.push({ name: "execution", durationMs: Date.now() - execStart });
  }

  // ── Stats ───────────────────────────────────────────────────────────────────
  const totalMs = Date.now() - stats.startMs;
  yield {
    type: "content",
    content:
      `\n---\n` +
      `> Council stats: ${stats.calls} API calls, ${(totalMs / 1000).toFixed(1)}s total, ` +
      `${active.length} participants, ${debateState.roundCount} rounds\n` +
      `> Phases: ${stats.phases.map((p) => `${p.name}=${(p.durationMs / 1000).toFixed(1)}s`).join(", ")}\n`,
  };

  yield { type: "done" };
  return synthesisText || null;
}

export type { ClarifiedSpec, CouncilLLM, CouncilStats, CouncilParticipant } from "./types.js";
