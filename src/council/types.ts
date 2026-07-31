import type { ModelMessage } from "ai";
import type { ProcessMessageObserver } from "../orchestrator/agent-options.js";
import type { CouncilPanelLedgerEntry, CouncilStanceRow, TaskRequest, ToolResult } from "../types/index.js";
import type { ModelRole } from "../utils/settings.js";

/**
 * Bridge to the orchestrator's isolated sub-agent runner (runTaskRequest). When
 * wired into a council run, heavy phases (research; #3 grounding-verify) execute
 * in a budget-capped, near-empty explore sub-agent instead of an in-process
 * multi-step generateText that bloats the council thread/context. The bridge
 * closure captures the council abort signal, so callers pass only the request.
 */
export type IsolatedTaskRunner = (request: TaskRequest) => Promise<ToolResult>;

/**
 * Sentinel a UI sends back through `respondToQuestion` when the user DISMISSED a
 * council askcard (Esc) rather than submitting it.
 *
 * The distinction is load-bearing on the post-debate card: an empty SUBMIT means
 * "take the recommended option" (the card pre-selects one and labels it
 * Recommended), while a dismiss means "do nothing". Both used to arrive as `""`,
 * so honouring the default for an empty submit would silently have turned Esc
 * into "run the recommended action" — a worse bug than the one being fixed.
 *
 * Mirrors ASK_USER_DISMISSED for the ask_user tool. Consumers that do not send
 * it are unaffected: an unknown value still routes as a free-text follow-up and
 * `""` still resolves to the default.
 */
export const COUNCIL_ANSWER_DISMISSED = "(the user dismissed the council card without answering)";

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

/**
 * One panelist's position on a single success criterion, as graded by the leader
 * during its per-round evaluation.
 *
 *   "+"  supports      "-"  opposes      "~"  conditional      null  has not spoken
 *
 * `null` is load-bearing: a panelist who never argued a criterion must NEVER be
 * folded into the agreeing majority, or a 4/5 with one abstention reads as
 * opposition (and a 3/5 with two abstentions reads as consensus).
 */
export type StanceMark = "+" | "-" | "~" | null;

