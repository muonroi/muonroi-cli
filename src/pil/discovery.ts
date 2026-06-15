import { randomUUID } from "node:crypto";
import { type L1Signal, shouldAutoPass } from "./clarity-gate.js";
import { getMaxInterviewQuestions, isDiscoveryEnabled } from "./config.js";
import { getCachedProjectContext, setCachedProjectContext } from "./discovery-cache.js";
import type {
  ClarifiedIntent,
  DiscoveryInteractionHandler,
  DiscoveryResult,
  ModelClarificationProposer,
  ProjectContext,
} from "./discovery-types.js";
import { isMetaAnalysisPrompt } from "./layer6-output.js";
import { scanProjectContext } from "./layer15-context-scan.js";
import {
  buildInterviewQuestion,
  detectClarityGaps,
  getAutofilledOutcome,
  isProvideOwnDetailsSentinel,
  PROVIDE_OWN_DETAILS_OPTION_EN,
  PROVIDE_OWN_DETAILS_OPTION_VI,
  resolveGapsNonInteractive,
} from "./layer16-clarity.js";
import { checkFeasibility } from "./layer17-feasibility.js";
import { buildAcceptanceCard, buildAcceptanceQuestion } from "./layer18-acceptance.js";
import { getSessionState, isLikelyFollowUp, markDiscoveryAccepted } from "./session-state.js";
import type { OutputStyle, TaskType } from "./types.js";

export interface L1Result {
  taskType: TaskType | null;
  confidence: number;
  complexity: "low" | "medium" | "high";
  domain: string | null;
  outputStyle: OutputStyle | null;
  intentKind: "task" | "chitchat" | null;
}

function emptyProjectContext(cwd: string): ProjectContext {
  return {
    language: null,
    framework: null,
    packageManager: null,
    domain: null,
    boundedContexts: [],
    eePatterns: [],
    relevantModules: [],
    scannedAt: Date.now(),
    cwd,
  };
}

