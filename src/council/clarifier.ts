import type { CouncilQuestionOption, StreamChunk } from "../types/index.js";
import type { ClarifiedSpec, CouncilLLM, QuestionResponder } from "./types.js";
import { buildClarificationPrompt, buildSpecSynthesisPrompt } from "./prompts.js";
import { tracedGenerate } from "./llm.js";
import { phaseDone, phaseError, phaseStart } from "./phase-events.js";
import type { GrayAreaQuestion } from "../gsd/gray-areas.js";

/**
 * Convert a PIL gray-area question into the clarifier's round-question shape.
 * The first option is treated as the recommended default (matches the
 * convention used by detectGrayAreas).
 */
function grayAreaToRoundQuestion(g: GrayAreaQuestion): {
  question: string;
  why: string;
  suggestions: string[];
  recommended: string;
  isRequired: boolean;
} {
  return {
    question: g.question,
    why: `Gray area: ${g.dimension} dimension is unspecified.`,
    suggestions: g.options,
    recommended: g.options[0] ?? "",
    isRequired: true,
  };
}

export interface ClarifyOptionsResult {
  options: CouncilQuestionOption[];
  /**
   * Index of the agent's recommended option, or undefined when the agent did
   * not provide a recommendation. The card uses this to decide whether to
   * show the "(Recommended)" tag — it stays hidden when undefined.
   */
  defaultIndex?: number;
}

/**
 * Convert legacy `suggestions: string[]` into the new options schema with
 * standard "Type something" / "Chat about this" escape-hatches appended.
 *
 * The card UI uses `kind` to decide how to handle each option:
 *  - choice   → submit value as-is
 *  - freetext → open inline text input
 *  - chat     → pause council and let user discuss before answering
 *
 * If `recommended` is provided AND matches one of the suggestions, the
 * returned `defaultIndex` points to it. Otherwise `defaultIndex` is omitted
 * so the UI knows to suppress the "(Recommended)" tag.
 */
export function buildClarifyOptions(
  suggestions: string[] | undefined,
  recommended?: string,
): ClarifyOptionsResult {
  const choices: CouncilQuestionOption[] = (suggestions ?? [])
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => ({ label: s.trim(), value: s.trim(), kind: "choice" as const }));

  const options: CouncilQuestionOption[] = [
    ...choices,
    {
      label: "Type something",
      description: "Nhập câu trả lời tự do",
      value: "",
      kind: "freetext" as const,
    },
    {
      label: "Chat about this",
      description: "Thảo luận thêm trước khi trả lời",
      value: "",
      kind: "chat" as const,
    },
  ];

  let defaultIndex: number | undefined;
  if (typeof recommended === "string" && recommended.trim().length > 0) {
    const target = recommended.trim().toLowerCase();
    const idx = choices.findIndex((opt) => opt.value.toLowerCase() === target);
    if (idx !== -1) defaultIndex = idx;
  }

  return { options, defaultIndex };
}

const MAX_CLARIFICATION_ROUNDS = 3;

