import type { ModelMessage } from "ai";
import type { ProcessMessageObserver } from "../orchestrator/agent-options.js";
import type { TaskRequest, ToolResult } from "../types/index.js";
import type { ModelRole } from "../utils/settings.js";

/**
 * Bridge to the orchestrator's isolated sub-agent runner (runTaskRequest). When
 * wired into a council run, heavy phases (research; #3 grounding-verify) execute
 * in a budget-capped, near-empty explore sub-agent instead of an in-process
 * multi-step generateText that bloats the council thread/context. The bridge
 * closure captures the council abort signal, so callers pass only the request.
 */
export type IsolatedTaskRunner = (request: TaskRequest) => Promise<ToolResult>;

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
  // ── P5: Ready-gate additions (all optional — backward compat) ────────────
  /** Self-judged confidence score (0–1) that the spec is ready for debate. */
  confidenceScore?: number;
  /** Outstanding gaps the agent identified; empty when ready === true. */
  remainingGaps?: string[];
  /**
   * True when the ready-gate judge decided the spec is sufficient.
   * Invariant: ready === (remainingGaps?.length ?? 1) === 0
   */
  ready?: boolean;
  /** Full Q&A history including gap-driven follow-up rounds. */
  clarifyHistory?: Array<{
    question: string;
    answer: string;
    /** ISO timestamp of when the answer was recorded. */
    ts: string;
  }>;
  /** Populated by P6 when the spec is converted to a Backlog. */
  backlogId?: string;
  /**
   * Ongoing-task / conversation context captured at council entry. Attached in
   * council/index.ts on BOTH the explicit `/council` path and auto-council, so
   * every debate stage (not just the opening statement) stays anchored to the
   * parent task and the decisions already made earlier in the session. Optional
   * for backward compat — empty when the council runs with no prior context.
   */
  parentContext?: string;
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
  /** Citations / total verifiable claims ratio (0.0–1.0). Computed by evaluateDebate after each round. */
  evidenceDensity?: number;
  /** Count of [REFUTED] tags + explicit concessions found in the exchange text. */
  disagreementResolved?: number;
  /**
   * Leader-requested round extension. When set and `shouldContinue=true`, the
   * debate loop bumps its max-rounds budget by this amount, capped at the
   * absolute hard ceiling. Use sparingly — only when the debate is genuinely
   * close to resolving the last unresolved point.
   */
  extendRounds?: number;
  /**
   * One-line focus/topic the leader sets for the NEXT round when the debate
   * continues. Surfaced in the round-grouped transcript overview (P6). Optional
   * — absent on convergence/stop.
   */
  nextRoundFocus?: string;
}

export interface DebateState {
  spec: ClarifiedSpec;
  exchangeLogs: Map<string, string[]>;
  runningSummary: string;
  roundCount: number;
  researchFindings?: string;
  active: CouncilParticipant[]; // mutated positions from debate rounds — NEW (Phase 14 CQ-02)
  /** Evidence density from the final leader evaluation (0.0–1.0). Drives confidence badge. */
  finalEvidenceDensity?: number;
  /**
   * Total claims participants explicitly tagged ([CONFIRMED]/[REFUTED]/
   * [UNVERIFIED]) across the debate. 0 = no evidence tags emitted, so density
   * is unmeasurable rather than genuinely 0% — the badge distinguishes them.
   */
  finalTaggedClaims?: number;
  /** Role-indexed per-round positions for follow-up citations. */
  archive?: DebateArchiveEntry[];
  /**
   * F1 — the last successful round's per-criterion met flags, index-aligned to
   * `spec.successCriteria`. Lets the post-debate card tell whether the debate
   * actually satisfied the pinned success criteria (distinct from evidence
   * density) so an unmet outcome is framed as provisional, not a settled
   * decision. Undefined when the spec had no pinned criteria or no round eval
   * ever produced a criteria status (treated as all-unmet by the card).
   */
  finalCriteriaMet?: boolean[];
  /**
   * B4 interactive escalation outcome. Set only when the user was prompted at a
   * stop-with-unmet boundary and chose an action: `extend` granted extra rounds
   * past the ceiling, `accept` proceeded with criteria open, `rescope` asked to
   * narrow the scope. Undefined when no escalation fired (auto-resolved, headless,
   * or all criteria met). Lets synthesis/caller react to a user-driven partial stop.
   */
  escalation?: { action: "extend" | "accept" | "rescope"; grantedRounds?: number };
}

