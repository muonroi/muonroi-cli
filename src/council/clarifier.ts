import type { GrayAreaQuestion } from "../gsd/gray-areas.js";
import { getMcpKey } from "../mcp/mcp-keychain.js";
import { getWebResearchModel } from "../models/registry.js";
import type { CouncilQuestionOption, StreamChunk } from "../types/index.js";
import { pickCouncilTaskModel } from "./leader.js";
import { tracedGenerate, tracedGenerateWithFallback } from "./llm.js";
import { phaseDone, phaseError, phaseStart } from "./phase-events.js";
import { buildClarificationPrompt, buildReadinessJudgePrompt, buildSpecSynthesisPrompt } from "./prompts.js";
import type { ClarifiedSpec, CouncilLLM, QuestionResponder } from "./types.js";

/** P5: Hard cap on clarification rounds regardless of judge verdict. */
export const MAX_CLARIFY_ROUNDS = 12;

/**
 * G2-a: Hard cap on clarifier questions SURFACED per round, regardless of how
 * many the model emits. buildClarificationPrompt asks for "typically 0-2", but
 * that soft hint has repeatedly been ignored (e.g. 6 generic greenfield
 * questions on a scoped "improve council quality" topic). This deterministic
 * cap enforces the documented target so the user is never carpet-bombed.
 */
export const MAX_CLARIFY_QUESTIONS_PER_ROUND = 2;

/**
 * G2-a: Generic "greenfield" questions that the prompt already tells the model
 * NOT to ask when a "## Current Project" snapshot is present (existing repo) —
 * product type, target audience, which language/framework, which database,
 * hosting/deploy target. Matched in both English and Vietnamese on the
 * question + why text. Used only as an existing-repo filter; never applied to
 * greenfield topics where these questions are legitimate.
 */
const GREENFIELD_QUESTION_RE =
  /\b(target audience|product type|what (kind|type) of (product|app|application)|which (programming )?language|which framework|which database|which db|hosting|deploy(ment)? target|tech stack)\b|đối tượng (người dùng|sử dụng)|loại (sản phẩm|ứng dụng)|ngôn ngữ (lập trình|nào)|framework nào|cơ sở dữ liệu|database nào|triển khai ở đâu/i;

export function isGenericGreenfieldQuestion(q: { question: string; why?: string }): boolean {
  return GREENFIELD_QUESTION_RE.test(`${q.question} ${q.why ?? ""}`);
}

/**
 * G2-a: deterministically enforce the clarifier's "typically 0-2 questions"
 * rule. In an existing repo (`existingRepo` — a "## Current Project" snapshot
 * is present) first drop generic greenfield questions the prompt already told
 * the model not to ask; then hard-cap the remainder at
 * MAX_CLARIFY_QUESTIONS_PER_ROUND. Never zero out a round that had questions —
 * if every one looked generic, keep the model's top pick rather than asking
 * nothing. Pure + exported so it is unit-testable in isolation.
 */
export function capClarifierQuestions<T extends { question: string; why?: string }>(
  questions: T[],
  existingRepo: boolean,
): { kept: T[]; dropped: number } {
  const before = questions.length;
  let kept = questions;
  if (existingRepo) {
    const filtered = kept.filter((q) => !isGenericGreenfieldQuestion(q));
    kept = filtered.length > 0 ? filtered : kept.slice(0, 1);
  }
  if (kept.length > MAX_CLARIFY_QUESTIONS_PER_ROUND) {
    kept = kept.slice(0, MAX_CLARIFY_QUESTIONS_PER_ROUND);
  }
  return { kept, dropped: before - kept.length };
}

/**
 * P5: Call the readiness judge to determine whether the current spec + Q&A is
 * sufficient to start a productive debate, or whether critical gaps remain.
 *
 * Model selection goes through `pickCouncilTaskModel("readiness_judge", ...)` —
 * never a hardcoded model id or provider name.
 */
