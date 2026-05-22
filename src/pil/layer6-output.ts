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
import { getProviderCapabilities } from "../providers/capabilities.js";
import type { ProviderId } from "../providers/types.js";
import { buildResponseTools } from "./response-tools.js";
import type { OutputStyle, PipelineContext, TaskType } from "./types.js";

const VALID_STYLES = ["concise", "balanced", "detailed"] as const;

// Per-task-type fallback style when brain is unavailable.
//
// PIL-L6 verbosity fix — debug/analyze flipped from "balanced" → "concise".
// Users complained about end-of-turn summaries and rambling debug responses.
// "balanced" pads with rationale prose the user can read from the diff/code
// already. "detailed" is reserved for explicit user request ("explain").
const TASK_TYPE_DEFAULT_STYLE: Record<TaskType, OutputStyle> = {
  debug: "concise", // root cause + fix; no padding
  plan: "balanced", // plans genuinely need a brief rationale per step
  analyze: "concise", // bullet findings, no narrative
  documentation: "balanced", // examples + explanation
  generate: "concise", // code speaks for itself
  refactor: "concise", // diff is the output
  general: "concise", // direct answer, no preamble
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
// Disabled at task-type level (escaping cost dominates):
//   - generate (large file contents in JSON strings)
//   - refactor (multi-file diffs)
//   - documentation (large markdown blocks)
// For these, the orchestrator falls back to the markdown OUTPUT RULES suffix.
// Per-PROVIDER disabling is layered on top via ProviderCapabilities — see
// `src/providers/capabilities.ts`. A task type listed here may still be
// dropped at runtime if the active provider's capability returns false.
const RESPONSE_TOOL_TASK_TYPES = new Set<TaskType>(["analyze", "plan", "debug", "general"]);

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

// PIL-04 Tier 1.3 + PIL-L6 verbosity fix: ban preamble AND end-of-turn summary.
// Old rule only covered openers (~30 tok saved). End-of-turn summaries
// ("In summary...", "I have completed X, Y, Z", "Tóm tắt: ...") cost
// 100-300 tokens/turn AND give the user nothing they can't read from the
// diff. Bilingual EN+VN. Skipped for response-tools path (JSON has no
// freeform surface).
const NO_PREAMBLE_RULE = `\nFORBIDDEN OPENERS: do not start with "I'll", "I will", "Let me", "Here's", "Sure", "Of course", "Tôi sẽ", "Để tôi", "Vâng". Start directly with the answer content.\nFORBIDDEN END-OF-TURN SUMMARY: do not append a recap section ("In summary", "To summarize", "Tổng kết", "Tóm tắt", "Tóm lại", "Kết luận", "I have done X, Y, Z", "Now you have…", "Đã hoàn thành…"). The diff and command output already show what changed; the user can read them. End the response when the answer is complete.\nFORBIDDEN INTER-TOOL NARRATION: when chaining tool calls, do NOT emit content text between them. Skip phrases like "Now I'll check…", "Let me look at…", "Next, I need to…", "Tiếp theo tôi sẽ…", "Bây giờ tôi cần…". Emit the next tool call directly. Each round-trip of inter-tool narration costs the user ~100 output tokens that they do not need to read — the tool calls themselves are visible in the UI. Only emit content text for the FINAL answer or when surfacing a decision the user must make.`;

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

  // Action tasks (debug/refactor/generate) override "detailed" → "concise" UNLESS
  // the prompt literally requested detail. Brain/LLM classifiers sometimes
  // return style=detailed for prompts like "fix CI fail" (Vietnamese: "fix lỗi
  // CI") just because the prompt looks ambiguous in isolation — session
  // 127140a47b56 hit this and the model spent 275 LLM calls being "thorough"
  // about a one-liner CI fix.
  const ACTION_TASKS = new Set<TaskType>(["debug", "refactor", "generate"]);
  const DETAIL_KEYWORDS =
    /\b(explain in detail|thorough analysis|walk me through|in depth|deeply|comprehensive)\b|giải thích chi tiết|phân tích kỹ|cặn kẽ|chi tiết hơn/i;
  const requestedStyle: OutputStyle = ctx.outputStyle ?? "concise";
  const style: OutputStyle =
    requestedStyle === "detailed" && ACTION_TASKS.has(ctx.taskType) && !DETAIL_KEYWORDS.test(ctx.raw)
      ? "concise"
      : requestedStyle;
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

export function getResponseToolSet(ctx: PipelineContext, providerId?: ProviderId): ToolSet {
  if (!ctx.taskType) return {};
  // PIL-04 Tier 1.1: gate JSON-structured output to list-shaped tasks where it
  // wins on tokens. Code-heavy tasks fall through to markdown OUTPUT RULES.
  if (!RESPONSE_TOOL_TASK_TYPES.has(ctx.taskType)) return {};
  // Provider-aware gating: a provider may report it can't reliably emit
  // valid JSON tool input for this task type (e.g. DeepSeek leaks special
  // tokens into `general` responses). Drop the tool to avoid retry storms.
  if (providerId) {
    const caps = getProviderCapabilities(providerId);
    if (!caps.supportsResponseTool(ctx.taskType)) return {};
  }
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
