/**
 * src/pil/layer1-intent.ts
 *
 * Layer 1: Intent detection.
 * Pass 1 — classifier (regex + tree-sitter): maps all 14 possible reason strings to TaskType.
 * Pass 2 — keyword fallback: catches debug/plan/documentation that classifier misses.
 * Pass 3 — EE brain fallback via bridge.classifyViaBrain (replaces ollamaClassify).
 * Populates taskType, confidence, and domain on PipelineContext.
 * outputStyle is always null from Layer 1 — Layer 6 handles output style detection via bridge.
 * Fail-open: any error returns ctx unchanged with applied=false.
 */

import { classify } from "../router/classifier/index.js";
import { classifyViaBrain } from "../ee/bridge.js";
import type { PipelineContext, TaskType } from "./types.js";

// Maps every classifier reason string to a TaskType (or null for non-coding signals).
const REASON_TO_TASK_TYPE: Partial<Record<string, TaskType>> = {
  "regex:refactor": "refactor",
  "regex:edit": "generate",
  "regex:create-file": "generate",
  "regex:run-command": "analyze",
  "regex:explain": "analyze",
  "regex:search": "analyze",
  "regex:install": "analyze",
  "tree-sitter:typescript": "refactor",
  "tree-sitter:python": "refactor",
  // no-match / error / cold / low-confidence → null (conversational passthrough)
  "regex:no-match": undefined,
  "tree-sitter:no-fenced-code": undefined,
  "tree-sitter:cold": undefined,
  "tree-sitter:typescript-parse-error": undefined,
  "tree-sitter:python-parse-error": undefined,
  "low-confidence": undefined,
};

// Keyword patterns for task types the classifier doesn't natively handle.
// Applied only when classifier returns null (low-confidence / no-match).
const KEYWORD_PATTERNS: Array<{ pattern: RegExp; taskType: TaskType; confidence: number }> = [
  {
    pattern: /\b(fix|bug|error|exception|crash|fail(?:s|ed|ing)?|broken|wrong|issue|traceback)\b/i,
    taskType: "debug",
    confidence: 0.65,
  },
  {
    pattern: /\b(plan|roadmap|phase|step(?:s)?|approach|design|architect(?:ure)?|strategy)\b/i,
    taskType: "plan",
    confidence: 0.6,
  },
  {
    pattern: /\b(doc(?:s|umentation)?|readme|comment|jsdoc|tsdoc|docstring)\b/i,
    taskType: "documentation",
    confidence: 0.6,
  },
  {
    pattern: /\b(test(?:s|ing)?|spec|unit test|coverage|assert(?:ion)?)\b/i,
    taskType: "analyze",
    confidence: 0.65,
  },
];

// Valid task types for bridge classification parsing (matches RESPONSE_SCHEMAS keys minus 'general').
const VALID_TASK_TYPES: TaskType[] = ["refactor", "debug", "plan", "analyze", "documentation", "generate"];

function extractDomain(reason: string): string | null {
  if (reason.includes("typescript")) return "typescript";
  if (reason.includes("python")) return "python";
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

    // Pass 3: EE brain fallback (replaces ollamaClassify)
    if (taskType === null && confidence < 0.55) {
      const brainRaw = await classifyViaBrain(
        `Classify into one of: refactor, debug, plan, analyze, documentation, generate, or none. Reply ONLY with the category name.\n\nPrompt: "${ctx.raw.slice(0, 500)}"`,
        100, // 100ms timeout — matches EE_TIMEOUT_MS
      );
      if (brainRaw) {
        const matched = VALID_TASK_TYPES.find(t => brainRaw.toLowerCase().includes(t));
        if (matched) {
          taskType = matched;
          confidence = 0.55;
        }
      }
    }

    // outputStyle is always null from Layer 1 — Layer 6 handles output style via bridge
    const outputStyle = null;

    return {
      ...ctx,
      taskType,
      domain,
      confidence,
      outputStyle,
      layers: [
        ...ctx.layers,
        {
          name: "intent-detection",
          applied: taskType !== null,
          delta:
            taskType !== null
              ? `taskType=${taskType},conf=${confidence.toFixed(2)},domain=${domain ?? "none"}`
              : null,
        },
      ],
    };
  } catch {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "intent-detection", applied: false, delta: null }],
    };
  }
}
