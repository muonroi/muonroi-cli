/**
 * src/pil/layer5-stub.ts
 *
 * Layer 5: Context enrichment — stub implementation.
 * TODO Phase X: full implementation (no EE imports in stubs)
 */

import type { PipelineContext } from './types.js';

export async function layer5ContextEnrichmentStub(ctx: PipelineContext): Promise<PipelineContext> {
  return {
    ...ctx,
    layers: [
      ...ctx.layers,
      { name: 'context-enrichment', applied: false, delta: null },
    ],
  };
}
