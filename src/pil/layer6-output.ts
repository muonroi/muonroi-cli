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

// Broad detector for self-referential / meta / evaluation prompts about the CLI,
// prior turns, or the agent's own behavior. Used to relax brevity rules so full
// answers (with evidence, bullets, file:line) are not suppressed by low budgets
// or NO_PREAMBLE. No model/provider hardcodes — only prompt content signals.
// Exported for early detection in pipeline / orchestrator.
export function isMetaAnalysisPrompt(raw: string): boolean {
  return /đánh giá|phân tích|cải thiện|fix|debug|nhận xét|đánh giá tổng thể|evaluate.*(cli|system|repo)|improve.*(cli|repo)|your assessment|how would you improve|trả lời tự nhiên|natural response|sau fix|phỏng vấn|discovery|native|agent.*inside|cli.*bên trong|context|previous turn|input.*vừa rồi|mù context/i.test(
    raw,
  );
}
const TASK_TYPE_DEFAULT_STYLE: Record<TaskType, OutputStyle> = {
  debug: "concise", // root cause + fix; no padding
  plan: "balanced", // plans genuinely need a brief rationale per step
  analyze: "concise", // bullet findings, no narrative
  documentation: "balanced", // examples + explanation
  generate: "concise", // code speaks for itself
  build: "concise", // greenfield code artifact — code speaks for itself (mirrors generate)
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
  // build (greenfield) emits multiple complete files — same budget as generate.
  build: 1200,
  // general is user-facing prose (not a code artifact). Higher budget + relaxed
  // style rules so the final answer reads naturally for humans instead of
  // machine-optimized telegraphic lists. See user report on over-constrained
  // freetext after Layer 6.
  general: 650,
};

// PIL-04 Tier 1.3 (de-robotized): ban ONLY wasteful openers.
//
// Earlier this rule also banned end-of-turn summaries AND inter-tool narration.
// Both bans were REMOVED: they stripped the natural connective tissue that makes
// an answer read like a human wrote it, which is the root of the "máy móc" /
// telegraphic feel users complained about. Forbidding any recap or any sentence
// between tool calls forces curt, label-prefixed output even when a connecting
// line would help.
//
// Removing the text bans does NOT re-introduce context bloat or user-invisible
// spam:
//   - Inter-tool narration is still removed STRUCTURALLY from message history by
//     stripInterToolNarration() / NARRATION_PREFIX_REGEX in
//     src/orchestrator/reasoning.ts. That runs unconditionally on every assistant
//     message that has both text and a following tool-call, so it is far more
//     reliable than a text directive budget models ignore (session 7dcf8fd7d6a4:
//     57/100 messages violated the text ban anyway).
//   - OUTPUT BUDGET (below) remains the guard against padding, so a freed-up
//     summary cannot balloon the answer.
//
// Openers ("I'll", "Let me", "Sure", "Tôi sẽ") stay banned: pure ~30-tok padding
// with zero conversational value. Bilingual EN+VN. Skipped for the response-tools
// path (JSON has no freeform surface).
const NO_PREAMBLE_RULE = `\nFORBIDDEN OPENERS: do not start with "I'll", "I will", "Let me", "Here's", "Sure", "Of course", "Tôi sẽ", "Để tôi", "Vâng". Start directly with the answer content.`;

// Anti-bookkeeping note for the NATURAL (non-response-tool) path — the response-
// tool path has the equivalent baked into humanNote. The Agent Operating Contract's
// REPORTING rule ("every fact must come from THIS turn; do not infer unopened
// files") is the model's operating discipline, but budget models RESTATE it as a
// user-facing provenance footer ("evidence only from this turn", "did not infer
// unopened files", "≤600 tokens"). That is invisible-to-the-reader compliance
// noise. Applied only to non-question turns — question turns already get the same
// guidance from the Layer 4 QUESTION directive (buildQuestion).
const NO_BOOKKEEPING_NOTE = `\nWRITE FOR THE READER: the answer is for the human who asked. Do NOT append a provenance / compliance footer (e.g. "evidence only from this turn", "did not infer unopened files", token-budget notes) and do NOT restate internal rule / contract / layer / tool names as compliance — those are your operating rules, invisible to the reader. End on the answer's last substantive point.`;

