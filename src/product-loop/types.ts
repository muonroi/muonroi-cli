import type { CouncilLLM, PreflightResponder } from "../council/types.js";
import type { WorkflowKind } from "../gsd/types.js";
import type { ToolResult, VerifyRecipe } from "../types/index.js";

export type { WorkflowKind };

export type RoleSlot = "PO" | "Architect" | "Implementer" | "Tester" | "Reviewer" | "Customer";

export interface ProductSpec {
  idea: string;
  persona: string;
  mvp: string[];
  phase2: string[];
  architecture: string;
  ioContract: string;
  folderStructure: string;
  sprintEstimate: number;
  costEstimate: number;
  stack?: string;
  createdAt: Date;
}

export type DoneCondition =
  | "engineering_floor"
  | "evidence_regex"
  | "weighted_score"
  | "assumption_ledger"
  | "customer_debate"
  | "user_approval";

export interface Criterion {
  id: string;
  status: "met" | "partial" | "unmet";
  evidence?: string;
  sprint?: number;
  evidenceValid?: boolean;
}

export interface IterationState {
  sprintN: number;
  stage: string;
  scoreBefore: number;
  scoreAfter: number;
  criteriaMet: number;
  criteriaPartial: number;
  criteriaUnmet: number;
  costUsd: number;
  lastVerifyResult: string;
  /** Alias of costUsd kept for circuit-breaker history adapters (CB-1 reads actualCost). */
  actualCost?: number;
  /** Alias of scoreAfter for CB-2 history adapters. */
  score?: number;
  crashed?: boolean;
  retryOf?: number;
}

export interface DoneVerdict {
  pass: boolean;
  failedCondition?: DoneCondition;
  reason?: string;
  score: number;
}

export interface ProductRunManifest {
  idea: string;
  capUsd: number;
  maxSprints: number;
  doneThreshold: number;
  stack?: string;
  createdAt: Date;
  doneAt?: Date;
  verdict?: DoneVerdict;
  aborted?: boolean;
}

export interface ProductStatusCardData {
  sprintN: number;
  totalSprints: number;
  costSpent: number;
  costCap: number;
  criteriaMet: number;
  criteriaPartial: number;
  criteriaUnmet: number;
  currentStage: string;
  /**
   * Per-sprint snapshot of (met, total) so the renderer can draw a
   * met-ratio sparkline showing whether the run is converging on done
   * across sprints. Optional — older callers can omit and the card
   * just hides the sparkline row.
   */
  criteriaHistory?: Array<{ sprintN: number; met: number; total: number }>;
  /**
   * Per-sprint cumulative cost so the renderer can draw a burndown
   * (or burn-up). Optional.
   */
  costHistory?: Array<{ sprintN: number; cumulativeUsd: number }>;
}

export type Stage = "idle" | "discover" | "gather" | "research" | "scoping" | "approved" | "halted" | "error";

export interface DriverContext {
  runId: string;
  flowDir: string;
  idea: string;
  /**
   * The session's model id (this.modelId from orchestrator). Used to resolve
   * the council leader model and participant roster via resolveLeaderModelDetailed
   * + resolveParticipants. MUST NOT be a role string like "leader".
   */
  sessionModelId: string;
  llm: import("../council/types.js").CouncilLLM;
  flags: {
    maxCost: number;
    maxSprints: number;
    doneThreshold: number;
    stack?: string;
  };
  respondToQuestion: import("../council/types.js").QuestionResponder;
  respondToPreflight: import("../council/types.js").PreflightResponder;
  /**
   * Working directory of the host project. Used by sprint-runner to detect
   * the verify recipe and to anchor council planning context.
   */
  cwd?: string;
  /**
   * Chat session id from the orchestrator (sessions.id in the DB). Used as the
   * first argument to logInteraction so FK constraints are satisfied.
   * Falls back to runId when not provided (e.g. unit tests / legacy callers).
   */
  sessionId?: string;
  /**
   * Bridge into the orchestrator's tool-execution loop. Sprint-runner pipes
   * the council plan through this fn during the implement stage so the same
   * tools / EE intercept / posttool hooks fire as for ordinary chat turns.
   *
   * Optional because legacy tests for the FSM driver still construct ctx
   * without it; sprint-runner enforces presence at call time.
   */
  processMessageFn?: (message: string) => AsyncGenerator<import("../types/index.js").StreamChunk, void, unknown>;
  /**
   * Optional bridge for verify-recipe detection. Mirrors `Orchestrator.detectVerifyRecipe`.
   * If absent, sprint-runner uses a deterministic fallback based on the inferVerifyProjectProfile
   * heuristic.
   */
  detectVerifyRecipe?: () => Promise<import("../types/index.js").VerifyRecipe | null>;
  /**
   * P5 opt-out: when true, the discover phase skips cross-run memory loading
   * even if prior runs exist in this workspace. Used for greenfield starts
   * where prior context would be misleading rather than helpful.
   */
  skipPriorContext?: boolean;
  /**
   * Intent detection trace from Layer 1. When present and targetFramework is
   * "muonroi-building-block", loop-driver injects BB context before council debate.
   */
  _intentTrace?: import("../pil/types.js").IntentDetectionTrace | null;
  /**
   * Sufficiency gap signals from PIL Layer 1. When non-empty, the dispatcher
   * forced the Council path because the prompt lacked context (no file ref,
   * vague product noun, etc.). The driver seeds AskCard discovery questions
   * for each missing category.
   */
  sufficiencyMissing?: readonly import("../pil/layer1-intent.js").SufficiencyMissing[];
}