export interface LeaderEvaluation {
  allCriteriaMet: boolean;
  criteriaStatus: Array<{
    criterion: string;
    met: boolean;
    evidence: string;
    /**
     * Per-panelist stance keyed by role label. Absent when the leader's model
     * omitted the field or emitted an unparseable shape — callers must treat
     * absence as "unknown", never as agreement.
     */
    stances?: Record<string, StanceMark>;
    /** One-line reason the panel is split, present only on a contested criterion. */
    split?: string;
    /**
     * True when this criterion cannot be satisfied by DEBATING at all — it is
     * only closable by work that happens after the debate (landing the code,
     * running the tests, observing the changed behaviour). Set by the leader.
     *
     * Load-bearing: such a criterion must never drive "extend N more rounds".
     * Session 811336618ee0 pinned "thực hiện được thay đổi cụ thể trong code"
     * and "sau thay đổi … vẫn giữ hành vi" — 2 of 4 criteria a debate structurally
     * cannot meet. The escalation card offered "Extend 2 more rounds", the user
     * took it, two extra rounds ran (~6 min, ~$0.05) and the count stayed 2/4,
     * because more debate can never close a criterion that requires a mutation.
     */
    deferred?: boolean;
  }>;
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
   * Per-participant opening failures (model + last error) for every speaker that
   * never produced a position. Populated even when SOME openings succeed, so the
   * caller can report a partial panel; when it accounts for the whole panel the
   * run is aborted rather than synthesized (see council/index.ts). Exists because
   * the provider error string was previously unreachable outside an opt-in debug
   * log — see session e74e820c6417.
   */
  openingFailures?: Array<{ model: string; role: string; error: string }>;
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
   * Index-aligned to `spec.successCriteria`: true when the leader judged that
   * criterion closable only AFTER the debate (it needs the code landed / tests
   * run), so no number of rounds can move it. The post-debate card reports these
   * as "deferred to implementation" instead of counting them as failures, and
   * the escalation boundary never offers to extend for them.
   */
  finalCriteriaDeferred?: boolean[];
  /**
   * B4 interactive escalation outcome. Set only when the user was prompted at a
   * stop-with-unmet boundary and chose an action: `extend` granted extra rounds
   * past the ceiling, `accept` proceeded with criteria open, `rescope` asked to
   * narrow the scope. Undefined when no escalation fired (auto-resolved, headless,
   * or all criteria met). Lets synthesis/caller react to a user-driven partial stop.
   */
  escalation?: { action: "extend" | "accept" | "rescope"; grantedRounds?: number };
  /**
   * S8 — the run receipt inputs the post-debate card reports back ("2 rounds ·
   * 14 turns · 3/4 criteria met · $0.19 · 4m12s"). Measured by the debate loop;
   * the caller has no other way to see per-speaker spend or wall clock, and the
   * numbers users ask for first should not have to be reconstructed.
   */
  panelLedger?: CouncilPanelLedgerEntry[];
  /** Wall-clock duration of the debate loop, ms. */
  elapsedMs?: number;
  /**
   * The final per-criterion stance snapshot, so the post-debate card can offer
   * "re-run with <role>'s objection as the topic" against a position that was
   * actually recorded rather than an invented one.
   */
  finalStanceRows?: CouncilStanceRow[];
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
 * Bounded output-intent kind. The leader LLM selects FROM this vocabulary; an
 * out-of-set value is coerced to "evaluation" at the planner/consumer boundary
 * (see coerceIntentKind). This makes "drifted intent" unrepresentable at the
 * type level — three prior bugs (bab91d29, 5c18d1d5, 12d3022b) all branched on
 * a free-form string the model emitted and the code trusted.
 *
 * Two clusters:
 *   - ANALYSIS kinds — the synthesis IS the deliverable; never a build mandate:
 *     decision | evaluation | investigation | resolve_question
 *   - IMPLEMENTATION kinds — carry an "original task" forward through the build
 *     workflow: implementation_plan | action_items
 */
export type IntentKind =
  | "decision"
  | "evaluation"
  | "investigation"
  | "resolve_question"
  | "implementation_plan"
  | "action_items";

/** Analysis-shape kinds. Synthesis is self-contained — no build carry-forward. */
export const ANALYSIS_INTENT_KINDS = new Set<IntentKind>([
  "decision",
  "evaluation",
  "investigation",
  "resolve_question",
]);

/** Implementation-shape kinds. The post-debate flow may carry the conclusion forward. */
export const IMPLEMENTATION_INTENT_KINDS = new Set<IntentKind>(["implementation_plan", "action_items"]);

/**
 * Coerce any LLM-emitted value into a valid IntentKind. Unknown / empty / non-string
 * → "evaluation" (the safe analysis default — never a build mandate). Call this at
 * every boundary where untrusted model output becomes an IntentKind.
 */
export function coerceIntentKind(raw: unknown): IntentKind {
  if (typeof raw !== "string") return "evaluation";
  const trimmed = raw.trim();
  return ANALYSIS_INTENT_KINDS.has(trimmed as IntentKind) || IMPLEMENTATION_INTENT_KINDS.has(trimmed as IntentKind)
    ? (trimmed as IntentKind)
    : "evaluation";
}

/** True for implementation-shape kinds (the post-debate flow may carry forward). */
export function isImplementationKind(kind: IntentKind): boolean {
  return IMPLEMENTATION_INTENT_KINDS.has(kind);
}

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
  /** Authoritative intent kind — bounded by {@link IntentKind}. LLM output is coerced. */
  kind: IntentKind;
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
  /** Authoritative intent kind — bounded by {@link IntentKind}. Source: debatePlan.outputShape.kind. */
  type: IntentKind;
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
  /**
   * When true, the turn is an out-of-repo ("external") question: runDebate skips
   * the research phase AND grounding-verify so no council sub-path reads the repo.
   * Council still convenes + debates + synthesizes on model knowledge.
   */
  externalTopic?: boolean;
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