export async function runDiscovery(
  raw: string,
  l1: L1Result,
  cwd: string,
  handler: DiscoveryInteractionHandler | null,
  sessionId: string | null = null,
  clarificationProposer: ModelClarificationProposer | null = null,
  recentTurnsSummary: string | null = null,
): Promise<DiscoveryResult> {
  const start = Date.now();

  const baseResult = (): DiscoveryResult => ({
    raw,
    projectContext: emptyProjectContext(cwd),
    clarifiedIntent: { outcome: raw, scope: [], constraints: [], gaps: [] },
    feasibility: { viable: true, warnings: [], adjustedScope: [] },
    interviewed: false,
    intentStatement: raw,
    outcome: raw,
    scope: [],
    feasibilityWarnings: [],
    accepted: true,
    taskType: l1.taskType,
    confidence: l1.confidence,
    domain: l1.domain,
    outputStyle: l1.outputStyle,
    discoveryMs: Date.now() - start,
  });

  if (!isDiscoveryEnabled()) return baseResult();
  if (l1.intentKind === "chitchat" || l1.taskType === null) return baseResult();

  // Session-continuation guard: when the user is on turn >= 2 of an ongoing
  // session AND the new prompt looks like a continuation (short, modal verb
  // or context pronoun), skip the interview entirely. The prior turn already
  // established context; asking "Which part of the codebase?" on "Can you
  // fix it?" forces the user to re-type their intent as a freetext answer,
  // which PIL then mis-routes through gap-resolution + acceptance, producing
  // duplicate askcards (evidence: session 1f29e238a816 timeline).
  const sessionState = getSessionState(sessionId);
  if (sessionState && sessionState.turnCount > 1 && isLikelyFollowUp(raw)) {
    return baseResult();
  }

  const l1Signal: L1Signal = { confidence: l1.confidence, taskType: l1.taskType, complexity: l1.complexity };

  if (shouldAutoPass(l1Signal, raw)) return baseResult();

  // L1.5: Context Discovery (cacheable)
  let projectContext: ProjectContext;
  const cached = getCachedProjectContext(cwd);
  if (cached) {
    projectContext = cached;
  } else {
    try {
      projectContext = await Promise.race([
        scanProjectContext(raw, cwd),
        new Promise<ProjectContext>((resolve) => setTimeout(() => resolve(emptyProjectContext(cwd)), 500)),
      ]);
      setCachedProjectContext(projectContext);
    } catch {
      projectContext = emptyProjectContext(cwd);
    }
  }

  // L1.6: Clarity Interview
  let gaps = detectClarityGaps(raw, l1.taskType, l1.confidence, projectContext);

  // Effective model-driven interview: if a clarificationProposer (the actual task model) is provided,
  // let the *model* itself generate the questions based on the user request + CLI enrichment so far.
  // The model decides what it still needs and is missing from the enrich suggestions.
  // Always generate model gaps when proposer wired (even if no handler for non-interactive resolve).
  // This ensures model BE recs drive [Discovery] Intent/Outcome/Scope for native meta prompts.
  // Handler only decides whether to show interactive askcard.
  if (clarificationProposer) {
    try {
      const additionalContext = [
        projectContext.language ? `Language: ${projectContext.language}` : "",
        projectContext.framework ? `Framework: ${projectContext.framework}` : "",
        projectContext.packageManager ? `Package manager: ${projectContext.packageManager}` : "",
        projectContext.relevantModules?.length
          ? `Relevant modules: ${projectContext.relevantModules.map((m) => m.path).join(", ")}`
          : "",
        projectContext.boundedContexts?.length
          ? `Bounded contexts: ${projectContext.boundedContexts.map((b) => `${b.name} (${b.path})`).join(", ")}`
          : "",
        projectContext.eePatterns?.length ? `EE patterns: ${projectContext.eePatterns.slice(0, 3).join(" | ")}` : "",
        recentTurnsSummary ? `\nRecent Conversation History:\n${recentTurnsSummary}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const modelQuestions = await clarificationProposer({
        raw,
        l1: { taskType: l1.taskType, confidence: l1.confidence },
        additionalContext: additionalContext || undefined,
      });
      if (modelQuestions.length > 0) {
        gaps = modelQuestions.slice(0, 3).map((line, idx) => {
          let q = line;
          let recs = [PROVIDE_OWN_DETAILS_OPTION_EN];
          const m = line.match(/\[MODEL RECS:?\s*(.+?)\]/i) || line.match(/RECS:\s*(.+)$/i);
          if (m) {
            recs = m[1]
              .split(/\s*\|\s*/)
              .map((r) => r.trim())
              .filter(Boolean)
              .slice(0, 3);
            q = line
              .replace(/\[MODEL RECS:?.*?\]/i, "")
              .replace(/RECS:.*$/, "")
              .trim();
          }
          return {
            dimension: "outcome" as const,
            description: `Model-generated clarification #${idx + 1}`,
            suggestedQuestion: q || "What else needs clarification?",
            options: [...recs, "Other (type free answer)"],
            defaultIndex: 0,
          };
        });
      }
    } catch {
      // fall through to static
    }
  }

  if (!clarificationProposer && (l1.taskType === "analyze" || l1.taskType === "debug") && gaps.length > 0) {
    // Fallback open question (non-model path)
    gaps = [
      {
        dimension: "outcome",
        description: "Specific outcome and constraints the agent/model needs from the user",
        suggestedQuestion: `Để tôi (agent/model) thực hiện chính xác và có được thông tin cần thiết cho task này, bạn hãy cho tôi biết: kết quả mong muốn cụ thể, các ràng buộc quan trọng, hoặc bất kỳ chi tiết nào khác mà tôi cần làm rõ trước khi bắt đầu?`,
        options: [PROVIDE_OWN_DETAILS_OPTION_VI],
        defaultIndex: 0,
      },
    ];
  }

  let clarifiedIntent: ClarifiedIntent;
  let interviewed = false;

  if (gaps.length > 0 && handler) {
    interviewed = true;
    const answeredGaps: Array<(typeof gaps)[number] & { answer: string | null }> = gaps.map((g) => ({
      ...g,
      answer: null,
    }));
    const maxQ = Math.min(gaps.length, getMaxInterviewQuestions());

    for (let i = 0; i < maxQ; i++) {
      const gap = answeredGaps[i]!;
      const question = buildInterviewQuestion(gap, randomUUID());
      const answer = await handler.askQuestion(question);
      answeredGaps[i] = { ...gap, answer: answer.text };
    }

    clarifiedIntent = buildClarifiedIntentFromAnswers(answeredGaps, raw, projectContext);
  } else {
    clarifiedIntent = resolveGapsNonInteractive(gaps, projectContext, raw);
  }

  // Auto-fill outcome for analyze/plan/documentation when no outcome gap was asked.
  // Override only when the resolved outcome is a raw-derived generic ("Complete: …" /
  // "Complete the task …") or a genuine filesystem-path leak (Local path, project root,
  // "src/foo.ts" scope-option shapes). It must NOT clobber a legitimate user answer that
  // merely contains a slash ("support REST/GraphQL", "input/output") — see looksLikePathLeak.
  const autoOutcome = getAutofilledOutcome(l1.taskType, raw);
  const currentOutcome = clarifiedIntent.outcome ?? "";
  const isGenericComplete = /^Complete(?::| the task)/i.test(currentOutcome);
  if (autoOutcome && (!currentOutcome || isGenericComplete || looksLikePathLeak(currentOutcome))) {
    clarifiedIntent = { ...clarifiedIntent, outcome: autoOutcome };
  }

  // L1.7: Feasibility Check
  let feasibility = await checkFeasibility(clarifiedIntent, projectContext).catch(() => ({
    viable: true as const,
    warnings: [] as string[],
    adjustedScope: clarifiedIntent.scope,
  }));

  // L1.8: User Acceptance
  const intentStatement = `${l1.taskType ?? "task"}: ${clarifiedIntent.outcome}`;
  let accepted = true;

  if (handler && interviewed) {
    const card = buildAcceptanceCard(intentStatement, clarifiedIntent, feasibility, raw);
    const question = buildAcceptanceQuestion(card, randomUUID());
    const answer = await handler.askQuestion(question);
    const decision = answer.text.toLowerCase();

    if (decision === "cancel") {
      accepted = false;
    } else if (decision === "adjust") {
      // Re-run interview once — but ONLY for gaps where the user's prior
      // freetext answer was empty, identical to the raw prompt itself, or
      // a continuation phrase. Re-asking gaps the user already answered
      // (with non-trivial text) just produces duplicate askcards (evidence:
      // session 1f29e238a816 — user picked "adjust", re-interview fired the
      // same "Which part of codebase?" question they had just answered).
      const reGaps = detectClarityGaps(raw, l1.taskType, l1.confidence, projectContext);
      const priorAnswers = new Map<string, string | null>(
        (clarifiedIntent.gaps ?? []).map((g) => [g.dimension, g.answer ?? null]),
      );
      const reAnswered: Array<(typeof reGaps)[number] & { answer: string | null }> = reGaps.map((g) => ({
        ...g,
        answer: priorAnswers.get(g.dimension) ?? null,
      }));
      const maxRe = Math.min(reGaps.length, getMaxInterviewQuestions());
      for (let i = 0; i < maxRe; i++) {
        const gap = reAnswered[i]!;
        const prior = gap.answer?.trim() ?? "";
        const isTrivialPriorAnswer =
          prior === "" || prior.toLowerCase() === raw.trim().toLowerCase() || isLikelyFollowUp(prior);
        if (!isTrivialPriorAnswer) {
          // User already gave a substantive answer for this gap. Keep it.
          continue;
        }
        const q = buildInterviewQuestion(gap, randomUUID());
        const ans = await handler.askQuestion(q);
        reAnswered[i] = { ...gap, answer: ans.text };
      }
      clarifiedIntent = buildClarifiedIntentFromAnswers(reAnswered, raw, projectContext);
      feasibility = await checkFeasibility(clarifiedIntent, projectContext).catch(() => feasibility);
      accepted = true;
    }
  }

  if (accepted) {
    markDiscoveryAccepted(sessionId);
  }

  return {
    raw,
    projectContext,
    clarifiedIntent,
    feasibility,
    interviewed,
    intentStatement,
    outcome: clarifiedIntent.outcome,
    scope:
      (feasibility.adjustedScope ?? []).length > 0
        ? (feasibility.adjustedScope ?? [])
        : (clarifiedIntent.scope ?? ["project root"]),
    feasibilityWarnings: feasibility.warnings ?? [],
    accepted,
    taskType: l1.taskType,
    confidence: l1.confidence,
    domain: l1.domain,
    outputStyle: l1.outputStyle,
    discoveryMs: Date.now() - start,
  };
}