export interface DriverResult {
  runId: string;
  stage: Stage;
  success: boolean;
  reason?: string;
}

export interface DoneGateContext {
  lastVerify?: ToolResult;
  recipe: VerifyRecipe | null;
  criteria: Criterion[];
  history: IterationState[];
  roleAssignments: Map<RoleSlot, { modelId: string; provider: string; tier?: string }>;
  doneThreshold?: number;
  llm: CouncilLLM;
  respondToPreflight: PreflightResponder;
  /**
   * P6: location of the assumption ledger so condition #6 can read the
   * current set of unresolved high-confidence assumptions. Optional so
   * legacy callers (tests, scripts) that don't touch the ledger still
   * compile — the condition becomes a no-op when absent.
   */
  flowDir?: string;
  runId?: string;
}

// ===== Discovery (B+C spec) =====

export type ProductTypeT = "saas" | "internal-tool" | "consumer-app" | "b2b-platform" | "marketplace" | "other";

export type PlatformT =
  | "web"
  | "mobile-ios"
  | "mobile-android"
  | "desktop-win"
  | "desktop-mac"
  | "desktop-linux"
  | "cli";

export type ScaleT = "1-100" | "100-1k" | "1k-100k" | "100k-1M" | "1M+";

export type BackendArchT = "monolith" | "modular-monolith" | "microservices" | "serverless" | "none";

export type DbModeT = "greenfield" | "existing-schema" | "migrate-from";

export type FeLibraryT = "shadcn" | "radix" | "headlessui" | "none";

export interface AudienceCtx {
  persona: string;
  scale: ScaleT;
  geography: string;
}

export interface BackendStackCtx {
  language: string;
  framework: string;
  runtime?: string;
}

export interface DbStrategyCtx {
  mode: DbModeT;
  engine: string;
  notes?: string;
}

export interface FrontendApproachCtx {
  library: FeLibraryT;
  framework: "next" | "vite-react" | "svelte" | "none";
}

export interface DeploymentCtx {
  target: "self-host" | "cloud" | "hybrid";
  provider?: string;
  ciCd?: string;
}

export interface DiscoveryContext {
  productType: ProductTypeT;
  targetPlatform: PlatformT[];
  audience: AudienceCtx;
  backendArchitecture: BackendArchT;
  backendStack: BackendStackCtx;
  dbStrategy: DbStrategyCtx;
  frontendApproach?: FrontendApproachCtx;
  baStatus?: "complete" | "partial" | "none";
  designStatus?: "system-exists" | "mockups-only" | "none";
  deployment?: DeploymentCtx;
}

export interface RecommendationEntry {
  chosen: any;
  alternatives: any[];
  rationale: string;
  source: "leader" | "council" | "user-only";
  debateRef?: string;
  tiebreakUsed?: boolean;
  synthFailed?: boolean;
}

export interface UserOverrideEntry {
  seq: number;
  timestampUtc: string;
  field: string;
  from: any;
  to: any;
  reason: string;
}

export type ClassificationT = "greenfield" | "existing" | "ambiguous";

export interface ManifestDetection {
  file: string;
  type: "package.json" | "Cargo.toml" | "go.mod" | "pyproject.toml" | "csproj" | "pom.xml" | "build.gradle";
  weight: number;
  inferredLang: string;
  inferredFrameworks: string[];
}

