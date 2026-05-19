/**
 * src/pil/layer6-output.ts
 *
 * Layer 6: Output optimization.
 * Appends a per-task-type system prompt suffix via applyPilSuffix().
 * Each suffix is tuned to minimize output tokens while preserving quality.
 * Conversational turns (taskType=null) pass through unchanged.
 *
 * PIL-03: When ctx.outputStyle is null and ctx.taskType is not null:
 *   a) 50ms brain rescue — classifyViaBrain for multilingual style detection
 *   b) task-type heuristic — domain-specific default when brain is unavailable
 * Resolved style is propagated back onto ctx.outputStyle so the orchestrator
 * picks it up via applyPilSuffix without falling back to the hard "concise" default.
 */

import type { ToolSet } from "ai";
import { classifyViaBrain } from "../ee/bridge.js";
import { buildResponseTools } from "./response-tools.js";
import type { OutputStyle, PipelineContext, TaskType } from "./types.js";

const VALID_STYLES = ["concise", "balanced", "detailed"] as const;

// Per-task-type fallback style when brain is unavailable.
// Reflects the information density each task type genuinely needs.
const TASK_TYPE_DEFAULT_STYLE: Record<TaskType, OutputStyle> = {
  debug: "balanced", // needs root cause + fix context
  plan: "balanced", // balanced by default; user requests detail explicitly
  analyze: "balanced", // findings need brief evidence
  documentation: "balanced", // examples + explanation
  generate: "concise", // code speaks for itself
  refactor: "concise", // diff is the output
  general: "balanced",
};

// PIL-04 Tier 1.1: response-tool gating.
//
// Structural enforcement (JSON schema via tool call) is the root-cause fix for
// cheap-model verbosity: the model CANNOT add preamble/epilogue/padding because
// there is no surface outside the schema to write into. Text-based OUTPUT RULES
// rely on instruction compliance which budget models (DeepSeek/Qwen/Llama)
// frequently ignore.
//
// Activation gate: enable when the schema's payload is bounded enough that JSON
// escaping (\n → \\n, " → \") doesn't outweigh the eliminated padding cost.
//   - analyze: list of findings — repeated keys, no large strings → big win
//   - plan:    numbered steps    — same shape → big win
//   - debug:   {hypothesis, root_cause, fix:{file,diff}, verify} — diff is
//              normally one small hunk, escaping overhead <5%; structural
//              enforcement of the hypothesis→root_cause→fix→verify format is
//              exactly what cheap models drift away from in prose mode
//   - general: {response, reasoning} — pure text, zero structural overhead;
//              this task type has the weakest text suffix today and suffers the
//              most from verbose padding
//
// Disabled (escaping cost dominates):
//   - generate (large file contents in JSON strings)
//   - refactor (multi-file diffs)
//   - documentation (large markdown blocks)
//   - general (plain text; Zod wrapper has no structural benefit, and some
//     models — notably DeepSeek V4 Flash — leak special tokens like
//     <｜DSML｜> into the JSON body, failing Zod validation and triggering
//     retry storms before falling back to text. Skipping the tool wrap for
//     `general` lets the OUTPUT RULES suffix drive plain-text replies
//     directly — same UX, zero parser failures. See session 528ffe653f16
//     for the failure mode this guards against.)
// For these, the orchestrator falls back to the markdown OUTPUT RULES suffix.
const RESPONSE_TOOL_TASK_TYPES = new Set<TaskType>(["analyze", "plan", "debug"]);

// PIL-04 Tier 1.2: per-task output token budget.
// Hint to model. Empirically derived from interaction_logs avg output sizes;
// ~20% below mean to nudge brevity without truncating real answers.
const TASK_OUTPUT_BUDGET: Record<TaskType, number> = {
  refactor: 800,
  debug: 500,
  plan: 700,
  analyze: 600,
  documentation: 900,
  generate: 1200,
  general: 200,
};

// PIL-04 Tier 1.3: ban preamble openers.
// Measured ~30 tokens/turn wasted on "I'll help you...", "Sure, let me..." etc.
// Bilingual EN+VN. Skipped for response-tools path (JSON has no preamble surface).
const NO_PREAMBLE_RULE = `\nFORBIDDEN OPENERS: do not start with "I'll", "I will", "Let me", "Here's", "Sure", "Of course", "Tôi sẽ", "Để tôi", "Vâng". Start directly with the answer content.`;

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

// TODO(WhoAmI-L6): when EE v4.0 Who Am I profile is available, skip
// NO_PREAMBLE_RULE for users with feedback_style="explicit" who prefer
// preamble. Also source TASK_TYPE_DEFAULT_STYLE from profile communication.brevity
// instead of the hardcoded heuristic map above.