export async function judgeReadiness(
  spec: ClarifiedSpec,
  topic: string,
  qa: Array<{ question: string; answer: string }>,
  llm: CouncilLLM,
  leaderModelId: string,
  costAware: boolean,
): Promise<{ ready: boolean; confidence: number; gaps: string[] }> {
  const judgeModel = pickCouncilTaskModel("readiness_judge", leaderModelId, costAware);
  const { system, prompt } = buildReadinessJudgePrompt(topic, qa, spec);

  let raw: string;
  try {
    raw = await llm.generate(judgeModel, system, prompt, 512);
  } catch (err) {
    // On LLM failure, default to "not ready" with an empty gaps list so the
    // loop continues rather than breaking on transient errors. Worst case it
    // runs up to MAX_CLARIFY_ROUNDS and exits with ready=false.
    console.error(`[council/clarifier] readiness judge LLM call failed: ${(err as Error)?.message}`);
    return { ready: false, confidence: 0, gaps: [] };
  }

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as {
        ready?: boolean;
        confidence?: number;
        gaps?: unknown;
      };
      const ready = parsed.ready === true;
      const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
      const gaps = Array.isArray(parsed.gaps)
        ? (parsed.gaps as unknown[]).filter((g): g is string => typeof g === "string")
        : [];
      return { ready, confidence, gaps: ready ? [] : gaps };
    }
  } catch {
    // JSON parse failed — fall through
  }

  return { ready: false, confidence: 0, gaps: [] };
}

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
export function buildClarifyOptions(suggestions: string[] | undefined, recommended?: string): ClarifyOptionsResult {
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

/**
 * Model-designed option object: a choice the user picks between, carrying its
 * own explanation. `recommended:true` marks the pre-selected default. This is
 * the richer shape the clarifier prompt now asks for so every choice shows a
 * per-option "why" (not just the question-level `why`).
 */
export interface ClarifyOptionSpec {
  label: string;
  description?: string;
  recommended?: boolean;
}

/**
 * Build council options from the model's richer `{label, description,
 * recommended}` objects, preserving each choice's explanation as `description`
 * and pointing `defaultIndex` at the option the model flagged `recommended`
 * (falling back to the first when none is flagged). The same "Type something" /
 * "Chat about this" escape-hatches are appended as in `buildClarifyOptions`.
 * Pure + exported for unit testing.
 */
export function buildClarifyOptionsRich(specs: ClarifyOptionSpec[] | undefined): ClarifyOptionsResult {
  const cleaned = (specs ?? []).filter(
    (s): s is ClarifyOptionSpec => !!s && typeof s.label === "string" && s.label.trim().length > 0,
  );
  const choices: CouncilQuestionOption[] = cleaned.map((s) => ({
    label: s.label.trim(),
    value: s.label.trim(),
    kind: "choice" as const,
    ...(typeof s.description === "string" && s.description.trim().length > 0
      ? { description: s.description.trim() }
      : {}),
  }));

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
  const recIdx = cleaned.findIndex((s) => s.recommended === true);
  if (recIdx !== -1) defaultIndex = recIdx;

  return { options, defaultIndex };
}

/**
 * Pre-clarify scope research (research-first grounding).
 *
 * Before asking ANY clarification question, research the topic — codebase for an
 * existing repo (the research method reads the tree) plus web — so the
 * question-generator surfaces the REAL gray areas the evidence exposes instead
 * of guessing blind ("hỏi tào lao"). The returned brief is appended to the
 * `conversationContext` that `buildClarificationPrompt` already reads, so both
 * `/council` and `/ideal` (which reuses this clarifier as its gather engine)
 * inherit evidence-grounded questions from one shared code path.
 *
 * Web-capability policy (owner's Part E rule): PREFER a model with native web
 * research integrated (catalog `nativeWebResearch`), switching the research call
 * to it when one is reachable. Only when no native-web model is reachable fall
 * back to Tavily (via the research method's builtin web tools). When NEITHER a
 * native-web model NOR a Tavily key exists, warn the user before continuing —
 * research proceeds on the codebase + model knowledge only, never silently blind.
 * (Codebase evidence is always gathered by the research tool regardless of the
 * web tier, so an existing repo is still grounded.)
 *
 * Never throws and never blocks the interview: if the flag is off, the llm has
 * no `research` method (most unit-test mocks), the run is aborted, or the call
 * fails, it yields nothing and returns "". Default ON; opt out with
 * MUONROI_CLARIFY_RESEARCH_FIRST=0.
 */
async function hasTavilyKey(): Promise<boolean> {
  try {
    const k = ((await getMcpKey("tavily")) || process.env.TAVILY_API_KEY || "").trim();
    return k.length >= 10;
  } catch {
    return (process.env.TAVILY_API_KEY ?? "").trim().length >= 10;
  }
}

async function* researchScopeForClarification(
  topic: string,
  conversationContext: string,
  leaderModelId: string,
  llm: CouncilLLM,
  signal: AbortSignal | undefined,
  reachableModels: string[],
): AsyncGenerator<StreamChunk, string, unknown> {
  if (process.env.MUONROI_CLARIFY_RESEARCH_FIRST === "0") return "";
  if (signal?.aborted) return "";
  // Skip cleanly when the injected llm can't research (generate-only test mocks)
  // — keeps every existing clarifier test on its current, research-free path.
  if (typeof (llm as { research?: unknown }).research !== "function") return "";

  // Choose the research model + web tier. Prefer a reachable native-web model.
  const reachable = new Set([leaderModelId, ...reachableModels].filter(Boolean));
  const nativeModel = getWebResearchModel(reachable);
  let researchModel = leaderModelId;
  let webTier: "native" | "tavily" | "none";
  if (nativeModel) {
    researchModel = nativeModel.id;
    webTier = "native";
  } else {
    webTier = (await hasTavilyKey()) ? "tavily" : "none";
  }

  const phaseId = "phase:clarification-scope-research";
  const startedAt = Date.now();
  yield phaseStart({ phaseId, kind: "clarification", label: "Scope research" });

  // Owner's Part E principle: never research the web fully blind without telling
  // the user. Codebase + model-knowledge research still runs, but web findings
  // will be absent — surface that so they can wire a native-web model or Tavily.
  if (webTier === "none") {
    yield {
      type: "content",
      content:
        `\n> ⚠ Scope research: no web-research-native model is reachable and no Tavily key is configured. ` +
        `Researching from the codebase + model knowledge only — no live web findings. ` +
        `Configure a native-web model or a Tavily API key for grounded web research.\n`,
    } as StreamChunk;
  }

  try {
    const goal =
      `${topic}\n\n(Research goal: narrow the scope of this request. Report verified findings, and — ` +
      `critically — END with an explicit "## Open Questions / Assumptions" section listing what you could ` +
      `NOT verify and had to ASSUME (the real goal/pain, the concrete task, the system of record, the ` +
      `target user, hard constraints). Those unresolved items are exactly what the user must clarify next, ` +
      `so name them plainly rather than papering over them with a plausible guess.)`;
    const brief = await llm.research(researchModel, goal, conversationContext, signal, undefined, {
      internetFirst: webTier !== "none",
    });
    yield phaseDone({ phaseId, kind: "clarification", label: "Scope research", startedAt });
    return typeof brief === "string" ? brief.trim() : "";
  } catch (err) {
    yield phaseError({
      phaseId,
      kind: "clarification",
      label: "Scope research",
      startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
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
  /**
   * Healthy panel models to fall back to when the leader's cost-tier spec-synth
   * model is on a failing proxy — keeps the spec's ≥3 observable criteria (and
   * thus a meaningful leader eval) instead of degrading to one generic criterion.
   */
  fallbackModels: string[] = [],
): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
  // P5: use MAX_CLARIFY_ROUNDS (12) as the hard cap; respect explicit override
  // from callers that pass maxRounds (e.g. tests that want old 3-round behavior).
  const max = typeof maxRounds === "number" && maxRounds > 0 ? maxRounds : MAX_CLARIFY_ROUNDS;
  const allQA: Array<{ id?: string; question: string; answer: string }> = [];
  // P5: full Q&A history with timestamps for clarifyHistory field
  const clarifyHistory: Array<{ question: string; answer: string; ts: string }> = [];

  const phaseStartedAt = Date.now();
  yield phaseStart({ phaseId: "phase:clarification", kind: "clarification", label: "Clarification" });

  const seeded = (seedQuestions ?? []).map(grayAreaToRoundQuestion);

  // Research-first: ground the interview in evidence BEFORE asking anything, so
  // the question-generator targets the real gray areas the research surfaced
  // rather than guessing. Appended to the context every round's prompt reads.
  const scopeBrief = yield* researchScopeForClarification(
    topic,
    conversationContext,
    leaderModelId,
    llm,
    signal,
    fallbackModels,
  );
  if (scopeBrief) {
    conversationContext = `${conversationContext}${conversationContext ? "\n\n" : ""}## Scope Research\n${scopeBrief}`;
  }

  // P5: track ready-gate state across rounds
  let gateReady = false;
  let gateConfidence = 0;
  let gateGaps: string[] = [];
  // gaps from the previous readiness verdict, passed to the next question-generator
  let pendingGaps: string[] = [];

  for (let round = 0; round < max; round++) {
    // User cancelled during clarification — stop asking further rounds. The
    // generate calls themselves are already abort-aware (wrapped llm); this
    // guard prevents starting a fresh round after a mid-round cancel.
    if (signal?.aborted) break;
    const useSeed = round === 0 && seeded.length > 0;
    const roundId = `phase:clarification-round-${round + 1}`;
    const roundStart = Date.now();
    yield phaseStart({
      phaseId: roundId,
      kind: "clarification_round",
      label: useSeed ? `Clarification round ${round + 1} (PIL-seeded)` : `Clarification round ${round + 1}`,
    });

    let questions: Array<{
      id?: string;
      question: string;
      why: string;
      suggestions?: string[];
      recommended?: string;
      options?: ClarifyOptionSpec[];
      isRequired: boolean;
    }>;

    if (useSeed) {
      questions = (seedQuestions ?? []).map((g) => ({
        id: g.id,
        ...grayAreaToRoundQuestion(g),
      }));
    } else {
      // P5: inject pending gaps from previous readiness verdict into the
      // clarification prompt so the question-generator targets them directly.
      const gapHint =
        pendingGaps.length > 0
          ? `\n\n## Known Gaps (target these with follow-up questions)\n${pendingGaps.map((g) => `- ${g}`).join("\n")}`
          : "";

      const { system, prompt } = buildClarificationPrompt(
        topic,
        conversationContext,
        allQA.length > 0 ? allQA : undefined,
      );

      let questionsRaw: string;
      try {
        const clarifyModel = pickCouncilTaskModel("clarify_questions", leaderModelId, costAware);
        questionsRaw = yield* tracedGenerate(llm, {
          phase: "clarify",
          label: `Generating clarification questions (round ${round + 1})`,
          modelId: clarifyModel,
          system,
          prompt: prompt + gapHint,
          maxTokens: 2048,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield phaseError({
          phaseId: roundId,
          kind: "clarification_round",
          label: `Clarification round ${round + 1}`,
          startedAt: roundStart,
          errorMessage: msg,
        });
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

    // G2-a: enforce the "typically 0-2 questions per round" rule the prompt asks
    // for but the model/seeds repeatedly exceed. Applies to BOTH the LLM path
    // AND the PIL gray-area SEED path — live drive (greenfield "/ideal") showed
    // round-0 seeds (productType/targetPlatform/audience) surfacing uncapped,
    // which a model-path-only cap missed. In an existing repo (a
    // "## Current Project" snapshot is present) generic greenfield questions are
    // also dropped — the documented EE-3589e10d failure. A non-silent content
    // line surfaces whatever was trimmed.
    const existingRepo = conversationContext.includes("## Current Project");
    const capped = capClarifierQuestions(questions, existingRepo);
    questions = capped.kept;
    if (capped.dropped > 0) {
      yield {
        type: "content",
        content: `\n_(clarifier: trimmed ${capped.dropped} question${capped.dropped === 1 ? "" : "s"} — cap ${MAX_CLARIFY_QUESTIONS_PER_ROUND}/round${existingRepo ? " + dropped generic greenfield questions for an existing repo" : ""})_\n`,
      };
    }

    if (questions.length === 0) {
      // The clarifier asking nothing IS the readiness signal — the leader already
      // decided no gaps remain. Mark the spec ready directly rather than leaving the
      // gate at its not-ready default (wrong signal on the cleanest topics) or paying
      // for a redundant readiness-judge LLM call on this break path.
      gateReady = true;
      gateConfidence = 1;
      gateGaps = [];
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
        clarifyHistory.push({ question: q.question, answer, ts: new Date().toISOString() });
        yield {
          type: "content",
          content: `\n**${q.question}**\n  ↳ _${answer}_ (auto-filled from project)\n`,
        };
        continue;
      }

      const questionId = crypto.randomUUID();
      // Prefer the model's richer {label, description, recommended} options so
      // every choice shows its own explanation + the recommended default is
      // pre-selected. Fall back to the legacy string `suggestions` shape (PIL
      // gray-area seeds and any model still emitting the old format).
      const { options, defaultIndex } =
        q.options && q.options.length > 0
          ? buildClarifyOptionsRich(q.options)
          : buildClarifyOptions(q.suggestions, q.recommended);
      // Keep the deprecated `suggestions` mirror populated for consumers that
      // still read it (audit/replay), deriving labels from rich options.
      const suggestionLabels =
        q.suggestions ?? (q.options ? q.options.map((o) => o.label).filter((l) => typeof l === "string") : undefined);

      yield {
        type: "council_question" as StreamChunk["type"],
        content: `**${q.question}**\n${q.why ? `> ${q.why}` : ""}`,
        councilQuestion: {
          questionId,
          phase: "clarify",
          question: q.question,
          context: q.why,
          suggestions: suggestionLabels,
          options,
          isRequired: q.isRequired,
          defaultIndex,
        },
      };

      const answer = await respondToQuestion(questionId);
      allQA.push({ id: q.id, question: q.question, answer });
      clarifyHistory.push({ question: q.question, answer, ts: new Date().toISOString() });
      yield { type: "content", content: `\n  ↳ ${answer}\n` };
    }

    // P5: after each round's Q&A batch, call the ready-gate judge.
    // We build a partial spec from what we have so far to give the judge context.
    const partialSpec: ClarifiedSpec = {
      problemStatement: topic,
      constraints: [],
      successCriteria: [],
      scope: "",
      rawQA: allQA,
    };
    const verdict = await judgeReadiness(partialSpec, topic, allQA, llm, leaderModelId, costAware);
    gateReady = verdict.ready;
    gateConfidence = verdict.confidence;
    gateGaps = verdict.gaps;
    pendingGaps = verdict.gaps; // feed gaps into next round's question prompt

    if (verdict.ready) {
      break;
    }
  }

  yield phaseDone({
    phaseId: "phase:clarification",
    kind: "clarification",
    label: "Clarification",
    startedAt: phaseStartedAt,
    detail: allQA.length > 0 ? `${allQA.length} Q&A` : "no clarification needed",
  });

  const spec = yield* synthesizeSpec(topic, conversationContext, allQA, leaderModelId, llm, costAware, fallbackModels);

  // P5: attach ready-gate metadata to the returned spec
  spec.confidenceScore = gateConfidence;
  spec.remainingGaps = gateGaps;
  spec.ready = gateReady && gateGaps.length === 0;
  spec.clarifyHistory = clarifyHistory;

  yield {
    type: "council_info_card",
    councilInfoCard: {
      title: "Clarified Spec",
      sections: [
        { heading: "Problem", body: spec.problemStatement },
        {
          heading: "Constraints",
          body: spec.constraints.map((c) => `- ${c}`).join("\n") || "- (none)",
        },
        {
          heading: "Success Criteria",
          body: spec.successCriteria.map((c) => `- ${c}`).join("\n"),
        },
        { heading: "Scope", body: spec.scope || "(unspecified)" },
      ],
    },
  };

  return spec;
}

export function buildSpecFromTopic(topic: string, conversationContext: string): ClarifiedSpec {
  return {
    problemStatement: topic,
    constraints: [],
    successCriteria: [`Address the topic: ${topic.slice(0, 100)}`],
    scope: "Determined by conversation context",
    rawQA: [],
    // Carry the session/task context onto the spec so every debate stage (not
    // just the opening) can stay anchored to the parent task. Previously this
    // argument was dropped (prefixed `_`), which is why auto-council debates saw
    // only the isolated sub-task and drifted off-topic.
    parentContext: conversationContext?.trim() || undefined,
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
  fallbackModels: string[] = [],
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
  const prompt = `## Topic\n${topic}\n\n${conversationContext ? `## Context\n${conversationContext}\n` : ""}`;

  try {
    // Model-fallback: the cost-tier synth model can sit on a flaky proxy
    // (Console Go glm/kimi → "Upstream request failed"). Falling back to
    // buildSpecFromTopic yields a single generic criterion, which makes the
    // leader eval read a vague "1/1 criteria met". Retry on healthy panel models
    // first so the spec keeps its ≥3 observable criteria.
    const synthModel = pickCouncilTaskModel("spec_synthesis", leaderModelId, costAware);
    const raw = yield* tracedGenerateWithFallback(llm, {
      phase: "synthesis",
      label: "Inferring spec from topic (no clarification answers)",
      models: [synthModel, ...fallbackModels],
      system,
      prompt,
      maxTokens: 1024,
    });
    const match = raw?.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<ClarifiedSpec>;
      const criteria =
        Array.isArray(parsed.successCriteria) && parsed.successCriteria.length >= 1
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
  fallbackModels: string[] = [],
): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
  if (qa.length === 0) {
    // Clarifier asked 0 questions OR user skipped all of them. Use the LLM to
    // pull implicit criteria/constraints/scope from the topic alone instead of
    // returning the single-criterion fallback that makes leader-eval trivial.
    return yield* inferSpecFromTopicOnly(topic, conversationContext, leaderModelId, llm, costAware, fallbackModels);
  }

  const { system, prompt } = buildSpecSynthesisPrompt(topic, conversationContext, qa);
  const resolved: Record<string, "answered" | "unspecified" | "skipped"> = {};
  for (const item of qa) {
    if (item.id) {
      resolved[item.id] = "answered";
    }
  }

  try {
    // Model-fallback (see inferSpecFromTopicOnly): keep the ≥3-criteria spec even
    // when the leader's cost-tier synth model is on a failing proxy.
    const synthModel = pickCouncilTaskModel("spec_synthesis", leaderModelId, costAware);
    const raw = yield* tracedGenerateWithFallback(llm, {
      phase: "synthesis",
      label: "Synthesizing clarified spec",
      models: [synthModel, ...fallbackModels],
      system,
      prompt,
      maxTokens: 2048,
    });
    const match = raw?.match(/\{[\s\S]*\}/);
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

  return {
    problemStatement: topic,
    constraints: [],
    successCriteria: [`Address: ${topic.slice(0, 100)}`],
    scope: "",
    rawQA: qa,
    resolved,
  };
}
