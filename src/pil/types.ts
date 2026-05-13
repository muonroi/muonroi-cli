/**
 * src/pil/types.ts
 *
 * Core type definitions for the Prompt Intelligence Layer (PIL) pipeline.
 */

import type { ComplexityTier } from "../gsd/complexity.js";
import type { GrayAreaQuestion } from "../gsd/gray-areas.js";

export type TaskType = "refactor" | "debug" | "plan" | "analyze" | "documentation" | "generate" | "general";

export type OutputStyle = "concise" | "detailed" | "balanced";

export type { ComplexityTier, GrayAreaQuestion };

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
  /**
   * T1 behavioral rules extracted by Layer 3 from EE proven-tier points.
   * These are high-hitCount / tier=proven entries that have been promoted to
   * behavioral reflex status. Layer 6 appends them as MANDATORY RULES to the
   * output suffix so the model treats them as instructions, not just context.
   *
   * TODO(WhoAmI): when EE v4.0 Who Am I is implemented, merge project-level
   * t1Rules with user-level personality directives from the profile model.
   */
  t1Rules?: string[];
  /**
   * Brain-derived data populated by Layer 1 when the unified /api/pil-context
   * call succeeds. Layers 3, 5, 6 read from here instead of issuing their own
   * brain calls. Null when L1 took the legacy path (brain unreachable, low
   * pipeline budget, or feature flag disabled).
   */
  _brainData?: BrainData | null;
}

export interface BrainData {
  t0_principles: Array<{ text: string; score: number }>;
  t1_rules: string[];
  t2_patterns: Array<{ text: string; score: number }>;
  retrieval_skipped_reason: string | null;
}
