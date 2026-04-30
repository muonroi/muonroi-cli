/**
 * src/pil/layer2-stub.ts
 *
 * Layer 2: Personality adaptation — stub implementation.
 * TODO Phase X: full implementation (no EE imports in stubs)
 */

import type { PipelineContext } from './types.js';

export async function layer2PersonalityStub(ctx: PipelineContext): Promise<PipelineContext> {
  return {
    ...ctx,
    layers: [
      ...ctx.layers,
      { name: 'personality-adaptation', applied: false, delta: null },
    ],
  };
}
