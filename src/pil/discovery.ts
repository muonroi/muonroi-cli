import { randomUUID } from "node:crypto";
import { detectNoClarifySignal } from "./clarity-gate.js";
import { getMaxInterviewQuestions, isDiscoveryEnabled } from "./config.js";
import { getCachedProjectContext, setCachedProjectContext } from "./discovery-cache.js";
import type {
  ClarifiedIntent,
  DiscoveryInteractionHandler,
  DiscoveryResult,
  ModelCard,
  ModelClarificationProposer,
  ProjectContext,
} from "./discovery-types.js";
import { isMetaAnalysisPrompt } from "./layer6-output.js";
import { scanProjectContext } from "./layer15-context-scan.js";
import { modelCardToQuestion, resolveGapsNonInteractive } from "./layer16-clarity.js";
import { checkFeasibility } from "./layer17-feasibility.js";
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

  const baseResult = (transcript: Array<{ question: string; answer: string }> = []): DiscoveryResult => ({
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
    interviewTranscript: transcript,
  });

  if (!isDiscoveryEnabled()) return baseResult();
  if (l1.intentKind === "chitchat" || l1.taskType === null) return baseResult();
  if (detectNoClarifySignal(raw)) return baseResult();

  if (!clarificationProposer) {
    if (handler) {
      console.error(
        "[Agent:discovery] interactive turn has no model clarification proposer — skipping interview (no regex fallback by design)",
      );
    }
    return baseResult();
  }

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

  // L1.6: Ask the MODEL to design interview cards.
  // The model returns ModelCard[] — it controls the question, options,
  // option kinds (choice/freetext), and which options cancel/adjust.
  // An empty array means the model sees no gray area → proceed directly.
  let cards: ModelCard[];
  try {
    cards = await proposeModelCards(clarificationProposer, raw, l1, projectContext, recentTurnsSummary);
  } catch (err) {
    console.error(
      `[Agent:discovery] model clarification proposer threw — proceeding without interview (no regex fallback): ${(err as Error)?.message}`,
      { stack: (err as Error)?.stack?.split("\n").slice(0, 3) },
    );
    return baseResult();
  }

  if (cards.length === 0) return baseResult();

  let interviewed = false;
  const interviewTranscript: Array<{ question: string; answer: string }> = [];

  // Interactive interview: show model-designed cards and collect raw answers
  if (handler) {
    interviewed = true;
    const maxQ = Math.min(cards.length, getMaxInterviewQuestions());

    for (let i = 0; i < maxQ; i++) {
      const card = cards[i]!;
      const question = modelCardToQuestion(card, randomUUID());
      const answer = await handler.askQuestion(question);
      interviewTranscript.push({ question: card.question, answer: answer.text });

      // If the user picked a cancel option → stop the whole discovery
      const chosenOption = card.options.find((o) => o.label === answer.text);
      if (chosenOption?.isCancel) {
        const result = baseResult(interviewTranscript);
        result.accepted = false;
        return result;
      }
    }

    // After the first round, if any answer had isAdjust flag → re-interview
    let needsReInterview = false;
    for (let i = 0; i < Math.min(cards.length, getMaxInterviewQuestions()); i++) {
      const card = cards[i]!;
      const chosenOption = card.options.find((o) => o.label === interviewTranscript[i]!.answer);
      if (chosenOption?.isAdjust) {
        needsReInterview = true;
        break;
      }
    }

    if (needsReInterview) {
      let reCards: ModelCard[] = [];
      try {
        reCards = await proposeModelCards(clarificationProposer, raw, l1, projectContext, recentTurnsSummary);
      } catch (err) {
        console.error(
          `[Agent:discovery] re-interview proposer threw — keeping prior answers: ${(err as Error)?.message}`,
        );
      }
      if (reCards.length > 0) {
        const maxRe = Math.min(reCards.length, getMaxInterviewQuestions());
        for (let i = 0; i < maxRe; i++) {
          const card = reCards[i]!;
          const question = modelCardToQuestion(card, randomUUID());
          const answer = await handler.askQuestion(question);
          interviewTranscript.push({ question: card.question, answer: answer.text });

          const chosenOption = card.options.find((o) => o.label === answer.text);
          if (chosenOption?.isCancel) {
            const result = baseResult(interviewTranscript);
            result.accepted = false;
            return result;
          }
        }
      }
    }
  } else {
    // Headless: resolve defaults
    const _resolved = resolveGapsNonInteractive(cards, projectContext, raw);
    interviewTranscript.push(
      ...cards.map((c) => ({
        question: c.question,
        answer: c.options[c.defaultIndex ?? 0]?.label ?? "",
      })),
    );
  }

  // Build a clarified intent summary from the transcript
  const resolvedOutcome =
    interviewTranscript
      .filter((qa) => qa.answer.length > 0)
      .map((qa) => qa.answer)
      .join("; ") || raw;
  const intentStatement = `${l1.taskType}: ${resolvedOutcome.slice(0, 120)}`;

  const clarifiedIntent: ClarifiedIntent = {
    outcome: resolvedOutcome,
    scope:
      projectContext.relevantModules.length > 0 ? projectContext.relevantModules.map((m) => m.path) : ["project root"],
    constraints: [],
    interviewed,
    accepted: true,
  };

  // L1.7: Feasibility Check
  const feasibility = await checkFeasibility(clarifiedIntent, projectContext).catch(() => ({
    viable: true as const,
    warnings: [] as string[],
    adjustedScope: clarifiedIntent.scope,
  }));

  // L1.8: Acceptance — use the model's own cards; no separate acceptance ceremony.
  // Feasibility warnings are added to the result but don't trigger a separate card.
  markDiscoveryAccepted(sessionId);

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
    accepted: true,
    taskType: l1.taskType,
    confidence: l1.confidence,
    domain: l1.domain,
    outputStyle: l1.outputStyle,
    discoveryMs: Date.now() - start,
    interviewTranscript,
  };
}

