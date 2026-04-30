/**
 * src/pil/layer1-intent.ts
 *
 * Layer 1: Intent detection using the classifier.
 * Maps classifier reason strings to TaskType values.
 * Fail-open: any classifier error returns ctx with applied=false.
 */

import type { PipelineContext, TaskType } from './types.js';
import { classify } from '../router/classifier/index.js';

const REASON_TO_TASK_TYPE: Record<string, TaskType> = {
  'regex:refactor': 'refactor',
  'regex:edit': 'debug',
  'regex:create-file': 'generate',
  'regex:run-command': 'debug',
  'regex:explain': 'analyze',
  'regex:search': 'analyze',
  'tree-sitter:typescript': 'refactor',
  'tree-sitter:python': 'refactor',
};

export async function layer1Intent(ctx: PipelineContext): Promise<PipelineContext> {
  try {
    const result = classify(ctx.raw);
    const taskType = REASON_TO_TASK_TYPE[result.reason] ?? null;
    return {
      ...ctx,
      taskType,
      layers: [
        ...ctx.layers,
        {
          name: 'intent-detection',
          applied: taskType !== null,
          delta: taskType !== null ? `taskType=${taskType}` : null,
        },
      ],
    };
  } catch {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: 'intent-detection', applied: false, delta: null },
      ],
    };
  }
}
