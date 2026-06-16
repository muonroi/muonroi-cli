/**
 * src/pil/schema.ts
 *
 * Zod schemas for runtime validation of PIL pipeline output.
 * Used in runPipeline() with safeParse — fail-open on invalid data.
 */

import { z } from "zod";

export const TaskTypeSchema = z.enum([
  "refactor",
  "debug",
  "plan",
  "analyze",
  "documentation",
  "generate",
  "build",
  "general",
]);

export const OutputStyleSchema = z.enum(["concise", "detailed", "balanced"]);

export const LayerResultSchema = z.object({
  name: z.string(),
  applied: z.boolean(),
  delta: z.string().nullable(),
});

export const LayerTimingSchema = z.object({
  name: z.string(),
  ms: z.number().min(0),
});

export const PipelineMetricsSchema = z.object({
  totalMs: z.number().min(0),
  layerTimings: z.array(LayerTimingSchema),
  inputChars: z.number().min(0),
  outputChars: z.number().min(0),
  suffixInstructionTokens: z.number().min(0),
  enrichmentTokensAdded: z.number().min(0),
});

export const PipelineContextSchema = z.object({
  raw: z.string(),
  enriched: z.string(),
  taskType: TaskTypeSchema.nullable(),
  domain: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  outputStyle: OutputStyleSchema.nullable(),
  tokenBudget: z.number().positive(),
  metrics: PipelineMetricsSchema.nullable(),
  layers: z.array(LayerResultSchema),
  // P2: optional context fields
  gsdPhase: z.string().nullable().optional(),
  resumeDigest: z.string().nullable().optional(),
  activeRunId: z.string().nullable().optional(),
  digestAgeMs: z.number().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  complexityTier: z.enum(["quick", "standard", "heavy"]).nullable().optional(),
  complexitySize: z
    .object({
      size: z.enum(["small", "medium", "large"]),
      score: z.number(),
      features: z.record(z.string(), z.union([z.number(), z.boolean()])),
    })
    .nullable()
    .optional(),
  grayAreas: z
    .array(
      z.object({
        dimension: z.enum(["scope", "target", "format", "convention", "depth", "audience"]),
        id: z.string(),
        question: z.string(),
        options: z.array(z.string()),
      }),
    )
    .optional(),
  fallbackReason: z.string().nullable().optional(),
  // Phase 2b: model-decided output deliverable consumed by layer4/layer6.
  deliverableKind: z.enum(["answer", "code", "report"]).nullable().optional(),
  // T1 behavioral rules from EE proven-tier points, injected as mandatory suffix by Layer 6.
  t1Rules: z.array(z.string()).optional(),
  _brainData: z
    .object({
      t0_principles: z.array(z.object({ text: z.string(), score: z.number() })),
      t1_rules: z.array(z.string()),
      t2_patterns: z.array(z.object({ text: z.string(), score: z.number() })),
      retrieval_skipped_reason: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

const ScoredText = z.object({ text: z.string(), score: z.number() });

export const PilContextResponseSchema = z
  .object({
    // Classification
    taskType: TaskTypeSchema.nullable(),
    intentKind: z.enum(["task", "chitchat"]).nullable(),
    outputStyle: OutputStyleSchema,
    confidence: z.number().min(0).max(1),
    domain: z.string().nullable(),

    // GSD routing hint
    gsd_phase: z.enum(["discuss", "execute"]).nullable(),
    gsd_route_source: z.enum(["ee", "preset", "none"]),

    // Experience retrieval
    t0_principles: z.array(ScoredText),
    t1_rules: z.array(z.string()),
    t2_patterns: z.array(ScoredText),
    retrieval_skipped_reason: z.string().nullable(),

    // Meta
    cache_hit: z.boolean(),
    inference_ms: z.number().min(0),
    schema_version: z.string(),
  })
  .passthrough(); // forward-compat: ignore unknown fields from future server versions

export type PilContextResponse = z.infer<typeof PilContextResponseSchema>;
