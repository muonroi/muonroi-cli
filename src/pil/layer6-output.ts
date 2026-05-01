/**
 * src/pil/layer6-output.ts
 *
 * Layer 6: Output optimization.
 * Appends a per-task-type system prompt suffix via applyPilSuffix().
 * Each suffix is tuned to minimize output tokens while preserving quality.
 * Conversational turns (taskType=null) pass through unchanged.
 *
 * PIL-03: When ctx.outputStyle is null and ctx.taskType is not null,
 * calls classifyViaBrain with a 50ms timeout for multilingual output style
 * detection (Vietnamese+code mix that regex cannot handle). Fail-open:
 * if brain returns null/timeout, ctx.outputStyle stays null.
 */

import type { ToolSet } from "ai";
import type { OutputStyle, PipelineContext } from "./types.js";
import { buildResponseTools } from "./response-tools.js";

const SUFFIXES: Record<string, Record<OutputStyle, string>> = {
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
  general: {
    concise: `\nAnswer directly. No preamble.`,
    balanced: `\nAnswer with brief context.`,
    detailed: `\nAnswer thoroughly.`,
  },
};

export function applyPilSuffix(systemPrompt: string, ctx: PipelineContext, responseToolsActive = false): string {
  if (!ctx.taskType || !SUFFIXES[ctx.taskType]) return systemPrompt;
  if (responseToolsActive) {
    return (
      systemPrompt +
      `\nOUTPUT FORMAT: Use the respond_${ctx.taskType} tool to structure your final response. Do NOT write free-form text for your answer — use the tool's structured fields. You may still use action tools (bash, read_file, edit_file, etc.) during your work, but your final answer MUST go through respond_${ctx.taskType}.`
    );
  }
  const style: OutputStyle = ctx.outputStyle ?? "concise";
  return systemPrompt + SUFFIXES[ctx.taskType][style];
}

export function getResponseToolSet(ctx: PipelineContext): ToolSet {
  if (!ctx.taskType) return {};
  return buildResponseTools(ctx.taskType);
}

export async function layer6Output(ctx: PipelineContext): Promise<PipelineContext> {
  try {
    if (ctx.taskType === null) {
      return {
        ...ctx,
        layers: [...ctx.layers, { name: "output-optimization", applied: false, delta: null }],
      };
    }

    // Style already resolved by L1 (brain detection) + L2 (config fallback)
    const style: OutputStyle = ctx.outputStyle ?? "concise";

    const taskKey = ctx.taskType as string;
    const suffixEntry = SUFFIXES[taskKey];
    if (!suffixEntry) {
      return {
        ...ctx,
        layers: [...ctx.layers, { name: "output-optimization", applied: false, delta: "no-suffix-entry" }],
      };
    }

    const suffix = suffixEntry[style];
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
