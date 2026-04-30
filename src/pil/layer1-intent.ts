/**
 * src/pil/layer1-intent.ts
 *
 * Layer 1: Intent detection.
 * Pass 1 — classifier (regex + tree-sitter): maps all 14 possible reason strings to TaskType.
 * Pass 2 — keyword fallback: catches debug/plan/documentation that classifier misses.
 * Populates taskType, confidence, and domain on PipelineContext.
 * Fail-open: any error returns ctx unchanged with applied=false.
 */

import type { PipelineContext, TaskType, OutputStyle } from './types.js';
import { classify } from '../router/classifier/index.js';
import { ollamaClassify } from './ollama-classify.js';

// Maps every classifier reason string to a TaskType (or null for non-coding signals).
const REASON_TO_TASK_TYPE: Partial<Record<string, TaskType>> = {
  'regex:refactor':    'refactor',
  'regex:edit':        'generate',
  'regex:create-file': 'generate',
  'regex:run-command': 'analyze',
  'regex:explain':     'analyze',
  'regex:search':      'analyze',
  'regex:install':     'analyze',
  'tree-sitter:typescript': 'refactor',
  'tree-sitter:python':     'refactor',
  // no-match / error / cold / low-confidence → null (conversational passthrough)
  'regex:no-match':                    undefined,
  'tree-sitter:no-fenced-code':        undefined,
  'tree-sitter:cold':                  undefined,
  'tree-sitter:typescript-parse-error': undefined,
  'tree-sitter:python-parse-error':    undefined,
  'low-confidence':                    undefined,
};

// Keyword patterns for task types the classifier doesn't natively handle.
// Applied only when classifier returns null (low-confidence / no-match).
const KEYWORD_PATTERNS: Array<{ pattern: RegExp; taskType: TaskType; confidence: number }> = [
  {
    pattern: /\b(fix|bug|error|exception|crash|fail(?:s|ed|ing)?|broken|wrong|issue|traceback)\b/i,
    taskType: 'debug',
    confidence: 0.65,
  },
  {
    pattern: /\b(plan|roadmap|phase|step(?:s)?|approach|design|architect(?:ure)?|strategy)\b/i,
    taskType: 'plan',
    confidence: 0.60,
  },
  {
    pattern: /\b(doc(?:s|umentation)?|readme|comment|jsdoc|tsdoc|docstring)\b/i,
    taskType: 'documentation',
    confidence: 0.60,
  },
  {
    pattern: /\b(test(?:s|ing)?|spec|unit test|coverage|assert(?:ion)?)\b/i,
    taskType: 'analyze',
    confidence: 0.65,
  },
];

const DETAIL_KEYWORDS =
  /\b(explain|teach|why\b|how does|what is|learn|understand|deep dive|in detail|elaborate|walk me through|thorough|comprehensive)\b/i;

const CONCISE_KEYWORDS =
  /\b(just|quick(?:ly)?|brief(?:ly)?|short|tl;?dr|one.?liner|fast|simply)\b/i;

function detectOutputStyle(raw: string, taskType: TaskType | null): OutputStyle | null {
  if (taskType === null) return null;
  if (DETAIL_KEYWORDS.test(raw)) return 'detailed';
  if (CONCISE_KEYWORDS.test(raw)) return 'concise';
  return 'balanced';
}

function extractDomain(reason: string): string | null {
  if (reason.includes('typescript')) return 'typescript';
  if (reason.includes('python')) return 'python';
  return null;
}

export async function layer1Intent(ctx: PipelineContext): Promise<PipelineContext> {
  try {
    // Pass 1: classifier
    const result = classify(ctx.raw);
    let taskType: TaskType | null = REASON_TO_TASK_TYPE[result.reason] ?? null;
    let confidence = result.confidence;
    const domain = extractDomain(result.reason);

    // Pass 2: keyword fallback when classifier abstains
    if (taskType === null) {
      for (const { pattern, taskType: kwType, confidence: kwConf } of KEYWORD_PATTERNS) {
        if (pattern.test(ctx.raw)) {
          taskType = kwType;
          confidence = kwConf;
          break;
        }
      }
    }

    // Pass 3: Ollama fallback for ambiguous prompts
    if (taskType === null && confidence < 0.55) {
      const ollamaResult = await ollamaClassify(ctx.raw);
      if (ollamaResult) {
        taskType = ollamaResult.taskType;
        confidence = ollamaResult.confidence;
      }
    }

    const outputStyle = detectOutputStyle(ctx.raw, taskType);

    return {
      ...ctx,
      taskType,
      domain,
      confidence,
      outputStyle,
      layers: [
        ...ctx.layers,
        {
          name: 'intent-detection',
          applied: taskType !== null,
          delta: taskType !== null
            ? `taskType=${taskType},conf=${confidence.toFixed(2)},domain=${domain ?? 'none'},style=${outputStyle ?? 'none'}`
            : null,
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
