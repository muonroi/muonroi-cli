/**
 * src/pil/pipeline.ts
 *
 * runPipeline() entry point: orchestrates 6 sequential layers with a 200ms timeout.
 * Fail-open: any unhandled error or timeout returns the original fallback context.
 *
 * CRITICAL: fallback is captured BEFORE runLayers() starts to ensure the timeout
 * path returns a pristine context (Pitfall 4 from RESEARCH.md).
 */

import type { PipelineContext } from './types.js';
import { DEFAULT_TOKEN_BUDGET } from './budget.js';
import { layer1Intent } from './layer1-intent.js';
import { layer2Personality } from './layer2-personality.js';
import { layer3EeInjection } from './layer3-ee-injection.js';
import { layer4GsdStructuringStub } from './layer4-stub.js';
import { layer5ContextEnrichmentStub } from './layer5-stub.js';
import { layer6Output } from './layer6-output.js';
import { resolveAfter } from './timeout.js';
import { setPilLastResult } from './store.js';
import { PipelineContextSchema } from './schema.js';

const SKIPPED_LAYERS = ['personality-adaptation', 'ee-experience-injection', 'gsd-workflow-structuring', 'context-enrichment'];

async function runLayers(ctx: PipelineContext): Promise<PipelineContext> {
  const pipelineStart = Date.now();
  const timings: Array<{ name: string; ms: number }> = [];

  async function timed(name: string, fn: (c: PipelineContext) => Promise<PipelineContext>): Promise<void> {
    const start = Date.now();
    ctx = await fn(ctx);
    timings.push({ name, ms: Date.now() - start });
  }

  await timed('layer1-intent', layer1Intent);

  if (ctx.taskType !== null) {
    await timed('layer2-personality', layer2Personality);
    await timed('layer3-ee-injection', layer3EeInjection);
    await timed('layer4-gsd-structuring', layer4GsdStructuringStub);
    await timed('layer5-context-enrichment', layer5ContextEnrichmentStub);
  } else {
    for (const name of SKIPPED_LAYERS) {
      timings.push({ name: `layer-${name}`, ms: 0 });
    }
    ctx = {
      ...ctx,
      layers: [
        ...ctx.layers,
        ...SKIPPED_LAYERS.map(name => ({ name, applied: false, delta: 'skipped:null-taskType' })),
      ],
    };
  }

  await timed('layer6-output', layer6Output);

  const suffixCharsMatch = ctx.layers.find(l => l.name === 'output-optimization')?.delta?.match(/chars=(\d+)/);
  const suffixChars = suffixCharsMatch ? parseInt(suffixCharsMatch[1], 10) : 0;

  ctx = {
    ...ctx,
    metrics: {
      totalMs: Date.now() - pipelineStart,
      layerTimings: timings,
      inputChars: ctx.raw.length,
      outputChars: ctx.enriched.length,
      estimatedTokensSaved: Math.round(suffixChars / 4),
    },
  };

  return ctx;
}

export async function runPipeline(raw: string): Promise<PipelineContext> {
  const fallback: PipelineContext = {
    raw,
    enriched: raw,
    taskType: null,
    domain: null,
    confidence: 0,
    outputStyle: null,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    metrics: null,
    layers: [],
  };
  try {
    const result = await Promise.race([
      runLayers({ ...fallback }),
      resolveAfter(200, fallback),
    ]);
    const validated = PipelineContextSchema.safeParse(result).success ? result : fallback;
    setPilLastResult(validated);
    return validated;
  } catch {
    setPilLastResult(fallback);
    return fallback;
  }
}