export interface ExistingProjectSignals {
  isGitRepo: boolean;
  hasCommitHistory: boolean;
  srcFileCount: number;
  manifests: ManifestDetection[];
  languages: string[];
  frameworks: string[];
  classification: ClassificationT;
}

export interface ProjectContext {
  version: 1;
  schemaName: "project-context";
  generatedAt: string;
  idea: string;
  detection: ExistingProjectSignals;
  context: DiscoveryContext;
  recommendations: {
    byField: Record<string, RecommendationEntry>;
    constraints: {
      fePolicy: "headless-ui-only";
      feEnforced: boolean;
    };
  };
  userOverrides: UserOverrideEntry[];
}

export type DiscoveryPhase = "interview" | "awaiting-artifact-write" | "done";

export interface DiscoveryState {
  version: 1;
  phase: DiscoveryPhase;
  classification: ClassificationT;
  prefillSource: { fromDetection: string[]; fromPrompt: string[] };
  questionsAsked: string[];
  questionsAnswered: string[];
  currentQuestion?: string;
  answers: Partial<DiscoveryContext>;
  recommendations: Record<string, RecommendationEntry>;
  userOverrides: UserOverrideEntry[];
  userGatePassed: boolean;
  cumulativeRecommenderCostUsd: number;
}

// ── Subsystem E (Phase Orchestrator) ────────────────────────────────────────

export interface Phase {
  id: string;
  name: string;
  goal: string;
  successCriteria: string[];
  scope: string;
  exitCondition: { type: "criteria-threshold"; min: number };
  dependsOn: string[];
  maxSprints: number;
}

export interface PhasePlanArtifact {
  version: 1;
  generatedAt: string;
  phases: Phase[];
}

export type PhaseStatus = "pending" | "in-progress" | "done" | "blocked";

export interface PhasePlanState {
  version: 1;
  currentPhaseId: string | null;
  phasesStatus: Record<string, PhaseStatus>;
  lastActivityUtc: string;
}

export interface LessonsLearned {
  wentWell: string[];
  toImprove: string[];
  nextSprintFocus: string;
}

export interface StandupOutcome {
  blockers: string[];
  decisions: string[];
  nextStep: string;
}

export interface CustomerDecision {
  seq: number;
  timestampUtc: string;
  phaseId: string;
  sprintN: number;
  verdict: "accept" | "reject" | "abort";
  feedback?: string;
}

export interface PhaseHistoryEntry {
  phaseId: string;
  exitedAtUtc: string;
  exitSummary: string;
  sprintsExecuted: number;
  criteriaMetCount: number;
}

export interface PhaseDigestEntry {
  sprintN: number;
  timestampUtc: string;
  lessonText: string;
}

// ── Halt chunk (Task 5.1) ────────────────────────────────────────────────────

/**
 * An actionable recovery choice surfaced alongside a halt chunk.
 * The UI (Task 5.2) wires each id to a concrete handler.
 */
export interface RecoveryOption {
  /** Stable key. Used by the UI to wire actions. */
  id: "init_new" | "point_to_existing" | "continue_as_council";
  /** Label shown in the recovery card. */
  label: string;
  /** One-line user-facing description of what choosing this does. */
  description: string;
}

/**
 * Yielded by sprint-runner when a circuit breaker (currently CB-3) prevents
 * the sprint from starting. Replaces the previous throw so the TUI can render
 * an actionable recovery card rather than crashing with an opaque message.
 */
export interface HaltChunk {
  type: "halt";
  /** CB-3 currently only emits "no_recipe"; kept as a union for future CBs. */
  reason: "no_recipe" | "zero_coverage";
  /** Optional human-readable detail rendered alongside the recovery card. */
  detail?: string;
  /** Actionable choices. UI renders these as buttons / list items. */
  recovery_options: RecoveryOption[];
}

export interface RunPhasesOptions {
  flowDir: string;
  runId: string;
  manifest: ProductRunManifest;
  clarifiedSpec: import("../council/types.js").ClarifiedSpec;
  projectContext: ProjectContext;
  leader: import("./discovery-prompt-parser.js").LeaderLike;
  leaderModelId: string;
  capUsd: number;
  remainingUsd: () => Promise<number>;
  awaitCustomerVerdict: (args: {
    flowDir: string;
    runId: string;
    phaseId: string;
    sprintN: number;
    reviewSummary: string;
  }) => Promise<Omit<CustomerDecision, "seq" | "timestampUtc" | "phaseId" | "sprintN">>;
  suppressPush?: boolean;
  backoffDelays?: number[];
}
