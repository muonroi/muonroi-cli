import type { StreamChunk } from "../types/index.js";
import type { ClarifiedSpec, CouncilLLM, QuestionResponder } from "./types.js";
import { buildClarificationPrompt, buildSpecSynthesisPrompt } from "./prompts.js";

const MAX_CLARIFICATION_ROUNDS = 3;

export async function* runClarification(
  topic: string,
  leaderModelId: string,
  conversationContext: string,
  respondToQuestion: QuestionResponder,
  llm: CouncilLLM,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
  const allQA: Array<{ question: string; answer: string }> = [];

  yield { type: "content", content: "\n## Phase A — Clarification\n" };

  for (let round = 0; round < MAX_CLARIFICATION_ROUNDS; round++) {
    const { system, prompt } = buildClarificationPrompt(topic, conversationContext, allQA.length > 0 ? allQA : undefined);

    let questionsRaw: string;
    try {
      questionsRaw = await llm.generate(leaderModelId, system, prompt, 2048);
    } catch (err) {
      yield { type: "content", content: `[Clarification error: ${err instanceof Error ? err.message : err}]\n` };
      break;
    }

    let questions: Array<{ question: string; why: string; suggestions?: string[]; isRequired: boolean }>;
    try {
      const match = questionsRaw.match(/\[[\s\S]*\]/);
      questions = match ? JSON.parse(match[0]) : [];
    } catch {
      questions = [];
    }

    if (questions.length === 0) {
      yield { type: "content", content: `> No further clarification needed.\n` };
      break;
    }

    yield { type: "content", content: `\n### Clarification Round ${round + 1}\n` };

    for (const q of questions) {
      const questionId = crypto.randomUUID();

      yield {
        type: "council_question" as StreamChunk["type"],
        content: `**${q.question}**\n${q.why ? `> ${q.why}` : ""}`,
        councilQuestion: {
          questionId,
          question: q.question,
          context: q.why,
          suggestions: q.suggestions,
          isRequired: q.isRequired,
        },
      };

      const answer = await respondToQuestion(questionId);
      allQA.push({ question: q.question, answer });
      yield { type: "content", content: `\n> **Q:** ${q.question}\n> **A:** ${answer}\n` };
    }
  }

  const spec = await synthesizeSpec(topic, conversationContext, allQA, leaderModelId, llm);

  yield { type: "content", content: `\n### Clarified Spec\n` };
  yield { type: "content", content: `**Problem:** ${spec.problemStatement}\n` };
  yield { type: "content", content: `**Constraints:** ${spec.constraints.join(", ")}\n` };
  yield { type: "content", content: `**Success Criteria:** ${spec.successCriteria.join(", ")}\n` };
  yield { type: "content", content: `**Scope:** ${spec.scope}\n` };

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

async function synthesizeSpec(
  topic: string,
  conversationContext: string,
  qa: Array<{ question: string; answer: string }>,
  leaderModelId: string,
  llm: CouncilLLM,
): Promise<ClarifiedSpec> {
  if (qa.length === 0) {
    return buildSpecFromTopic(topic, conversationContext);
  }

  const { system, prompt } = buildSpecSynthesisPrompt(topic, conversationContext, qa);

  try {
    const raw = await llm.generate(leaderModelId, system, prompt, 2048);
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
