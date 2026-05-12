import type { CouncilQuestionOption, StreamChunk } from "../types/index.js";
import type { ClarifiedSpec, CouncilLLM, QuestionResponder } from "./types.js";
import { buildClarificationPrompt, buildSpecSynthesisPrompt } from "./prompts.js";
import { tracedGenerate } from "./llm.js";
import { phaseDone, phaseError, phaseStart } from "./phase-events.js";
import type { GrayAreaQuestion } from "../gsd/gray-areas.js";
import { pickCouncilTaskModel } from "./leader.js";

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

export async function* runClarification(
  topic: string,
  leaderModelId: string,
  conversationContext: string,
  respondToQuestion: QuestionResponder,
  llm: CouncilLLM,
  signal?: AbortSignal,
  seedQuestions?: GrayAreaQuestion[],
  maxRounds?: number,
  /**
   * Optional pre-filled answers keyed by seed-question id. When the loop's
   * discover phase has already proven a dimension from the project (e.g.
   * tech-constraints from package.json), the matching seed question is
   * skipped: its answer is appended to allQA without prompting the user, and
   * a confirmation chunk is emitted instead.
   */
  prefillAnswers?: Map<string, string>,
  /**
   * When true, clarification question generation and spec synthesis run on
   * a cheaper tier model on the same provider as the leader. Falls back to
   * the leader model if no cheaper model is cataloged. Default false.
   */
  costAware = false,
): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
  const max = typeof maxRounds === "number" && maxRounds > 0 ? maxRounds : 3;
  const allQA: Array<{ id?: string; question: string; answer: string }> = [];

  const phaseStartedAt = Date.now();
  yield phaseStart({ phaseId: "phase:clarification", kind: "clarification", label: "Clarification" });

  const seeded = (seedQuestions ?? []).map(grayAreaToRoundQuestion);

  for (let round = 0; round < max; round++) {
    const useSeed = round === 0 && seeded.length > 0;
    const roundId = `phase:clarification-round-${round + 1}`;
    const roundStart = Date.now();
    yield phaseStart({
      phaseId: roundId,
      kind: "clarification_round",
      label: useSeed ? `Clarification round ${round + 1} (PIL-seeded)` : `Clarification round ${round + 1}`,
    });

    let questions: Array<{ id?: string; question: string; why: string; suggestions?: string[]; recommended?: string; isRequired: boolean }>;

    if (useSeed) {
      questions = (seedQuestions ?? []).map(g => ({
        id: g.id,
        ...grayAreaToRoundQuestion(g)
      }));
    } else {
      const { system, prompt } = buildClarificationPrompt(topic, conversationContext, allQA.length > 0 ? allQA : undefined);

      let questionsRaw: string;
      try {
        const clarifyModel = pickCouncilTaskModel("clarify_questions", leaderModelId, costAware);
        questionsRaw = yield* tracedGenerate(llm, {
          phase: "clarify",
          label: `Generating clarification questions (round ${round + 1})`,
          modelId: clarifyModel,
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
      // Skip seed questions whose dimension was proven by project discovery.
      // The auto-filled answer is recorded as a normal Q&A so synthesizeSpec
      // and the resolved-map see it as answered.
      if (q.id && prefillAnswers?.has(q.id)) {
        const answer = prefillAnswers.get(q.id)!;
        allQA.push({ id: q.id, question: q.question, answer });
        yield {
          type: "content",
          content: `\n**${q.question}**\n  ↳ _${answer}_ (auto-filled from project)\n`,
        };
        continue;
      }

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
      allQA.push({ id: q.id, question: q.question, answer });
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

  const spec = yield* synthesizeSpec(topic, conversationContext, allQA, leaderModelId, llm, costAware);

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

/**
 * Generate richer success criteria from the topic alone when clarifier returned
 * no questions. The single-criterion fallback ("Address the topic: …") made
 * leader-eval meaningless: "1/1 criteria met" trivially trips on round 1 even
 * for complex topics. Session ea13da132dec hit this because clarifier returned
 * [] and the spec had only one auto-criterion → leader had nothing real to grade.
 *
 * We LLM-extract criteria/constraints/scope from the topic when QA is empty.
 * Falls back to the original buildSpecFromTopic if the LLM call fails.
 */
async function* inferSpecFromTopicOnly(
  topic: string,
  conversationContext: string,
  leaderModelId: string,
  llm: CouncilLLM,
  costAware: boolean,
): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
  const system =
    `You are extracting an implicit specification from a short topic statement. ` +
    `The user did not answer clarification questions, but the topic itself often ` +
    `implies scope, criteria, and constraints. Tease them out.\n\n` +
    `Output ONLY a JSON object (no markdown, no preamble):\n` +
    `{\n` +
    `  "problemStatement": "1-2 sentence problem statement in the user's language",\n` +
    `  "constraints": ["constraint 1", "constraint 2"],\n` +
    `  "successCriteria": ["criterion 1", "criterion 2", "criterion 3"],\n` +
    `  "scope": "what is in and out of scope, in 1-2 sentences"\n` +
    `}\n\n` +
    `Rules:\n` +
    `- successCriteria MUST have AT LEAST 3 entries. These should be observable, testable ` +
    `outcomes — not "address the topic". For a feature topic, criteria look like ` +
    `"User can do X in under Y", "System supports Z platform", "Performance budget P ms".\n` +
    `- constraints should include any explicit limits the topic mentions (platforms, languages, ` +
    `vendors). If no constraints are explicit, infer 1-2 likely-implicit ones (e.g. "Must work ` +
    `offline" for a desktop app topic, "Must respect Manifest V3" for a Chrome extension).\n` +
    `- scope should name 1 thing in-scope and 1 thing OUT-of-scope.\n` +
    `- Write all fields in the user's language (detected from the topic).`;
  const prompt =
    `## Topic\n${topic}\n\n` +
    (conversationContext ? `## Context\n${conversationContext}\n` : "");

  try {
    const synthModel = pickCouncilTaskModel("spec_synthesis", leaderModelId, costAware);
    const raw = yield* tracedGenerate(llm, {
      phase: "synthesis",
      label: "Inferring spec from topic (no clarification answers)",
      modelId: synthModel,
      system,
      prompt,
      maxTokens: 1024,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<ClarifiedSpec>;
      const criteria = Array.isArray(parsed.successCriteria) && parsed.successCriteria.length >= 1
        ? parsed.successCriteria
        : [`Address the topic: ${topic.slice(0, 100)}`];
      // Hard floor of 3 — pad with the default if model returned fewer.
      while (criteria.length < 3) {
        criteria.push(`Open success criterion ${criteria.length + 1} (not specified by user)`);
      }
      return {
        problemStatement: parsed.problemStatement ?? topic,
        constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
        successCriteria: criteria,
        scope: parsed.scope ?? "Determined by conversation context",
        rawQA: [],
      };
    }
  } catch {
    // Fall through to original buildSpecFromTopic shape
  }
  return buildSpecFromTopic(topic, conversationContext);
}

async function* synthesizeSpec(
  topic: string,
  conversationContext: string,
  qa: Array<{ id?: string; question: string; answer: string }>,
  leaderModelId: string,
  llm: CouncilLLM,
  costAware = false,
): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
  if (qa.length === 0) {
    // Clarifier asked 0 questions OR user skipped all of them. Use the LLM to
    // pull implicit criteria/constraints/scope from the topic alone instead of
    // returning the single-criterion fallback that makes leader-eval trivial.
    return yield* inferSpecFromTopicOnly(topic, conversationContext, leaderModelId, llm, costAware);
  }

  const { system, prompt } = buildSpecSynthesisPrompt(topic, conversationContext, qa);
  const resolved: Record<string, "answered" | "unspecified" | "skipped"> = {};
  for (const item of qa) {
    if (item.id) {
      resolved[item.id] = "answered";
    }
  }

  try {
    const synthModel = pickCouncilTaskModel("spec_synthesis", leaderModelId, costAware);
    const raw = yield* tracedGenerate(llm, {
      phase: "synthesis",
      label: "Synthesizing clarified spec",
      modelId: synthModel,
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
        resolved,
      };
    }
  } catch {
    // Fall through to default
  }

  return { problemStatement: topic, constraints: [], successCriteria: [`Address: ${topic.slice(0, 100)}`], scope: "", rawQA: qa, resolved };
}