/**
 * Single position taken by a participant in one round. Used to answer
 * "who said what" follow-ups after the debate ends.
 *
 * NOTE: stores an `excerpt` (head-truncated) instead of the full position
 * text. The full content lives in `[Debate Transcript]`; the archive is a
 * citation index only. Persisting full text here used to grow the
 * `[Council Memory]` record to 70KB+ per session.
 */
export interface DebateArchiveEntry {
  round: number;
  role: ModelRole;
  model: string;
  stanceName?: string;
  /** Head excerpt (~400 chars) for citation in follow-ups. */
  excerpt: string;
  /** Original full length so the digest can hint at how much was trimmed. */
  length: number;
  toolsUsed?: string[];
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
  /**
   * Leader-proposed initial round budget (1–5). Defaults to 3 when the
   * planner omits it. The debate loop may extend up to a hard ceiling when
   * the leader evaluation requests `extendRounds`.
   */
  plannedRounds?: number;
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
  /**
   * Model-first post-debate options. The leader synthesis picks 2-4 actions
   * from the wired handler vocabulary that FIT this debate's intent (a bug
   * investigation vs an evaluation vs a plan warrant different follow-ups),
   * ordered best-first. Rendered as the post-debate askcard instead of the
   * old fixed "accept / research / apply" template. Empty/absent → index.ts
   * falls back to the deterministic option set.
   */
  nextActions?: Array<{ action: PostDebateActionId; label: string; reason?: string }>;
}

/**
 * Post-debate actions the leader may recommend. Bounded to handlers wired in
 * index.ts's post-debate switch — the model selects/orders/labels FROM this
 * vocabulary, it cannot invent new actions. Context-only actions
 * (retry_synthesis on failure, refine on empty sections) are added by index.ts,
 * not the model.
 */
export type PostDebateActionId =
  | "ask_followup"
  | "generate_plan"
  | "implement"
  | "save_exit"
  /**
   * Persist the outcome and hand control back to the session with the synthesis
   * enriched into the message history (appendCompletedTurn), so the agent keeps
   * working on the ORIGINAL task using the debate's trusted conclusion as
   * context. The right default for a pure discussion / hard-problem debate whose
   * deliverable is the conclusion itself. Behaves like save_exit at the handler
   * level (falls through to persistence) — the distinction is intent + framing.
   */
  | "continue_session";

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
  /** When true, runDebate skips the research phase even if the leader requested it (user override). */
  researchSkipOverride?: boolean;
  /**
   * Leader's pre-computed "is research needed?" decision from runCouncil. When set,
   * runDebate reuses it instead of re-running the classifier LLM call — avoids a
   * duplicate leader-tier call per run plus a possible contradiction with the
   * user-facing skip card. Undefined for direct runDebate callers/tests (they re-evaluate).
   */
  leaderNeedsResearch?: boolean;
  /** When true, the working directory has no source code yet — research prompt prefers internet sources. */
  internetFirst?: boolean;
  /** When true, leader sub-tasks downshift to cheaper tier models on the same provider. */
  costAware?: boolean;
  /**
   * Feature B — council debate language override. When set, runDebate uses this
   * instead of reading `getCouncilLanguage()` from settings. Values: "auto"
   * (follow the brief's language), "english" (historical English-only debate),
   * or any locale label. Undefined → resolved from the user setting.
   */
  debateLanguage?: string;
  /**
   * Enclosing council run id (= sessionId). Used only as the correlationId on the
   * observe-only `council-turn-length` harness event so per-turn length samples can
   * be grouped by run. Optional: direct callers/tests may omit it (falls back to a
   * stable literal); has no effect on debate behaviour.
   */
  runId?: string;
  /**
   * B4 interactive escalation channel. When wired, a debate about to STOP with
   * pinned criteria still unmet (leader gave up or hit the ceiling) hands the
   * decision to the user via a council_question askcard instead of silently
   * synthesizing a partial outcome. Optional: headless/direct callers omit it and
   * the debate falls through to the diagnostic closing verdict unchanged. Same
   * responder the clarifier + post-debate askcards use.
   */
  respondToQuestion?: QuestionResponder;
  /**
   * convene_council path — when true, the mid-debate escalation askcard
   * (runEscalationPrompt) is auto-accepted WITHOUT emitting a blocking
   * council_question card. The convene tool runs the council autonomously
   * mid-agent-turn: there is no interactive user answering the escalation, so a
   * card would hang the tool call. Auto-accept = conclude with the best
   * synthesis so far. No decision is hardcoded post-synthesis — the calling
   * agent decides what to do with the returned conclusion.
   */
  convenePath?: boolean;
  /**
   * C (mid-debate checkpoint) — directory to persist the per-round debate
   * checkpoint (`debate-checkpoint.json`), normally the run dir
   * `.muonroi-flow/runs/<runId>`. When set, runDebate snapshots its state after
   * each completed round and deletes it on normal completion. Unset → no
   * checkpointing (direct callers/tests).
   */
  checkpointDir?: string;
  /**
   * C — a prior checkpoint to resume from. When present AND it matches this
   * debate (same problem statement + panel), runDebate skips the research +
   * opening phases and the already-completed rounds, restoring the accumulated
   * transcript, and continues from the last completed round. Ignored on mismatch.
   */
  resumeCheckpoint?: import("./debate-checkpoint.js").DebateCheckpoint;
  /**
   * #2 — isolated research bridge. When wired (interactive /council + auto-
   * council), the initial/mid-debate research phase runs in a budget-capped
   * explore sub-agent (near-empty context, independent compaction) instead of
   * an in-process 15-step generateText that accretes tool clutter into the
   * council thread. Optional: headless/direct callers/tests omit it and research
   * falls back to `llm.research`.
   */
  runIsolatedTask?: IsolatedTaskRunner;
  /**
   * Sprint-2 item 3 — per-stance recall at debate opening. When wired, runDebate
   * calls this once before opening statements with the panel's stances/roles and
   * a query; the returned per-role seed text is folded into each participant's
   * opening context so every stance opens grounded in the prior experience its
   * lens cares about (the EE server weights recall collections by stance).
   * Optional: headless/direct callers/tests omit it and openings run unchanged.
   */
  stanceRecall?: (roles: string[], query: string) => Promise<Map<string, string>>;
}