/**
 * Call the model proposer and parse its ModelCard[] response.
 * The model is the sole designer of all cards — questions, options,
 * option kinds (choice/freetext), cancel/adjust markers, and defaults.
 */
async function proposeModelCards(
  proposer: ModelClarificationProposer,
  raw: string,
  l1: L1Result,
  projectContext: ProjectContext,
  recentTurnsSummary: string | null,
): Promise<ModelCard[]> {
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
  const modelCards = await proposer({
    raw,
    l1: { taskType: l1.taskType, confidence: l1.confidence },
    additionalContext: additionalContext || undefined,
  });
  return modelCards.slice(0, 3);
}

/**
 * Create a ModelClarificationProposer backed by the actual task model.
 * The model receives the user raw + CLI enrichment and outputs the
 * exact ModelCard[] it wants shown — full control over questions, options,
 * option kinds, and cancel/adjust markers.
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
      const osLabel = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
      const envHeader =
        process.env.MUONROI_DISCOVERY_SKIP_ENV_CONTEXT === "1"
          ? ""
          : `Runtime: ${osLabel} (${process.platform}); \`bash\` is POSIX. The project's language/framework is in the context below — do NOT assume Python or a POSIX-only layout. Do NOT ask the user to paste the directory tree, file list, or project structure: you run INSIDE the repository and can inspect it with your own tools. Ask only about genuine intent / scope ambiguities.\n`;
      const prompt = `You are the AI agent executing inside muonroi-cli.
${envHeader}User request: "${input.raw}"
Task type from CLI: ${input.l1.taskType}
${contextStr}

You design question cards shown to the user *before* you start working.
Each card is a structured question with selectable options.

Rules:
1. Ask ONLY what is genuinely blocking. Most well-scoped requests need 0 cards.
2. If everything you need is inferable from the request + context above, OR the request is a plain question you can simply answer, return [] (empty array).
3. If this is a follow-up or continuation of recent conversation history, assume context is already established and return [] unless there is a critical new ambiguity.
4. Consider the provided language/framework/modules/EE patterns — never ask what the context already answers.${special}
5. For each card, design the options however you want:
   - Use kind="choice" for clickable buttons (recommendations, accept/adjust/cancel, etc.)
   - Use kind="freetext" when the user should type their own answer
   - Mark an option with isCancel:true when picking it should cancel the entire request
   - Mark an option with isAdjust:true when picking it means the user wants to clarify further
   - Set defaultIndex to the option most users would pick (0 = first)
6. Return ONLY valid JSON array, nothing else.
7. Max 3 cards.

JSON format:
[{
  "question": "string — the question text",
  "context": "string — optional explanation shown below the question",
  "options": [
    {"label": "string", "description": "string", "kind": "choice", "isCancel": false, "isAdjust": false},
    {"label": "string", "kind": "freetext"}
  ],
  "defaultIndex": 0
}]`;

      const result = await generateText({
        model: runtime.model,
        prompt,
        maxOutputTokens: 600,
      });

      let items: ModelCard[];
      try {
        const txt = result.text
          .trim()
          .replace(/```json|```/g, "")
          .trim();
        const parsed = JSON.parse(txt);
        items = Array.isArray(parsed) ? parsed : [];
      } catch (parseErr) {
        console.error(
          `[Agent:discovery] clarification proposer returned non-JSON — no cards this turn: ${(parseErr as Error)?.message}`,
          { sample: result.text.slice(0, 160) },
        );
        return [];
      }

      return items
        .filter((it: any) => it && typeof it.question === "string" && it.question.trim())
        .slice(0, 3) as ModelCard[];
    } catch (err) {
      console.error(`[Agent:discovery] clarification proposer failed (${modelId}): ${(err as Error)?.message}`, {
        stack: (err as Error)?.stack?.split("\n").slice(0, 3),
      });
      return [];
    }
  };
}
