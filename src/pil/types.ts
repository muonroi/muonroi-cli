/**
 * src/pil/types.ts
 *
 * Core type definitions for the Prompt Intelligence Layer (PIL) pipeline.
 */

import type { GrayAreaQuestion } from "../gsd/gray-areas.js";
import type { ComplexityTier } from "../gsd/complexity.js";

export type TaskType = "refactor" | "debug" | "plan" | "analyze" | "documentation" | "generate" | "general";

export type OutputStyle = "concise" | "detailed" | "balanced";

export type { GrayAreaQuestion, ComplexityTier };

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
  /** Tokens added to system prompt input by the L6 suffix instruction. NOT tokens saved in output. */
  suffixInstructionTokens: number;
  enrichmentTokensAdded: number;
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
  digestAgeMs?: number | null;
  sessionId?: string | null;
  /** GSD-native triage tier (set by layer4). */
  complexityTier?: ComplexityTier | null;
  /** Heuristic gray-area questions surfaced by layer4 when tier === "heavy". */
  grayAreas?: GrayAreaQuestion[];
  /**
   * Coarse intent: "chitchat" for greetings/small-talk/no-coding-intent,
   * "task" when there is a coding intent, null when undetermined. Set by
   * layer1; respected by layer4 (skip GSD directive) and layer5 (skip
   * heavy context like recent-files / flow-state). Distinct from taskType
   * "general", which conflates chitchat with low-confidence fallback.
   */
  intentKind?: "task" | "chitchat" | null;
  /**
   * Diagnostic: when the pipeline returns the fallback context, this records
   * the reason (timeout / schema-reject / exception). Null on the happy path.
   * Helps distinguish "fallback because brain unreachable" from "fallback
   * because schema validation failed" when reading interaction_logs.
   */
  fallbackReason?: string | null;
}
