import { randomUUID } from "node:crypto";
import { type L1Signal, shouldAutoPass } from "./clarity-gate.js";
import { getMaxInterviewQuestions, isDiscoveryEnabled } from "./config.js";
import { getCachedProjectContext, setCachedProjectContext } from "./discovery-cache.js";
import type {
  ClarifiedIntent,
  DiscoveryInteractionHandler,
  DiscoveryResult,
  ProjectContext,
} from "./discovery-types.js";
import { scanProjectContext } from "./layer15-context-scan.js";
import {
  buildInterviewQuestion,
  detectClarityGaps,
  getAutofilledOutcome,
  resolveGapsNonInteractive,
} from "./layer16-clarity.js";
import { checkFeasibility } from "./layer17-feasibility.js";
import { buildAcceptanceCard, buildAcceptanceQuestion } from "./layer18-acceptance.js";
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
  const gaps = detectClarityGaps(raw, l1.taskType, l1.confidence, projectContext);
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

  // Auto-fill outcome for analyze/plan/documentation when no outcome gap was asked
  const autoOutcome = getAutofilledOutcome(l1.taskType);
  if (autoOutcome && (!clarifiedIntent.outcome || clarifiedIntent.outcome.startsWith("Complete the task"))) {
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
    const card = buildAcceptanceCard(intentStatement, clarifiedIntent, feasibility);
    const question = buildAcceptanceQuestion(card, randomUUID());
    const answer = await handler.askQuestion(question);
    const decision = answer.text.toLowerCase();

    if (decision === "cancel") {
      accepted = false;
    } else if (decision === "adjust") {
      // Re-run interview once
      const reGaps = detectClarityGaps(raw, l1.taskType, l1.confidence, projectContext);
      const reAnswered: Array<(typeof reGaps)[number] & { answer: string | null }> = reGaps.map((g) => ({
        ...g,
        answer: null,
      }));
      for (let i = 0; i < Math.min(reGaps.length, getMaxInterviewQuestions()); i++) {
        const q = buildInterviewQuestion(reGaps[i]!, randomUUID());
        const ans = await handler.askQuestion(q);
        reAnswered[i] = { ...reGaps[i]!, answer: ans.text };
      }
      clarifiedIntent = buildClarifiedIntentFromAnswers(reAnswered, raw, projectContext);
      feasibility = await checkFeasibility(clarifiedIntent, projectContext).catch(() => feasibility);
      accepted = true;
    }
  }

  return {
    raw,
    projectContext,
    clarifiedIntent,
    feasibility,
    interviewed,
    intentStatement,
    outcome: clarifiedIntent.outcome,
    scope: feasibility.adjustedScope.length > 0 ? feasibility.adjustedScope : clarifiedIntent.scope,
    feasibilityWarnings: feasibility.warnings,
    accepted,
    taskType: l1.taskType,
    confidence: l1.confidence,
    domain: l1.domain,
    outputStyle: l1.outputStyle,
    discoveryMs: Date.now() - start,
  };
}

function buildClarifiedIntentFromAnswers(
  answeredGaps: Array<{ dimension: string; answer: string | null; options: string[]; defaultIndex: number }>,
  raw: string,
  projectContext: ProjectContext,
): ClarifiedIntent {
  const outcomeGap = answeredGaps.find((g) => g.dimension === "outcome");
  const scopeGap = answeredGaps.find((g) => g.dimension === "scope");
  const constraintGap = answeredGaps.find((g) => g.dimension === "constraint");

  const outcome = outcomeGap?.answer ?? `Complete: ${raw.slice(0, 80)}`;
  const scope = (() => {
    if (scopeGap?.answer) return [scopeGap.answer.replace(/\s*\(.*\)\s*$/, "").trim()];
    return projectContext.relevantModules.map((m) => m.path);
  })();
  const constraints = constraintGap?.answer ? [constraintGap.answer] : [];

  return {
    outcome,
    scope: scope.length > 0 ? scope : ["project root"],
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