export async function* runClarification(
  topic: string,
  leaderModelId: string,
  conversationContext: string,
  respondToQuestion: QuestionResponder,
  llm: CouncilLLM,
  signal?: AbortSignal,
  seedQuestions?: GrayAreaQuestion[],
): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
  const allQA: Array<{ question: string; answer: string }> = [];

  const phaseStartedAt = Date.now();
  yield phaseStart({ phaseId: "phase:clarification", kind: "clarification", label: "Clarification" });

  const seeded = (seedQuestions ?? []).map(grayAreaToRoundQuestion);

  for (let round = 0; round < MAX_CLARIFICATION_ROUNDS; round++) {
    const useSeed = round === 0 && seeded.length > 0;
    const roundId = `phase:clarification-round-${round + 1}`;
    const roundStart = Date.now();
    yield phaseStart({
      phaseId: roundId,
      kind: "clarification_round",
      label: useSeed ? `Clarification round ${round + 1} (PIL-seeded)` : `Clarification round ${round + 1}`,
    });

    let questions: Array<{ question: string; why: string; suggestions?: string[]; recommended?: string; isRequired: boolean }>;

    if (useSeed) {
      questions = seeded;
    } else {
      const { system, prompt } = buildClarificationPrompt(topic, conversationContext, allQA.length > 0 ? allQA : undefined);

      let questionsRaw: string;
      try {
        questionsRaw = yield* tracedGenerate(llm, {
          phase: "clarify",
          label: `Generating clarification questions (round ${round + 1})`,
          modelId: leaderModelId,
          system,
          prompt,
          maxTokens: 2048,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield phaseError({ phaseId: roundId, kind: "clarification_round", label: `Clarification round ${round + 1}`, startedAt: roundStart, errorMessage: msg });
        yield { type: "content", content: `[Clarification error: ${msg}]\n` };
        break;
      }

      try {
        const match = questionsRaw.match(/\[[\s\S]*\]/);
        questions = match ? JSON.parse(match[0]) : [];
      } catch {
        questions = [];
      }
    }

    if (questions.length === 0) {
      yield phaseDone({
        phaseId: roundId,
        kind: "clarification_round",
        label: `Clarification round ${round + 1}`,
        startedAt: roundStart,
        detail: "no further clarification needed",
      });
      break;
    }

    yield phaseDone({
      phaseId: roundId,
      kind: "clarification_round",
      label: `Clarification round ${round + 1}`,
      startedAt: roundStart,
      detail: `${questions.length} question${questions.length === 1 ? "" : "s"}`,
    });

    for (const q of questions) {
      const questionId = crypto.randomUUID();
      const { options, defaultIndex } = buildClarifyOptions(q.suggestions, q.recommended);

      yield {
        type: "council_question" as StreamChunk["type"],
        content: `**${q.question}**\n${q.why ? `> ${q.why}` : ""}`,
        councilQuestion: {
          questionId,
          phase: "clarify",
          question: q.question,
          context: q.why,
          suggestions: q.suggestions,
          options,
          isRequired: q.isRequired,
          defaultIndex,
        },
      };

      const answer = await respondToQuestion(questionId);
      allQA.push({ question: q.question, answer });
      yield { type: "content", content: `\n  ↳ ${answer}\n` };
    }
  }

  yield phaseDone({
    phaseId: "phase:clarification",
    kind: "clarification",
    label: "Clarification",
    startedAt: phaseStartedAt,
    detail: allQA.length > 0 ? `${allQA.length} Q&A` : "no clarification needed",
  });

  const spec = yield* synthesizeSpec(topic, conversationContext, allQA, leaderModelId, llm);

  yield { type: "content", content: `\n### Clarified Spec\n` };
  yield { type: "content", content: `\n#### Problem\n${spec.problemStatement}\n` };
  yield { type: "content", content: `\n#### Constraints\n${spec.constraints.map((c) => `- ${c}`).join("\n") || "- (none)"}\n` };
  yield { type: "content", content: `\n#### Success Criteria\n${spec.successCriteria.map((c) => `- ${c}`).join("\n")}\n` };
  yield { type: "content", content: `\n#### Scope\n${spec.scope || "(unspecified)"}\n` };

  return spec;
}

export function buildSpecFromTopic(topic: string, conversationContext: string): ClarifiedSpec {
  return {
    problemStatement: topic,
    constraints: [],
    successCriteria: [`Address the topic: ${topic.slice(0, 100)}`],
    scope: "Determined by conversation context",
    rawQA: [],
  };
}

async function* synthesizeSpec(
  topic: string,
  conversationContext: string,
  qa: Array<{ question: string; answer: string }>,
  leaderModelId: string,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
  if (qa.length === 0) {
    return buildSpecFromTopic(topic, conversationContext);
  }

  const { system, prompt } = buildSpecSynthesisPrompt(topic, conversationContext, qa);

  try {
    const raw = yield* tracedGenerate(llm, {
      phase: "synthesis",
      label: "Synthesizing clarified spec",
      modelId: leaderModelId,
      system,
      prompt,
      maxTokens: 2048,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<ClarifiedSpec>;
      return {
        problemStatement: parsed.problemStatement ?? topic,
        constraints: parsed.constraints ?? [],
        successCriteria: parsed.successCriteria ?? [`Address: ${topic.slice(0, 100)}`],
        scope: parsed.scope ?? "",
        rawQA: qa,
      };
    }
  } catch {
    // Fall through to default
  }

  return { problemStatement: topic, constraints: [], successCriteria: [`Address: ${topic.slice(0, 100)}`], scope: "", rawQA: qa };
}
