/**
 * src/pil/layer6-output.ts
 *
 * Layer 6: Output optimization.
 * Applies structured output rules suffix to system prompts for coding tasks.
 * applyPilSuffix() is called by the orchestrator at prompt assembly time.
 */

import type { PipelineContext } from './types.js';

const OUTPUT_SUFFIX_CODING = `

OUTPUT RULES (strict):
- Be extremely concise. No filler, no preamble, no meta-commentary.
- Use bullet points and code blocks. Prefer tool calls over prose.
- Never say "I cannot", "As an AI", "I apologize", or start with "Certainly".
- If a code change is needed, output only the diff or the changed function.
- Prefer structured output (Tool Calling) over free-form text for all coding tasks.`;

export function applyPilSuffix(systemPrompt: string, ctx: PipelineContext): string {
  if (ctx.taskType === null) return systemPrompt;
  return systemPrompt + OUTPUT_SUFFIX_CODING;
}

export async function layer6Output(ctx: PipelineContext): Promise<PipelineContext> {
  try {
    if (ctx.taskType === null) {
      return {
        ...ctx,
        layers: [
          ...ctx.layers,
          { name: 'output-optimization', applied: false, delta: null },
        ],
      };
    }
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: 'output-optimization', applied: true, delta: 'output-optimization-applied' },
      ],
    };
  } catch {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: 'output-optimization', applied: false, delta: null },
      ],
    };
  }
}
