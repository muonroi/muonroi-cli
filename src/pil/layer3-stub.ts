/**
 * src/pil/layer3-stub.ts
 *
 * Layer 3: EE experience injection — stub implementation.
 * TODO Phase X: full implementation (no EE imports in stubs)
 */

import type { PipelineContext } from './types.js';

export async function layer3EeInjectionStub(ctx: PipelineContext): Promise<PipelineContext> {
  return {
    ...ctx,
    layers: [
      ...ctx.layers,
      { name: 'ee-experience-injection', applied: false, delta: null },
    ],
  };
}
