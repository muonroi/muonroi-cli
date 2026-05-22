import type { CouncilQuestionAnswer, CouncilQuestionData } from "../types/index.js";
import type { OutputStyle, TaskType } from "./types.js";

export interface ProjectContext {
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  domain: string | null;
  boundedContexts: BoundedContext[];
  eePatterns: string[];
  relevantModules: RelevantModule[];
  scannedAt: number;
  cwd: string;
}

export interface BoundedContext {
  path: string;
  name: string;
  entryFiles: string[];
  exportedSymbols: string[];
}

export interface RelevantModule {
  path: string;
  relevance: string;
  exists: boolean;
}

export type ClarityDimension = "outcome" | "scope" | "constraint";

export interface ClarityGap {
  dimension: ClarityDimension;
  description: string;
  suggestedQuestion: string;
  options: string[];
  defaultIndex: number;
}

export interface ClarifiedIntent {
  outcome: string;
  scope: string[];
  constraints: string[];
  gaps: Array<ClarityGap & { answer: string | null }>;
}

export interface FeasibilityResult {
  viable: boolean;
  warnings: string[];
  adjustedScope: string[];
}

export interface DiscoveryResult {
  raw: string;
  projectContext: ProjectContext;
  clarifiedIntent: ClarifiedIntent;
  feasibility: FeasibilityResult;
  interviewed: boolean;
  intentStatement: string;
  outcome: string;
  scope: string[];
  feasibilityWarnings: string[];
  accepted: boolean;
  taskType: TaskType | null;
  confidence: number;
  domain: string | null;
  outputStyle: OutputStyle | null;
  discoveryMs: number;
}

export interface AcceptanceCardData {
  intentStatement: string;
  outcome: string;
  scope: string[];
  warnings: string[];
}

export interface DiscoveryInteractionHandler {
  askQuestion(question: CouncilQuestionData): Promise<CouncilQuestionAnswer>;
  showAcceptance(card: AcceptanceCardData): Promise<"accept" | "adjust" | "cancel">;
}
