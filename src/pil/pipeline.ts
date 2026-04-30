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
import { layer1Intent } from './layer1-intent.js';
import { layer2PersonalityStub } from './layer2-stub.js';
import { layer3EeInjectionStub } from './layer3-stub.js';
import { layer4GsdStructuringStub } from './layer4-stub.js';
import { layer5ContextEnrichmentStub } from './layer5-stub.js';
import { layer6Output } from './layer6-output.js';
import { resolveAfter } from './timeout.js';
import { setPilLastResult } from './store.js';

async function runLayers(ctx: PipelineContext): Promise<PipelineContext> {
  ctx = await layer1Intent(ctx);
  ctx = await layer2PersonalityStub(ctx);
  ctx = await layer3EeInjectionStub(ctx);
  ctx = await layer4GsdStructuringStub(ctx);
  ctx = await layer5ContextEnrichmentStub(ctx);
  ctx = await layer6Output(ctx);
  return ctx;
}

export async function runPipeline(raw: string): Promise<PipelineContext> {
  const fallback: PipelineContext = {
    raw,
    enriched: raw,
    taskType: null,
    domain: null,
    confidence: 0,
    layers: [],
  };
  try {
    const result = await Promise.race([
      runLayers({ ...fallback }),
      resolveAfter(200, fallback),
    ]);
    setPilLastResult(result);
    return result;
  } catch {
    setPilLastResult(fallback);
    return fallback;
  }
}
