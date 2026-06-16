import { randomUUID } from "node:crypto";
import { detectNoClarifySignal } from "./clarity-gate.js";
import { getMaxInterviewQuestions, isDiscoveryEnabled } from "./config.js";
import { getCachedProjectContext, setCachedProjectContext } from "./discovery-cache.js";
import type {
  ClarifiedIntent,
  ClarityGap,
  DiscoveryInteractionHandler,
  DiscoveryResult,
  ModelClarificationProposer,
  ProjectContext,
} from "./discovery-types.js";
import { isMetaAnalysisPrompt } from "./layer6-output.js";
import { scanProjectContext } from "./layer15-context-scan.js";
import {
  buildInterviewQuestion,
  getAutofilledOutcome,
  isProvideOwnDetailsSentinel,
  PROVIDE_OWN_DETAILS_OPTION_EN,
  resolveGapsNonInteractive,
} from "./layer16-clarity.js";
import { checkFeasibility } from "./layer17-feasibility.js";
import { buildAcceptanceCard, buildAcceptanceQuestion } from "./layer18-acceptance.js";
import { markDiscoveryAccepted } from "./session-state.js";
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
  // The user explicitly told the agent not to clarify ("don't ask" / "trả lời
  // thẳng"). This is the USER's consent decision, not a classification heuristic,
  // so it stays: skip the entire interview + acceptance ceremony.
  if (detectNoClarifySignal(raw)) return baseResult();

  // ── Model-driven clarification gate (Phase 2) ──────────────────────────────
  // The configured chat model — NOT a regex/keyword heuristic — is the sole
  // decider of whether this turn has a genuine gray area, what to ask, which
  // options to offer, why, and which option is recommended (user directive
  // 2026-06-16: "các askcard bắt buộc xuất phát từ model muốn hỏi"). The CLI only
  // injects the proposer prompt to open the path.
  //
  // There is deliberately NO regex fallback. The old path ran shouldAutoPass() +
  // detectClarityGaps() keyword heuristics and fabricated questions/outcomes from
  // them — the exact "phân loại task qua regex từ khoá ... bad bad bad UX, miss
  // hàng tỷ case" behaviour this phase removes (it also fabricated a build outcome
  // for a yes/no question — live repro f6f7881a5fae). If the model cannot propose
  // questions (no proposer wired, or it throws), we log loudly and proceed WITHOUT
  // an interview; we never invent a question from keywords ("không bao giờ hardcode
  // fallback... có vấn đề = fail = ghi logs"). The agent can still clarify inline.
  if (!clarificationProposer) {
    // Interactive turns always wire a proposer (orchestrator/message-processor).
    // A missing one there is a wiring bug — surface it, never paper over with regex.
    if (handler) {
      console.error(
        "[Agent:discovery] interactive turn has no model clarification proposer — skipping interview (no regex fallback by design)",
      );
    }
    return baseResult();
  }

  // L1.5: Context Discovery (cacheable) — gives the model real project facts so
  // it never asks for something it can inspect itself (language/framework/modules).
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

  // L1.6: Ask the MODEL what (if anything) it still needs. The model owns the
  // gray-area decision, the questions, the options, the "why", and the
  // recommended default. An empty result means it sees nothing worth asking →
  // no interview, no fabricated [Discovery] outcome.
  let gaps: ClarityGap[];
  try {
    gaps = await proposeModelGaps(clarificationProposer, raw, l1, projectContext, recentTurnsSummary);
  } catch (err) {
    // No Silent Catch + fail-loud: log with context, then proceed WITHOUT an
    // interview. We do NOT fall back to regex-generated questions.
    console.error(
      `[Agent:discovery] model clarification proposer threw — proceeding without interview (no regex fallback): ${(err as Error)?.message}`,
      { stack: (err as Error)?.stack?.split("\n").slice(0, 3) },
    );
    return baseResult();
  }

  // Model decided there is no gray area worth asking about → proceed directly.
  if (gaps.length === 0) return baseResult();

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
      // The user asked to change something — let the MODEL re-propose questions
      // given the same context (it owns the gray-area decision, exactly like the
      // initial pass). On a proposer failure we keep the already-resolved intent
      // rather than fabricate regex questions.
      let reGaps: ClarityGap[] = [];
      try {
        reGaps = await proposeModelGaps(clarificationProposer, raw, l1, projectContext, recentTurnsSummary);
      } catch (err) {
        console.error(
          `[Agent:discovery] re-interview proposer threw — keeping prior intent: ${(err as Error)?.message}`,
        );
      }
      if (reGaps.length > 0) {
        const reAnswered: Array<(typeof reGaps)[number] & { answer: string | null }> = reGaps.map((g) => ({
          ...g,
          answer: null,
        }));
        const maxRe = Math.min(reGaps.length, getMaxInterviewQuestions());
        for (let i = 0; i < maxRe; i++) {
          const gap = reAnswered[i]!;
          const q = buildInterviewQuestion(gap, randomUUID());
          const ans = await handler.askQuestion(q);
          reAnswered[i] = { ...gap, answer: ans.text };
        }
        clarifiedIntent = buildClarifiedIntentFromAnswers(reAnswered, raw, projectContext);
        feasibility = await checkFeasibility(clarifiedIntent, projectContext).catch(() => feasibility);
      }
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
 * Build the enrichment context the model sees, call the proposer, and map each
 * returned line into a ClarityGap. This is the SINGLE place discovery turns a
 * model response into askcard gaps — the model owns the question, the options
 * (recommends), the recommended default (first option), and the "why" (threaded
 * into the gap description → askcard context). No regex/keyword gap synthesis.
 *
 * Throws on proposer error so the caller can decide how to degrade (initial pass
 * proceeds without interview; the "adjust" pass keeps the prior intent).
 */