// ── Persisted Council Memory ─────────────────────────────────────────────────

/**
 * JSON shape persisted as `[Council Memory] {...}` in the session messages.
 * Loaded on follow-up turns so the agent can answer "who is the leader?",
 * "what did the X role say?", and cite specific positions.
 */
export interface CouncilMemoryRecord {
  topic: string;
  spec: ClarifiedSpec;
  debatePlan: DebatePlan;
  leaderModel: string;
  participants: Array<{ role: string; model: string; stance?: DebateStance }>;
  finalPositions: Array<{ role: string; position: string }>;
  /** Role-indexed per-round archive — enables citation by role/round on follow-ups. */
  archive: DebateArchiveEntry[];
  synthesis: string;
  confidence: {
    level: "high" | "medium" | "low";
    evidenceDensity: number;
    rounds: number;
  };
  stats: { calls: number; durationMs: number; phases: Array<{ name: string; durationMs: number }> };
  timestamp: string;
}

// ── Stats ────────────────────────────────────────────────────────────────────

export interface CouncilStats {
  calls: number;
  startMs: number;
  phases: Array<{ name: string; durationMs: number }>;
}

// ── LLM abstraction ──────────────────────────────────────────────────────────

export type ToolTraceEmitter = (traceText: string) => void;

/**
 * Token usage snapshot from a single model call.
 * Optional side-channel for callers (e.g. sprint-runner) that need real token
 * counts instead of chars/4 estimates for cap accounting.
 */
export interface CouncilCallUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export type UsageCallback = (usage: CouncilCallUsage) => void;

export interface CouncilLLM {
  generate(
    modelId: string,
    system: string,
    prompt: string,
    maxTokens?: number,
    onUsage?: UsageCallback,
    /**
     * User-abort signal. Threaded so a mid-council cancel (Esc/Ctrl-C) aborts
     * the in-flight generate call. Trailing+optional for back-compat — existing
     * positional callers/mocks are unaffected. See withCouncilSignal in index.ts.
     */
    signal?: AbortSignal,
  ): Promise<string>;
  research(
    modelId: string,
    topic: string,
    conversationContext: string,
    signal?: AbortSignal,
    persistTrace?: ToolTraceEmitter,
    options?: { internetFirst?: boolean },
    onUsage?: UsageCallback,
  ): Promise<string>;
  debate(
    modelId: string,
    system: string,
    prompt: string,
    signal?: AbortSignal,
    persistTrace?: ToolTraceEmitter,
    options?: { enableVerificationTools?: boolean },
    onUsage?: UsageCallback,
  ): Promise<{ text: string; toolCalls: Array<{ toolName: string; result?: unknown }> }>;
}

export type QuestionResponder = (questionId: string) => Promise<string>;
export type PreflightResponder = (preflightId: string) => Promise<boolean>;
