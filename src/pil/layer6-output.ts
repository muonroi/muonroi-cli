/**
 * src/pil/layer6-output.ts
 *
 * Layer 6: Output optimization.
 * Appends a per-task-type system prompt suffix via applyPilSuffix().
 * Each suffix is tuned to minimize output tokens while preserving quality.
 * Conversational turns (taskType=null) pass through unchanged.
 */

import type { PipelineContext, TaskType } from './types.js';

const SUFFIXES: Record<TaskType, string> = {
  refactor: `
OUTPUT RULES (refactor): Show only changed code. Prefer unified diff or replacement function. No prose unless architecture changes. One sentence max if explanation needed. No preamble.`,

  debug: `
OUTPUT RULES (debug): Format = Hypothesis → Root cause (1 line) → Fix (code only) → Verify command. No preamble. No "I think" hedging.`,

  plan: `
OUTPUT RULES (plan): Numbered steps only. Each step: action verb + acceptance criterion. No prose paragraphs. Add "Assumptions:" section only if needed.`,

  analyze: `
OUTPUT RULES (analyze): Bullet findings with evidence (file:line or direct quote). Add severity label (High/Med/Low) when applicable. No filler sentences.`,

  documentation: `
OUTPUT RULES (documentation): Markdown only. Lead with a code example, then explanation. No "This function..." openers. All examples in fenced code blocks.`,

  generate: `
OUTPUT RULES (generate): Complete, runnable code only. Include all imports. Brief inline comments for non-obvious logic only. No prose outside code blocks. No partial snippets.`,
};

export function applyPilSuffix(systemPrompt: string, ctx: PipelineContext): string {
  if (ctx.taskType === null) return systemPrompt;
  return systemPrompt + SUFFIXES[ctx.taskType];
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
    const suffix = SUFFIXES[ctx.taskType];
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        {
          name: 'output-optimization',
          applied: true,
          delta: `suffix=${ctx.taskType},chars=${suffix.trim().length}`,
        },
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