async function proposeModelGaps(
  proposer: ModelClarificationProposer,
  raw: string,
  l1: L1Result,
  projectContext: ProjectContext,
  recentTurnsSummary: string | null,
): Promise<ClarityGap[]> {
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
  const modelQuestions = await proposer({
    raw,
    l1: { taskType: l1.taskType, confidence: l1.confidence },
    additionalContext: additionalContext || undefined,
  });
  return modelQuestions.slice(0, 3).map(parseModelQuestionToGap);
}

/**
 * Parse one proposer line ("question [MODEL RECS: a | b] [WHY: reason]") into a
 * ClarityGap. The recommends become the askcard options (first = recommended
 * default); the WHY clause becomes the askcard context so the user sees the
 * model's own reason for asking.
 */
function parseModelQuestionToGap(line: string, idx: number): ClarityGap {
  let recs = [PROVIDE_OWN_DETAILS_OPTION_EN];
  const recMatch = line.match(/\[MODEL RECS:?\s*(.+?)\]/i) || line.match(/RECS:\s*(.+)$/i);
  if (recMatch) {
    const parsed = recMatch[1]
      .split(/\s*\|\s*/)
      .map((r) => r.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (parsed.length > 0) recs = parsed;
  }
  const whyMatch = line.match(/\[WHY:\s*(.+?)\]/i);
  const why = whyMatch ? whyMatch[1].trim() : "";
  const question = line
    .replace(/\[WHY:.*?\]/i, "")
    .replace(/\[MODEL RECS:?.*?\]/i, "")
    .replace(/RECS:.*$/, "")
    .trim();
  return {
    dimension: "outcome",
    description: why || `Model-generated clarification #${idx + 1}`,
    suggestedQuestion: question || "What else needs clarification?",
    options: [...recs, "Other (type free answer)"],
    defaultIndex: 0,
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
      // Environment/self header — the main system prompt has buildEnvironmentBlock,
      // but THIS discovery question-generator is a separate LLM call that lacked it,
      // so it assumed Python and asked the user to paste the directory tree despite
      // running inside the repo (live grok session). Escape hatch:
      // MUONROI_DISCOVERY_SKIP_ENV_CONTEXT=1.
      const osLabel = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
      const envHeader =
        process.env.MUONROI_DISCOVERY_SKIP_ENV_CONTEXT === "1"
          ? ""
          : `Runtime: ${osLabel} (${process.platform}); \`bash\` is POSIX. The project's language/framework is in the context below — do NOT assume Python or a POSIX-only layout. Do NOT ask the user to paste the directory tree, file list, or project structure: you run INSIDE the repository and can inspect it with your own tools. Ask only about genuine intent / scope ambiguities.\n`;
      const prompt = `You are the AI agent executing inside muonroi-cli.
${envHeader}User request: "${input.raw}"
Task type from CLI: ${input.l1.taskType}
${contextStr}

You decide whether this turn has a genuine gray area that BLOCKS you from delivering correctly. Output the FEW specific, concise questions you (the model) genuinely still need answered — ask only what is truly blocking, not a quota. Most well-scoped requests need 0-1 questions. If everything you need is already inferable from the request + context above, OR the request is a plain question you can simply answer, return an empty array [].
If the User request is a follow-up or continuation of the recent conversation history (if provided above), do NOT ask for new project details; assume the context is already established and return [] unless there is a critical new ambiguity.
Consider the provided language/framework/modules/EE patterns when suggesting questions and recs — never ask something the context above already answers.${special}
For each question: (1) provide 1-2 short concrete recommendations the user can pick from, ALWAYS listing the ONE you would choose FIRST — it becomes the default the user accepts with one keypress; (2) give a short "reason" clause explaining WHY answering it changes what you do. Be decisive; do not hand back an unranked list.
Return ONLY valid JSON array, nothing else:
[{"question":"...","recommends":["rec1","rec2"],"reason":"why this matters"}, ...]
Max 3 items.`;

      const result = await generateText({
        model: runtime.model,
        prompt,
        maxOutputTokens: 320,
      });

      let items: Array<{ question?: string; recommends?: string[]; reason?: string }>;
      try {
        const txt = result.text
          .trim()
          .replace(/```json|```/g, "")
          .trim();
        const parsed = JSON.parse(txt);
        items = Array.isArray(parsed) ? parsed : [];
      } catch (parseErr) {
        // A malformed (non-JSON) model response must NOT be coerced into a junk
        // askcard — log and return no questions (proceed without interview).
        console.error(
          `[Agent:discovery] clarification proposer returned non-JSON — no questions this turn: ${(parseErr as Error)?.message}`,
          { sample: result.text.slice(0, 160) },
        );
        return [];
      }
      return items
        .filter((it) => it && typeof it.question === "string" && it.question.trim())
        .slice(0, 3)
        .map((it) => {
          const recs = (it.recommends || []).slice(0, 2).join(" | ");
          const recTag = recs ? ` [MODEL RECS: ${recs}]` : "";
          const why = (it.reason || "").trim();
          const whyTag = why ? ` [WHY: ${why}]` : "";
          return `${it.question!.trim()}${recTag}${whyTag}`;
        });
    } catch (err) {
      // No Silent Catch + fail-loud: the model call failed. Log with context and
      // return no questions — discovery proceeds WITHOUT an interview rather than
      // fabricating a regex-derived one ("có vấn đề = fail = ghi logs").
      console.error(`[Agent:discovery] clarification proposer failed (${modelId}): ${(err as Error)?.message}`, {
        stack: (err as Error)?.stack?.split("\n").slice(0, 3),
      });
      return [];
    }
  };
}
