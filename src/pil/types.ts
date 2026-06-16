/**
 * src/pil/types.ts
 *
 * Core type definitions for the Prompt Intelligence Layer (PIL) pipeline.
 */

import type { ComplexityTier } from "../gsd/complexity.js";
import type { GrayAreaQuestion } from "../gsd/gray-areas.js";
import type { ComplexitySizeResult } from "./layer1_5-complexity-size.js";

export type TaskType = "refactor" | "debug" | "plan" | "analyze" | "documentation" | "generate" | "build" | "general";

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
  /**
   * Layer 1.5 deterministic complexity-size classification.
   * Populated immediately after `layer1Intent` in `runLayers()`. Consumers:
   *   - 4B step ceiling (task_type × size matrix lookup)
   *   - 4A reminder cadence K (3 small / 5 medium / 8 large)
   * Pure heuristic — no LLM call. See `layer1_5-complexity-size.ts`.
   */
  complexitySize?: ComplexitySizeResult | null;
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
   * Model-decided output deliverable (Phase 2b): "answer" (explanation / review
   * / question — no edits), "code" (create/edit files), "report" (structured
   * list/plan/audit). Set by layer1's model-first classifier. Consumed by
   * layer4 (`informational` directive) and layer6 (`getResponseToolSet` /
   * `applyPilSuffix` output-format gating) INSTEAD of re-deriving intent via
   * keyword regex. null/undefined when the model omitted it or the legacy
   * cascade ran → those consumers fall back to their regex predicates.
   */
  deliverableKind?: "answer" | "code" | "report" | null;
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
  /**
   * Step-by-step task detection trace from Layer 1. Captures which Pass set
   * the final taskType + style, so cost reports can answer "are we wasting
   * brain calls when regex would have answered?". Optional — `pipeline.ts`
   * forwards it to the PIL budget log when present.
   */
  _intentTrace?: IntentDetectionTrace | null;
  _discoveryResult?: import("./discovery-types.js").DiscoveryResult | null;
}

/**
 * One-shot snapshot of Layer 1's three-pass intent detection cascade.
 * Cheaper passes hit first; later passes only run when earlier ones abstain.
 * Each `*Hit` flag answers "did this pass decide the final taskType/style?"
 * — at most one of `pass1/2/3` should be true for `*Hit` fields.
 */
export interface IntentDetectionTrace {
  /**
   * Detected target framework for BB-aware retrieval.
   * "muonroi-building-block" when Directory.Build.props + *.sln + src/Muonroi.* heuristic matches.
   * Undefined when no framework-specific signals detected.
   */
  targetFramework?: "muonroi-building-block" | string;
  /** Classifier reason string (e.g. "regex:debug", "tree-sitter:typescript"). */
  pass1Reason: string;
  /** Confidence reported by the classifier (0..1). */
  pass1Confidence: number;
  /** taskType derived from pass1Reason via REASON_TO_TASK_TYPE; null if no map. */
  pass1TaskType: string | null;
  /** Pass 1 alone decided the final taskType (no later pass overrode it). */
  pass1Hit: boolean;
  /** Pass 2 keyword fallback matched. */
  pass2Hit: boolean;
  /** Which keyword pattern matched (string repr of regex source) — only set when pass2Hit. */
  pass2Pattern?: string;
  /** Pass 2.5 hot-path chitchat short-circuit fired (≤10 chars + ≤2 words). */
  pass25ChitchatHit: boolean;
  /** Unified /api/pil-context attempted (feature flag on + weak local signal). */
  pass3UnifiedAttempted: boolean;
  /** Unified call returned a non-null response. */
  pass3UnifiedSucceeded: boolean;
  /** Legacy brain call attempted for TASK classification (1500ms budget). */
  pass3LegacyTaskAttempted: boolean;
  /** Legacy task-classification call returned a non-null response. */
  pass3LegacyTaskSucceeded: boolean;
  /** Legacy brain call attempted for STYLE detection (800ms budget). */
  pass3LegacyStyleAttempted: boolean;
  /** Legacy style-detection call returned a non-null response. */
  pass3LegacyStyleSucceeded: boolean;
  /** Pass 4 LLM fallback attempted (brain returned null / low confidence and orchestrator supplied a closure). */
  pass4LlmAttempted?: boolean;
  /** Pass 4 LLM fallback returned a parseable result. */
  pass4LlmSucceeded?: boolean;
  /** How the final outputStyle was resolved. */
  styleSource: "explicit-regex" | "brain-unified" | "brain-legacy" | "chitchat-default" | "classifier-default" | "none";
  /** Final taskType emitted by Layer 1. */
  finalTaskType: string | null;
  /** Final confidence emitted by Layer 1. */
  finalConfidence: number;
  /** Heuristic complexity routing decision: low / medium / high. */
  complexity: "low" | "medium" | "high";
  /** Raw score that produced complexity (-3..+10 range). */
  complexityScore: number;
  /** Layer 1.5 bucketed size — small/medium/large. */
  complexitySize?: "small" | "medium" | "large";
  /** Layer 1.5 raw heuristic score. */
  complexitySizeScore?: number;
}

export interface BrainData {
  t0_principles: Array<{ text: string; score: number }>;
  t1_rules: string[];
  t2_patterns: Array<{ text: string; score: number }>;
  retrieval_skipped_reason: string | null;
}