/**
 * True only for outcomes that are genuine filesystem-path leakage — known
 * leaked-scope phrases ("Local path", "project root", …) or a real path segment
 * ("src/foo.ts", a "src/cli (cli)" scope-option shape) that also carries a
 * path-ish signal (file extension, path keyword, or trailing "(name)").
 *
 * A bare "/" is NOT sufficient: "support REST/GraphQL", "validate input/output",
 * and "details / constraints" use the slash as an "or" separator and must be
 * preserved. The previous implementation matched any "/" and silently clobbered
 * such legitimate answers with the generic taskType default.
 */
function looksLikePathLeak(outcome: string): boolean {
  // Anchored known leaked-scope phrases (preserves prior override behaviour).
  if (/(?:\b(?:local path|in prompts|directory as|project root|absolute)\b)|local\/repo/i.test(outcome)) {
    return true;
  }
  // word/word path segment (no spaces around the slash) — e.g. "src/foo.ts".
  if (!/\b[\w.-]+\/[\w./-]+/.test(outcome)) return false;
  const hasFileExtension = /\/[\w-]+\.[a-z0-9]{1,5}\b/i.test(outcome); // ".../foo.ts"
  const hasPathKeyword = /\b(?:path|dir|directory|folder|repo|root|module|src|lib|dist|tests?)\b/i.test(outcome);
  const hasScopeOptionSuffix = /\([^)]+\)\s*$/.test(outcome); // "src/cli (cli)" scope-option shape
  return hasFileExtension || hasPathKeyword || hasScopeOptionSuffix;
}

