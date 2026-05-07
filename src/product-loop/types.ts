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

export type Stage = "idle" | "gather" | "research" | "scoping" | "approved" | "halted" | "error";

export interface DriverContext {
  runId: string;
  flowDir: string;
  idea: string;
  llm: import("../council/types.js").CouncilLLM;
  flags: {
    maxCost: number;
    maxSprints: number;
    doneThreshold: number;
    stack?: string;
  };
  respondToQuestion: import("../council/types.js").QuestionResponder;
  respondToPreflight: import("../council/types.js").PreflightResponder;
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
