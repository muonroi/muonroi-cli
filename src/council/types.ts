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
  /** Maps dimension IDs to their resolution status. Used by Product Loop. */
  resolved?: Record<string, "answered" | "unspecified" | "skipped">;
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
  active: CouncilParticipant[];  // mutated positions from debate rounds — NEW (Phase 14 CQ-02)
}

/**
 * A debate stance is the lens a participant adopts for a SPECIFIC topic.
 * Decoupled from {@link ModelRole} (which only picks a model slot from config).
 * Leader LLM proposes stances per topic at planning time.
 */
export interface DebateStance {
  /** Short label, e.g. "Comparative Analyst", "Cost Skeptic". */
  name: string;
  /** One-sentence lens, e.g. "How does the subject compare to alternatives?" */
  lens: string;
  /** Optional concrete focus, e.g. "Cite numbers with sources only". */
  focus?: string;
}

export interface CouncilParticipant {
  role: ModelRole;
  model: string;
  position: string;
  /** Set after debate planning — leader-proposed stance for this topic. */
  stance?: DebateStance;
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

/**
 * Output shape proposed by the leader LLM per topic.
 * Drives both the synthesis JSON schema and the human-readable Markdown sections.
 */
export interface OutputSection {
  /** JSON key in the final outcome, e.g. "strengths", "actionItems". */
  key: string;
  /** Markdown heading rendered to the user, e.g. "Strengths". */
  heading: string;
  /** Hint to the synthesizer LLM about what belongs in this section. */
  prompt: string;
  /** "list" → array of strings; "text" → free-form string; "objectList" → array of objects. */
  shape: "list" | "text" | "objectList";
}

export interface OutputShape {
  /** Free-form label (e.g. "evaluation", "implementation_plan", "decision"). */
  kind: string;
  sections: OutputSection[];
  /** Behavioural rules the synthesizer must obey. */
  guardrails: string[];
}

export interface DebatePlan {
  /** Leader's one-sentence read of what the user actually asked for. */
  intentSummary: string;
  /** Leader-proposed stances. Length usually 2-4. */
  stances: DebateStance[];
  /** Leader-proposed output schema for the synthesis step. */
  outputShape: OutputShape;
}

export interface EnhancedCouncilOutcome {
  /** Free-form (drives by leader plan). Common: decision, action_items, plan_update, evaluation, resolve_question. */
  type: string;
  summary: string;
  /** Dynamic sections — keys mirror {@link OutputShape.sections}. */
  sections?: Record<string, unknown>;
  // Back-compat fields. Synthesizer fills whichever match the shape.
  agreed?: string[];
  tradeoffs?: string[];
  recommendation?: string;
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
  /** Leader-proposed plan; if absent, debate falls back to role-only prompts. */
  debatePlan?: DebatePlan;
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
