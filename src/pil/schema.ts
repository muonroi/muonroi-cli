/**
 * src/pil/schema.ts
 *
 * Zod schemas for runtime validation of PIL pipeline output.
 * Used in runPipeline() with safeParse — fail-open on invalid data.
 */

import { z } from 'zod';

export const TaskTypeSchema = z.enum(['refactor', 'debug', 'plan', 'analyze', 'documentation', 'generate']);

export const OutputStyleSchema = z.enum(['concise', 'detailed', 'balanced']);

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
  estimatedTokensSaved: z.number().min(0),
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
});