const SUFFIXES: Record<string, Record<OutputStyle, string>> = {
  refactor: {
    concise: `\nOUTPUT RULES (refactor): Show only changed code. Prefer unified diff or replacement function. No prose unless architecture changes. One sentence max if explanation needed. No preamble.`,
    balanced: `\nOUTPUT RULES (refactor): Show changed code with brief rationale. Unified diff preferred. Short explanation allowed when architecture changes. Keep prose under 3 sentences.`,
    detailed: `\nOUTPUT RULES (refactor): Show changed code with full rationale. Explain why each change improves the code. Include before/after comparison when helpful. Unified diff preferred.`,
  },
  debug: {
    concise: `\nOUTPUT RULES (debug): Lead with the root cause and the fix (code). Bring in the hypothesis and a verify command where they add value — you don't have to label every part or follow a fixed template. Be direct; skip "I think"/"maybe" hedging.`,
    balanced: `\nOUTPUT RULES (debug): Give the root cause and the fix (code), with a short note on why the bug happens and how to verify it. Write it naturally — no rigid section labels needed.`,
    detailed: `\nOUTPUT RULES (debug): Walk through the root cause, the fix (code), how to verify, and how to prevent recurrence. Explain the underlying mechanism so the reader understands why the fix is correct.`,
  },
  plan: {
    concise: `\nOUTPUT RULES (plan): Use numbered steps; each step should make the action and its done-criterion clear. A short framing sentence is fine when it helps — just skip filler. Note key assumptions if any matter.`,
    balanced: `\nOUTPUT RULES (plan): Use numbered steps, each with its action, done-criterion, and a brief why. Add "Assumptions:" or "Risks:" notes when they matter. A short lead-in sentence is welcome.`,
    detailed: `\nOUTPUT RULES (plan): Numbered steps with full rationale — action, done-criterion, why, and alternatives considered. Include "Assumptions:", "Risks:", and "Trade-offs:" where relevant.`,
  },
  analyze: {
    concise: `\nOUTPUT RULES (analyze): Present findings as bullets, each backed by evidence (file:line or a direct quote). Add a severity label (High/Med/Low) where it helps prioritize. A brief lead-in is fine — just avoid padding.`,
    balanced: `\nOUTPUT RULES (analyze): Present findings as bullets with evidence (file:line or quote), a severity label, and a brief explanation. Give enough context for each finding to stand on its own.`,
    detailed: `\nOUTPUT RULES (analyze): Present findings as bullets with evidence (file:line or quote), severity, root-cause, and a recommended action. Include context and impact for each finding.`,
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
  build: {
    concise: `\nOUTPUT RULES (build): Scaffold the minimum runnable project/feature. Emit complete files (all imports), matching existing conventions. Wire it end-to-end; do not leave stubs. State the verify/run command in one line. No speculative extras.`,
    balanced: `\nOUTPUT RULES (build): Scaffold a runnable project/feature with a short rationale for the structure. Emit complete files, follow existing conventions, wire it end-to-end, and give the build/run command. Avoid speculative features.`,
    detailed: `\nOUTPUT RULES (build): Scaffold a runnable project/feature with full rationale — layout, key dependencies, and design choices. Emit complete files with all imports, wire everything end-to-end, give the build/run + verify commands. Note trade-offs; skip speculative scope.`,
  },
  general: {
    // General answers should be highly readable. Encourage rich markdown
    // (bullets, headings, bold text) instead of forcing dense prose.
    concise: `\nAnswer directly. Use markdown, bullet points, and code blocks to make the output highly readable and scannable. Avoid dense paragraphs.`,
    balanced: `\nAnswer with helpful context. Structure your response using markdown headings, bullet points, and code blocks for excellent readability. Avoid dense walls of text.`,
    detailed: `\nAnswer thoroughly. Use rich markdown structure (headings, lists, bold text, code blocks) to organize complex information so it is easy to scan and read.`,
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
    const isMeta = isMetaAnalysisPrompt(ctx.raw);
    const metaNote = isMeta
      ? " This is a meta/evaluation question about the system or prior turns — the `response` field MUST contain the complete, unshortened answer with all evidence and detail."
      : "";
    const finalAnswerNote =
      ctx.taskType === "general"
        ? " Structure your `response` with rich markdown formatting (headings, bullet points, bold text, code blocks). Make it highly readable, scannable, and clearly organized. Avoid dense walls of text (freetext)."
        : "";
    // Human-UX guard for question/meta turns. Without it the model narrates its
    // OWN process into the user-facing answer — a "2-3 line plan" preamble, "per
    // contract 2/5/7", "emit respond_general", "all facts come only from
    // this-turn reads" (session 829a83888dd2). The reader is a human who asked a
    // question, not an agent auditing compliance.
    const humanNote =
      isMeta || ctx.taskType === "general"
        ? " Write the `response` for the HUMAN who asked: lead with the answer. Do NOT include an implementation plan, do NOT narrate your own process, and do NOT restate internal rule/tool/layer names (contract rules, respond_* , layer6, native:NN) as compliance — cite a file:line only where it directly backs a claim. Do NOT append an evidence-provenance footer or a disclaimer that your facts come only from this turn / that you did not infer unopened files — that is internal contract bookkeeping, invisible to the reader: end on the answer's last substantive point."
        : "";
    return (
      systemPrompt +
      `\nOUTPUT FORMAT: When you finish your work, use the respond_${ctx.taskType} tool to structure your final answer. You may write free-form text to explain your reasoning during the process. Use action tools (bash, read_file, edit_file, etc.) as needed, then deliver the COMPLETE, FULL answer (do not summarize, shorten, or truncate for token budgets) via respond_${ctx.taskType}.${metaNote}${finalAnswerNote}${humanNote}`
    );
  }

  // Action tasks (debug/refactor/generate) override "detailed" → "concise" UNLESS
  // the prompt literally requested detail. Brain/LLM classifiers sometimes
  // return style=detailed for prompts like "fix CI fail" (Vietnamese: "fix lỗi
  // CI") just because the prompt looks ambiguous in isolation — session
  // 127140a47b56 hit this and the model spent 275 LLM calls being "thorough"
  // about a one-liner CI fix.
  const ACTION_TASKS = new Set<TaskType>(["debug", "refactor", "generate", "build"]);
  const DETAIL_KEYWORDS =
    /\b(explain in detail|thorough analysis|walk me through|in depth|deeply|comprehensive)\b|giải thích chi tiết|phân tích kỹ|cặn kẽ|chi tiết hơn/i;
  const requestedStyle: OutputStyle = ctx.outputStyle ?? "concise";
  const style: OutputStyle =
    requestedStyle === "detailed" && ACTION_TASKS.has(ctx.taskType) && !DETAIL_KEYWORDS.test(ctx.raw)
      ? "concise"
      : requestedStyle;
  const baseSuffix = SUFFIXES[ctx.taskType][style];

  // PIL-04 Tier 1.2: output-budget hint.
  // For response-tool turns or meta-analysis (self-eval of CLI, prior context, "mù context" etc.),
  // raise budget and skip aggressive "do not pad / no summary" so full evidence-rich answers
  // reach the respond_* payload and the user. Before: meta follow-ups often produced only
  // short "**Đã trả lời xong**" confirmations even when detailed analysis was prepared in the tool.
  // After: explicit "COMPLETE, FULL" instruction + higher budget + isMetaAnalysisPrompt gate.
  const isMetaAnalysis = isMetaAnalysisPrompt(ctx.raw);
  const useHighBudget = responseToolsActive || isMetaAnalysis;
  const budget = useHighBudget ? 1800 : (TASK_OUTPUT_BUDGET[ctx.taskType as TaskType] ?? 600);
  const budgetHint = useHighBudget
    ? `\nOUTPUT BUDGET: provide the complete answer required by the task (analysis/meta may legitimately need 800-1500+ tokens for evidence and bullets). Stop only when the full user-visible content is delivered; do not artificially shorten.`
    : `\nOUTPUT BUDGET: aim for ≤${budget} tokens. Stop when the answer is complete; do not pad.`;

  // PIL-04 Tier 1.3: ban preamble (~30 tokens saved/turn).
  // Relax for meta-analysis / evaluation (including follow-ups about previous turns or CLI behavior).
  // The isMetaAnalysisPrompt (hoisted early) is the single source of truth and already includes
  // signals like "cli.*bên trong", "mù context", "input.*vừa rồi", "previous turn".
  const effectiveStyle =
    isMetaAnalysis && (ctx.taskType === "general" || ctx.taskType === "analyze") ? "balanced" : style;
  const effectiveSuffix = SUFFIXES[ctx.taskType]?.[effectiveStyle] || baseSuffix;

  let result = systemPrompt + effectiveSuffix + budgetHint;
  if (!isMetaAnalysis && !responseToolsActive) {
    result += NO_PREAMBLE_RULE;
  }
  // E — keep the contract's REPORTING discipline from leaking into the answer as a
  // provenance/compliance footer. Skip question turns (the L4 QUESTION directive
  // already says it) to avoid duplicate steering.
  if (!isQuestionLike(ctx.raw)) {
    result += NO_BOOKKEEPING_NOTE;
  }

  // T1 behavioral rules (proven-tier EE points set by Layer 3). These are
  // project-specific reflexes the model MUST follow — injected as instructions,
  // not as context hints, so they carry imperative weight rather than suggestion weight.
  if (ctx.t1Rules && ctx.t1Rules.length > 0) {
    const mandatoryLines = ctx.t1Rules.map((r) => `- ${r}`).join("\n");
    result += `\nMANDATORY RULES (from experience — must follow):\n${mandatoryLines}`;
  }

  return result;
}

/**
 * Detect an explicit IMPLEMENTATION / edit-the-files intent. When the user asks
 * to implement/edit/refactor (the deliverable is file changes, not a structured
 * report), a terminal `respond_<task>` tool is inappropriate: the model can call
 * it mid-task to "state a plan/answer" and the turn then winds down before the
 * edits are finished. Live (grok session 19fa8895c41c): an "Improve … implement
 * these fixes" prompt was classified `debug`, so `respond_debug` was offered; the
 * model called it after reading the files, made a few edits, then stopped — the
 * HTML was never wired. Dropping the tool just falls through to the markdown
 * OUTPUT RULES (graceful — exactly what code-heavy tasks already do), so a false
 * positive on an analysis turn only forgoes structured JSON, never breaks output.
 *
 * High-signal verbs only (implement/edit/wire/rewrite/rename/scaffold/refactor,
 * "make the change", "apply the fix/patch", VI equivalents). Bare "fix"/"replace"
 * are excluded — too common in analysis ("explain the fix") — so pure
 * analyze/plan/debug-investigation turns keep their structured output.
 */
const IMPLEMENTATION_INTENT_RE =
  /\b(implement|edit|wire(?:\s+up)?|rewrite|rename|scaffold|refactor)\b|\bmake\s+(the\s+)?(change|edit|modification)s?\b|\bapply\s+(the\s+)?(fix|change|patch|edit|diff)\b|(?:^|\s)(triển\s*khai|trien\s*khai|chỉnh\s*sửa|chinh\s*sua|viết\s*lại|viet\s*lai|đổi\s*tên|doi\s*ten)\b/i;

export function isImplementationIntent(raw: string): boolean {
  return !!raw && IMPLEMENTATION_INTENT_RE.test(raw);
}

/**
 * Narrow response-tool gating (user-directed de-robotizing).
 *
 * For debug / analyze / plan the structured respond_* tool forces the answer into
 * a rigid JSON schema (DebugSchema {hypothesis, root_cause, fix, verify}, etc.)
 * which the UI then stamps with fixed labels ("hypothesis:", "root cause:",
 * "[HIGH]", "done when:") in structured-response-view.tsx. For an ordinary
 * QUESTION ("why does X fail?", "analyze the auth design") that reads robotic and
 * even forces fabricated fields (DebugSchema.fix.file is required, so a
 * non-codebase debug question must invent a file). So these task types now
 * default to the NATURAL markdown path (softened OUTPUT RULES + openers-only
 * NO_PREAMBLE) and only opt INTO the structured tool when the prompt's DELIVERABLE
 * is genuinely a report / list / plan.
 *
 * Conservative positive gate (defaults to natural): only an explicit
 * report/list/plan signal keeps respond_*. EN + VI. `general` is exempt — its
 * renderer already shows plain markdown, so respond_general carries no robotic
 * cost while still giving budget models a structural anchor.
 */
const STRUCTURED_REPORT_RE =
  /\b(lists?|enumerate|table|report|audit|checklist|inventory|rank(?:ed|ing)?|prioriti[sz]e[ds]?|roadmap|step[-\s]?by[-\s]?step|milestones?|plan(?:s|ning)?)\b|liệt\s*kê|danh\s*sách|bảng|báo\s*cáo|kiểm\s*toán|rà\s*soát|lộ\s*trình|từng\s*bước|các\s*bước|kế\s*hoạch|xếp\s*hạng|ưu\s*tiên/i;

// Question-shape detector — shared by Layer 4 (GSD directive selection) and the
// narrow response-tool gate below. True when the prompt reads as a question or
// explanatory request rather than an imperative deliverable. Interrogative words
// only count at sentence start (so "list the steps" is NOT a question), plus
// "can/could/would/should + pronoun", a trailing "?", and VI markers. EN + VI.
const QUESTION_SHAPE_RE =
  /^\s*(?:why|how|what|when|where|who|whom|whose|which|explain|describe)\b|\b(?:can|could|would|should)\s+(?:you|i|we|it|they)\b|\?\s*$|tại\s*sao|vì\s*sao|(?:như\s*)?thế\s*nào|là\s*gì|ra\s*sao|ở\s*đâu|khi\s*nào|bao\s*nhiêu|có\s*phải|giải\s*thích|mô\s*tả/i;

export function isQuestionLike(raw: string): boolean {
  return !!raw && QUESTION_SHAPE_RE.test(raw);
}

export function prefersStructuredReport(raw: string): boolean {
  if (!raw) return false;
  // A question that merely mentions "plan"/"list" — e.g. an interview quoting the
  // phrase "state a 2-3 line plan" — must NOT be treated as a report request; it
  // stays on the natural markdown path. Genuine delivery requests ("plan the
  // migration", "list all X") are imperative, not question-shaped.
  if (isQuestionLike(raw)) return false;
  return STRUCTURED_REPORT_RE.test(raw);
}

export function getResponseToolSet(ctx: PipelineContext, providerId?: ProviderId): ToolSet {
  if (!ctx.taskType) return {};
  // Chitchat: greetings/small-talk never want a structured answer block. Mirrors
  // the chitchat short-circuits in applyPilSuffix / layer6Output.
  if (ctx.intentKind === "chitchat") return {};
  // PIL-04 Tier 1.1: gate JSON-structured output to list-shaped tasks where it
  // wins on tokens. Code-heavy tasks fall through to markdown OUTPUT RULES.
  if (!RESPONSE_TOOL_TASK_TYPES.has(ctx.taskType)) return {};
  // Implementation/edit turns: the deliverable is file changes, not a structured
  // report. A terminal respond_<task> tool lets the model "answer" (state a plan)
  // and end the turn before the edits complete — drop it for clear edit intent.
  if (isImplementationIntent(ctx.raw)) return {};
  // Narrow gating (de-robotizing): debug/analyze/plan QUESTIONS use the natural
  // markdown path; reserve the labeled respond_* tool for explicit report/list/
  // plan requests. `general` keeps its (naturally-rendered) response tool.
  if (ctx.taskType !== "general" && !prefersStructuredReport(ctx.raw)) return {};
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

// isMetaAnalysisPrompt is defined early (near top) and exported for use by
// pipeline, orchestrator, and other layers to relax rules for reflective turns.
