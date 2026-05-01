/**
 * src/pil/layer6-output.ts
 *
 * Layer 6: Output optimization.
 * Appends a per-task-type system prompt suffix via applyPilSuffix().
 * Each suffix is tuned to minimize output tokens while preserving quality.
 * Conversational turns (taskType=null) pass through unchanged.
 */

import type { OutputStyle, PipelineContext, TaskType } from "./types.js";

const SUFFIXES: Record<TaskType, Record<OutputStyle, string>> = {
  refactor: {
    concise: `\nOUTPUT RULES (refactor): Show only changed code. Prefer unified diff or replacement function. No prose unless architecture changes. One sentence max if explanation needed. No preamble.`,
    balanced: `\nOUTPUT RULES (refactor): Show changed code with brief rationale. Unified diff preferred. Short explanation allowed when architecture changes. Keep prose under 3 sentences.`,
    detailed: `\nOUTPUT RULES (refactor): Show changed code with full rationale. Explain why each change improves the code. Include before/after comparison when helpful. Unified diff preferred.`,
  },
  debug: {
    concise: `\nOUTPUT RULES (debug): Format = Hypothesis → Root cause (1 line) → Fix (code only) → Verify command. No preamble. No "I think" hedging.`,
    balanced: `\nOUTPUT RULES (debug): Format = Hypothesis → Root cause → Fix (code) → Verify command. Brief explanation of why the bug occurs. Keep prose minimal.`,
    detailed: `\nOUTPUT RULES (debug): Format = Hypothesis → Root cause analysis → Fix (code) → Verify command → Prevention. Explain the underlying mechanism and why this fix is correct.`,
  },
  plan: {
    concise: `\nOUTPUT RULES (plan): Numbered steps only. Each step: action verb + acceptance criterion. No prose paragraphs. Add "Assumptions:" section only if needed.`,
    balanced: `\nOUTPUT RULES (plan): Numbered steps with brief rationale per step. Each step: action verb + acceptance criterion + why. Add "Assumptions:" and "Risks:" sections if applicable.`,
    detailed: `\nOUTPUT RULES (plan): Numbered steps with full rationale. Each step: action verb + acceptance criterion + why + alternatives considered. Include "Assumptions:", "Risks:", and "Trade-offs:" sections.`,
  },
  analyze: {
    concise: `\nOUTPUT RULES (analyze): Bullet findings with evidence (file:line or direct quote). Add severity label (High/Med/Low) when applicable. No filler sentences.`,
    balanced: `\nOUTPUT RULES (analyze): Bullet findings with evidence (file:line or direct quote). Add severity label and brief explanation. Context for each finding.`,
    detailed: `\nOUTPUT RULES (analyze): Bullet findings with evidence (file:line or direct quote). Add severity label, root cause analysis, and recommended action. Provide context and impact assessment.`,
  },
  documentation: {
    concise: `\nOUTPUT RULES (documentation): Markdown only. Lead with a code example, then explanation. No "This function..." openers. All examples in fenced code blocks.`,
    balanced: `\nOUTPUT RULES (documentation): Markdown only. Lead with a code example, then explanation with context. Cover common use cases. All examples in fenced code blocks.`,
    detailed: `\nOUTPUT RULES (documentation): Markdown only. Lead with a code example, then thorough explanation. Cover use cases, edge cases, and gotchas. All examples in fenced code blocks. Include parameter descriptions and return value explanations.`,
  },
  generate: {
    concise: `\nOUTPUT RULES (generate): Complete, runnable code only. Include all imports. Brief inline comments for non-obvious logic only. No prose outside code blocks. No partial snippets.`,
    balanced: `\nOUTPUT RULES (generate): Complete, runnable code with brief explanation. Include all imports. Inline comments for key decisions. Short prose before code block explaining approach.`,
    detailed: `\nOUTPUT RULES (generate): Complete, runnable code with full explanation. Include all imports. Inline comments for logic and decisions. Explain design choices, alternatives considered, and trade-offs before the code.`,
  },
};

export function applyPilSuffix(systemPrompt: string, ctx: PipelineContext): string {
  if (ctx.taskType === null) return systemPrompt;
  const style: OutputStyle = ctx.outputStyle ?? "concise";
  return systemPrompt + SUFFIXES[ctx.taskType][style];
}

export async function layer6Output(ctx: PipelineContext): Promise<PipelineContext> {
  try {
    if (ctx.taskType === null) {
      return {
        ...ctx,
        layers: [...ctx.layers, { name: "output-optimization", applied: false, delta: null }],
      };
    }
    const style: OutputStyle = ctx.outputStyle ?? "concise";
    const suffix = SUFFIXES[ctx.taskType][style];
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        {
          name: "output-optimization",
          applied: true,
          delta: `suffix=${ctx.taskType},style=${style},chars=${suffix.trim().length}`,
        },
      ],
    };
  } catch {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "output-optimization", applied: false, delta: null }],
    };
  }
}