export function applyPilSuffix(systemPrompt: string, ctx: PipelineContext, responseToolsActive = false): string {
  // Chitchat: layer6Output already skipped suffix work; mirror that here so
  // direct callers (e.g. orchestrator) don't accidentally re-inject rules.
  if (ctx.intentKind === "chitchat") return systemPrompt;
  if (!ctx.taskType || !SUFFIXES[ctx.taskType]) return systemPrompt;

  if (responseToolsActive) {
    return (
      systemPrompt +
      `\nOUTPUT FORMAT: When you finish your work, use the respond_${ctx.taskType} tool to structure your final answer. You may write free-form text to explain your reasoning during the process. Use action tools (bash, read_file, edit_file, etc.) as needed, then summarize your result via respond_${ctx.taskType}.`
    );
  }

  const style: OutputStyle = ctx.outputStyle ?? "concise";
  const baseSuffix = SUFFIXES[ctx.taskType][style];

  // PIL-04 Tier 1.2: output-budget hint.
  const budget = TASK_OUTPUT_BUDGET[ctx.taskType as TaskType] ?? 600;
  const budgetHint = `\nOUTPUT BUDGET: aim for ≤${budget} tokens. Stop when the answer is complete; do not pad.`;

  // PIL-04 Tier 1.3: ban preamble (~30 tokens saved/turn).
  let result = systemPrompt + baseSuffix + budgetHint + NO_PREAMBLE_RULE;

  // T1 behavioral rules (proven-tier EE points set by Layer 3). These are
  // project-specific reflexes the model MUST follow — injected as instructions,
  // not as context hints, so they carry imperative weight rather than suggestion weight.
  if (ctx.t1Rules && ctx.t1Rules.length > 0) {
    const mandatoryLines = ctx.t1Rules.map((r) => `- ${r}`).join("\n");
    result += `\nMANDATORY RULES (from experience — must follow):\n${mandatoryLines}`;
  }

  return result;
}

export function getResponseToolSet(ctx: PipelineContext): ToolSet {
  if (!ctx.taskType) return {};
  // PIL-04 Tier 1.1: gate JSON-structured output to list-shaped tasks where it
  // wins on tokens. Code-heavy tasks fall through to markdown OUTPUT RULES.
  if (!RESPONSE_TOOL_TASK_TYPES.has(ctx.taskType)) return {};
  return buildResponseTools(ctx.taskType);
}

export async function layer6Output(ctx: PipelineContext): Promise<PipelineContext> {
  try {
    // Chitchat short-circuit: greetings/small-talk don't need OUTPUT RULES
    // suffixes — the model already produces a short reply for "hi" without
    // being told to. Aligns with L4/L5 chitchat skips so the fast-path stays
    // clean end-to-end (no GSD, no context, no suffix, no MCP).
    if (ctx.intentKind === "chitchat") {
      return {
        ...ctx,
        layers: [...ctx.layers, { name: "output-optimization", applied: false, delta: "skip:chitchat" }],
      };
    }

    if (ctx.taskType === null) {
      return {
        ...ctx,
        layers: [...ctx.layers, { name: "output-optimization", applied: false, delta: null }],
      };
    }

    // PIL-03: rescue outputStyle when L1 couldn't determine it (brain timeout / EE disabled).
    let outputStyle = ctx.outputStyle;
    let styleSource = "inherited";

    if (outputStyle === null) {
      // Pass a: 50ms brain rescue — catches multilingual prompts that regex/L1 missed.
      // Skip when ctx._brainData is already populated: L1's unified brain call had its
      // chance to set style; a second classifyViaBrain here is redundant work.
      if (!ctx._brainData) {
        try {
          const brainRaw = await classifyViaBrain(
            `Task type: ${ctx.taskType}. Reply ONE word only: concise | balanced | detailed\nPrompt: "${ctx.raw.slice(0, 150)}"`,
            50,
          );
          if (brainRaw) {
            const matched = VALID_STYLES.find((s) => brainRaw.toLowerCase().includes(s));
            if (matched) {
              outputStyle = matched;
              styleSource = "brain-rescue";
            }
          }
        } catch {
          // fall through to pass b
        }
      }

      // Pass b: task-type heuristic — fires when brain is also unavailable
      if (outputStyle === null) {
        outputStyle = TASK_TYPE_DEFAULT_STYLE[ctx.taskType as TaskType] ?? "concise";
        styleSource = "task-heuristic";
      }
    }

    const style: OutputStyle = outputStyle;
    const taskKey = ctx.taskType as string;
    const suffixEntry = SUFFIXES[taskKey];
    if (!suffixEntry) {
      return {
        ...ctx,
        outputStyle,
        layers: [...ctx.layers, { name: "output-optimization", applied: false, delta: "no-suffix-entry" }],
      };
    }

    const suffix = suffixEntry[style];
    return {
      ...ctx,
      outputStyle, // propagate resolved style to orchestrator's applyPilSuffix
      layers: [
        ...ctx.layers,
        {
          name: "output-optimization",
          applied: true,
          delta: `suffix=${ctx.taskType},style=${style},src=${styleSource},chars=${suffix.trim().length}`,
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
