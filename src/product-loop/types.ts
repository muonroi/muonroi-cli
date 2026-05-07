import type { WorkflowKind } from "../gsd/types.js";
import type { ToolResult, VerifyRecipe } from "../types/index.js";
import type { CouncilLLM, PreflightResponder } from "../council/types.js";

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

export type DoneCondition = "engineering_floor" | "evidence_regex" | "weighted_score" | "customer_debate" | "user_approval";

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
}
