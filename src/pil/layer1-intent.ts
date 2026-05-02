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
import type { OutputStyle, PipelineContext, TaskType } from "./types.js";

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
  "regex:read": "analyze",
  "regex:git": "analyze",
  "regex:short-message": undefined,
  "regex:design": "plan",
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

const VALID_STYLES = ["concise", "balanced", "detailed"] as const;

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

    // Pass 3: EE brain fallback — detect taskType AND outputStyle in one call
    let outputStyle: OutputStyle | null = null;
    if (taskType === null && confidence < 0.55) {
      const brainRaw = await classifyViaBrain(
        `Classify this prompt. Reply with TWO words separated by comma: <category>,<style>
Category: refactor, debug, plan, analyze, documentation, generate, or none
Style: concise, balanced, or detailed

Prompt: "${ctx.raw.slice(0, 500)}"`,
        100,
      );
      if (brainRaw) {
        const lower = brainRaw.toLowerCase();
        const matched = VALID_TASK_TYPES.find(t => lower.includes(t));
        if (matched) {
          taskType = matched;
          confidence = 0.55;
        }
        const styleMatched = VALID_STYLES.find(s => lower.includes(s));
        if (styleMatched) outputStyle = styleMatched;
      }
    }

    // If brain didn't run (classifier handled taskType), still try quick style detection
    if (outputStyle === null && taskType !== null) {
      const brainRaw = await classifyViaBrain(
        `Return ONE word: concise, balanced, or detailed.\n\nPrompt: "${ctx.raw.slice(0, 300)}"`,
        50,
      );
      if (brainRaw) {
        const styleMatched = VALID_STYLES.find(s => brainRaw.toLowerCase().includes(s));
        if (styleMatched) outputStyle = styleMatched;
      }
    }

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
              ? `taskType=${taskType},conf=${confidence.toFixed(2)},domain=${domain ?? "none"},style=${outputStyle ?? "none"}`
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
