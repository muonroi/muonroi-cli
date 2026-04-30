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

export interface LayerResult {
  name: string;
  applied: boolean;
  delta: string | null;
}

export interface PipelineContext {
  raw: string;
  enriched: string;
  taskType: TaskType | null;
  domain: string | null;
  /** Classifier confidence score 0..1. 0 = fallback/timeout path. */
  confidence: number;
  layers: LayerResult[];
}
