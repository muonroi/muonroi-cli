import type { CouncilQuestionData } from "../types/index.js";
import type { CouncilQuestionAnswer } from "../ui/components/council-question-card.js";
import type { OutputStyle, TaskType } from "./types.js";

export interface ProjectContext {
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  domain: string | null;
  boundedContexts: BoundedContext[];
  eePatterns: string[];
  relevantModules: RelevantModule[];
  recentModifiedFiles?: string[];
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

/**
 * A card designed entirely by the model — the model controls the question,
 * context, options (labels, kinds, which is cancel/adjust), and default.
 * The CLI only assigns questionId and renders via CouncilQuestionData.
 */
export interface ModelCard {
  /** The question text shown to the user */
  question: string;
  /** Optional context/explanation shown below the question */
  context?: string;
  /** User-selectable options. Model controls labels, kinds, cancel/adjust markers */
  options: ModelCardOption[];
  /** Which option is pre-selected (0 = first). Defaults to 0. */
  defaultIndex?: number;
}

export interface ModelCardOption {
  /** Button label or freetext field label */
  label: string;
  /** Optional tooltip / description */
  description?: string;
  /** 'choice' = clickable button, 'freetext' = free-text input field */
  kind: "choice" | "freetext";
  /** If true, picking this option cancels the entire interaction */
  isCancel?: boolean;
  /** If true, picking this indicates the user wants to clarify further (triggers re-interview) */
  isAdjust?: boolean;
}

export interface ClarifiedIntent {
  intentStatement?: string;
  outcome: string;
  scope: string[];
  feasibilityWarnings?: string[];
  interviewed?: boolean;
  accepted?: boolean;
  constraints?: string[];
  gaps?: Array<{ dimension: string; answer: string | null; options: string[]; defaultIndex: number }>;
  modelClarifications?: Array<{ question: string; answer: string }>;
}

export type ModelClarificationProposer = (input: {
  raw: string;
  l1: {
    taskType: TaskType | null;
    confidence: number;
    complexity?: "low" | "medium" | "high";
    domain?: string | null;
  };
  additionalContext?: string;
}) => Promise<ModelCard[]>;

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
  /** Raw Q&A pairs from the interview, visible to the model in enrichment */
  interviewTranscript: Array<{ question: string; answer: string }>;
}

export interface AcceptanceCardData {
  intentStatement: string;
  outcome: string;
  scope: string[];
  warnings: string[];
}

export interface DiscoveryInteractionHandler {
  askQuestion(question: CouncilQuestionData): Promise<CouncilQuestionAnswer>;
}