function buildClarifiedIntentFromAnswers(
  answeredGaps: Array<{ dimension: string; answer: string | null; options: string[]; defaultIndex: number }>,
  raw: string,
  projectContext: ProjectContext,
): ClarifiedIntent {
  const outcomeGap = answeredGaps.find((g) => g.dimension === "outcome");
  const scopeGap = answeredGaps.find((g) => g.dimension === "scope");
  const constraintGap = answeredGaps.find((g) => g.dimension === "constraint");

  // The "provide my own details" meta-option is a no-answer sentinel; treat it
  // as missing so the raw-derived generic (and downstream inferred outcome) is
  // used instead of the sentinel string surviving verbatim as the outcome.
  const outcomeAnswer = isProvideOwnDetailsSentinel(outcomeGap?.answer) ? null : (outcomeGap?.answer ?? null);
  const outcome = outcomeAnswer ?? `Complete: ${raw.slice(0, 80)}`;
  const scope = (() => {
    if (scopeGap?.answer) return [scopeGap.answer.replace(/\s*\(.*\)\s*$/, "").trim()];
    return projectContext.relevantModules.map((m) => m.path);
  })();
  const constraints = constraintGap?.answer ? [constraintGap.answer] : [];

  return {
    intentStatement: outcome,
    outcome,
    scope: scope.length > 0 ? scope : ["project root"],
    feasibilityWarnings: [],
    interviewed: false,
    accepted: false,
    constraints,
    gaps: answeredGaps.map((g) => ({
      dimension: g.dimension as "outcome" | "scope" | "constraint",
      description: "",
      suggestedQuestion: "",
      options: g.options,
      defaultIndex: g.defaultIndex,
      answer: g.answer,
    })),
  };
}

/**
 * Create a ModelClarificationProposer backed by the actual task model.
 * The model receives the user raw + CLI enrichment (l1, project modules, etc.)
 * and outputs the specific questions *it* needs the user to answer.
 * This is the effective way to let the model interview based on what is still missing.
 */
export function createModelClarificationProposer(providerFactory: any, modelId: string): ModelClarificationProposer {
  return async (input) => {
    try {
      const { resolveModelRuntime } = await import("../providers/runtime.js");
      const { generateText } = await import("ai");
      const runtime = resolveModelRuntime(providerFactory, modelId);
      const contextStr = input.additionalContext
        ? `\nCurrent CLI enrichment / context (use this to decide what is already known):\n${input.additionalContext}`
        : "";
      const special = isMetaAnalysisPrompt(input.raw)
        ? `\nIf the request is a self-evaluation, meta-analysis or review of the CLI by the agent running inside it, do NOT ask about repo path, current directory, absolute path, local repo location or "which directory". Scope is always the full project root. Focus questions and recommends on which CLI internals (PIL, discovery, tools, compaction, EE, model BE, loop guard) to evaluate or specific improvements to assess after fixes. Use the enrichment context.`
        : "";
      const prompt = `You are the AI agent executing inside muonroi-cli.
User request: "${input.raw}"
Task type from CLI: ${input.l1.taskType}
${contextStr}

Based on the above, output 1-3 specific, concise questions you (the model) still need the user to answer right now so you have all the information required to complete the task accurately, without guessing.
If the User request is a follow-up or continuation of the recent conversation history (if provided above), do NOT ask for new project details; assume the context is already established and return an empty array [] unless there is a critical new ambiguity.
Consider the provided language/framework/modules/EE patterns when suggesting questions and recs — only ask what is missing from this context.${special}
For each question also provide 1-2 short concrete recommendations the user can pick from (model-backed choices).
Return ONLY valid JSON array, nothing else:
[{"question":"...","recommends":["rec1","rec2"]}, ...]
Max 3 items.`;

      const result = await generateText({
        model: runtime.model,
        prompt,
        maxOutputTokens: 256,
      });

      let items: Array<{ question: string; recommends?: string[] }> = [];
      try {
        const txt = result.text
          .trim()
          .replace(/```json|```/g, "")
          .trim();
        items = JSON.parse(txt);
      } catch {
        // degrade: treat whole text as one question with no recs
        items = [{ question: result.text.trim(), recommends: [] }];
      }
      return items.slice(0, 3).map((it) => {
        const recs = (it.recommends || []).slice(0, 2).join(" | ");
        const tag = recs ? ` [MODEL RECS: ${recs}]` : "";
        return `${it.question || "Clarify needed details"}${tag}`;
      });
    } catch (err) {
      // Silent degrade: no model questions, fall back to static
      return [];
    }
  };
}
