/**
 * src/pil/layer4-stub.ts
 *
 * Layer 4: GSD workflow structuring — stub implementation.
 * TODO Phase X: full implementation (no EE imports in stubs)
 */

import type { PipelineContext } from './types.js';

export async function layer4GsdStructuringStub(ctx: PipelineContext): Promise<PipelineContext> {
  return {
    ...ctx,
    layers: [
      ...ctx.layers,
      { name: 'gsd-workflow-structuring', applied: false, delta: null },
    ],
  };
}
