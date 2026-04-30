/**
 * src/pil/types.ts
 *
 * Core type definitions for the Prompt Intelligence Layer (PIL) pipeline.
 */

export type TaskType =
  | 'refactor'
  | 'debug'
  | 'plan'
  | 'analyze'
  | 'documentation'
  | 'generate';

export type OutputStyle = 'concise' | 'detailed' | 'balanced';

export interface LayerResult {
  name: string;
  applied: boolean;
  delta: string | null;
}

export interface PipelineMetrics {
  totalMs: number;
  layerTimings: Array<{ name: string; ms: number }>;
  inputChars: number;
  outputChars: number;
  estimatedTokensSaved: number;
}

export interface PipelineContext {
  raw: string;
  enriched: string;
  taskType: TaskType | null;
  domain: string | null;
  /** Classifier confidence score 0..1. 0 = fallback/timeout path. */
  confidence: number;
  outputStyle: OutputStyle | null;
  tokenBudget: number;
  metrics: PipelineMetrics | null;
  layers: LayerResult[];
  // P2: Session & GSD context (optional — layers skip if absent)
  gsdPhase?: string | null;
  resumeDigest?: string | null;
  activeRunId?: string | null;
}
