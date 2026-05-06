import type { ModelRole } from "../utils/settings.js";
import type { ModelMessage } from "ai";
import type { StreamChunk } from "../types/index.js";
import type { ProcessMessageObserver } from "../orchestrator/agent-options.js";

// ── Clarification Phase ─────────────────────────────────────────────────────

export interface CouncilQuestion {
  questionId: string;
  question: string;
  context?: string;
  suggestions?: string[];
  isRequired: boolean;
}

export interface ClarifiedSpec {
  problemStatement: string;
  constraints: string[];
  successCriteria: string[];
  scope: string;
  rawQA: Array<{ question: string; answer: string }>;
}

// ── Preflight ────────────────────────────────────────────────────────────────

export interface CouncilPreflight {
  preflightId: string;
  problemStatement: string;
  constraints: string[];
  successCriteria: string[];
  scope: string;
  participants: Array<{ role: string; model: string }>;
  researchNeeded: boolean;
}

// ── Debate Phase ─────────────────────────────────────────────────────────────

export interface LeaderEvaluation {
  allCriteriaMet: boolean;
  criteriaStatus: Array<{ criterion: string; met: boolean; evidence: string }>;
  unresolvedPoints: string[];
  needsResearch: boolean;
  researchQuery?: string;
  shouldContinue: boolean;
  reason: string;
}

export interface DebateState {
  spec: ClarifiedSpec;
  exchangeLogs: Map<string, string[]>;
  runningSummary: string;
  roundCount: number;
  researchFindings?: string;
}

export interface CouncilParticipant {
  role: ModelRole;
  model: string;
  position: string;
}

// ── Planning Phase ───────────────────────────────────────────────────────────

export interface ActionPlan {
  steps: Array<{
    description: string;
    agent?: string;
    priority: "high" | "medium" | "low";
  }>;
  estimatedComplexity: "trivial" | "moderate" | "complex";
  prerequisites: string[];
}

// ── Council Outcome (extends existing for backward compat) ───────────────────

export interface EnhancedCouncilOutcome {
  type: "decision" | "action_items" | "plan_update" | "resolve_question";
  summary: string;
  agreed: string[];
  tradeoffs: string[];
  recommendation: string;
  actionItems?: string[];
  planUpdate?: string;
  resolvedQuestion?: { question: string; answer: string };
  plan?: ActionPlan;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface CouncilConfig {
  topic: string;
  conversationContext: string;
  leaderModelId: string;
  participants: CouncilParticipant[];
  signal?: AbortSignal;
  observer?: ProcessMessageObserver;
  skipClarification?: boolean;
  userModelMessage?: ModelMessage;
}

// ── Stats ────────────────────────────────────────────────────────────────────

export interface CouncilStats {
  calls: number;
  startMs: number;
  phases: Array<{ name: string; durationMs: number }>;
}

// ── LLM abstraction ──────────────────────────────────────────────────────────

export interface CouncilLLM {
  generate(modelId: string, system: string, prompt: string, maxTokens?: number): Promise<string>;
  research(modelId: string, topic: string, conversationContext: string, signal?: AbortSignal): Promise<string>;
}

export type QuestionResponder = (questionId: string) => Promise<string>;
export type PreflightResponder = (preflightId: string) => Promise<boolean>;
