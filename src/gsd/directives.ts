/**
 * src/gsd/directives.ts
 *
 * Builds the system-prompt directive block injected by layer4-gsd. The directive
 * is what actually changes the agent's behaviour: it lists the GSD-style steps
 * the agent must take before touching code.
 *
 * Three tiers:
 *   - heavy:    full discuss → research → verify → plan → impl → verify flow,
 *               with mandatory AskUserQuestion + parallel Agent dispatch.
 *   - standard: GSD-quick mindset — short plan, then implement, then verify.
 *   - quick:    minimal hint, run inline.
 *
 * All directive text is English. The agent is responsible for translating
 * user-facing prompts into the user's language at render time.
 */

import type { ComplexityResult } from "./complexity.js";
import type { GrayAreaQuestion } from "./gray-areas.js";
import type { GsdPhase } from "./types.js";

export interface DirectiveInput {
  complexity: ComplexityResult;
  phase: GsdPhase | null;
  grayAreas: GrayAreaQuestion[];
}

export interface DirectiveOutput {
  text: string;
  tier: ComplexityResult["tier"];
  /** True when the directive forbids the agent from acting before clarifying. */
  blocking: boolean;
}

const HEADER = "[gsd-native]";

function renderGrayAreas(qs: GrayAreaQuestion[]): string {
  if (qs.length === 0) return "  (no gray areas detected — confirm the request is fully specified before proceeding)";
  return qs
    .map((q, idx) => {
      const opts = q.options.map((o, i) => `${i === 0 ? "[recommended]" : "[alt]"} ${o}`).join(" / ");
      return `  ${idx + 1}. (${q.dimension}) ${q.question}\n     options: ${opts}`;
    })
    .join("\n");
}

function buildHeavy(input: DirectiveInput): string {
  const grayBlock = renderGrayAreas(input.grayAreas);
  return [
    `${HEADER} HEAVY task detected (score=${input.complexity.score}, signals=${input.complexity.signals.map((s) => s.tag).join(",") || "none"}).`,
    "MANDATORY flow before any implementation:",
    "  1. DISCUSS — call AskUserQuestion with the gray areas below. Each question MUST include the recommended default first so the user can accept by selecting it.",
    "     Localize question text into the user's language (the language of their last message). Keep options labels English unless they refer to natural-language content.",
    "  2. RESEARCH + VERIFY — once the user answers, dispatch two Agent calls IN PARALLEL in a single message:",
    "       (a) a research agent to gather codebase / external facts needed for the task,",
    "       (b) a verify agent to enumerate acceptance criteria and risks.",
    "     Wait for both before planning.",
    "  3. PLAN — produce a short numbered plan grounded in the research + verify outputs. Confirm the plan with the user only if it diverges from their stated intent.",
    "  4. IMPLEMENT — execute the plan in atomic steps. Prefer parallel Agent dispatch when steps are independent.",
    "  5. VERIFY — run tests / lints / type checks. Report evidence (command + exit code) before claiming done.",
    "Gray areas to clarify in step 1:",
    grayBlock,
    "Do NOT skip steps. Do NOT begin implementation until step 1 is answered.",
  ].join("\n");
}

function buildStandard(input: DirectiveInput): string {
  const phaseHint = input.phase ? ` (detected phase: ${input.phase})` : "";
  // Debug-phase variant: tighten exploration budget. Session 7d56a049e1e3
  // ran 109 tool calls (58 bash + 33 read_file + 16 grep + 2 mcp) over 6
  // minutes WITHOUT a single edit_file / write_file — agent over-researched
  // the CI failure instead of attempting a fix. Add an explicit exploration
  // cap and require committing to a hypothesis early.
  if (input.phase === "debug") {
    return [
      `${HEADER} DEBUG task${phaseHint} — apply GSD-quick mindset, FIX-FIRST.`,
      "Flow:",
      "  1. State a 2-3 line hypothesis (what is failing, your best guess of why) BEFORE reading more than 3 files.",
      "  2. Apply the smallest plausible fix with edit_file / write_file. Do NOT keep exploring — commit to a hypothesis, ship the diff, iterate on failure.",
      "  3. Verify the fix (rerun the failing command / test) and report evidence.",
      "Hard limits — exceed only if a tool result genuinely contradicts your hypothesis:",
      "  - ≤ 8 read_file calls before first edit_file",
      "  - ≤ 5 grep calls before first edit_file",
      "  - ≤ 10 bash log-fetching calls (gh run view, cat log, etc.) before first edit_file",
      "If hard limits are blown and you still have no fix, STOP and report what you tried + why you're stuck. Do NOT keep searching.",
    ].join("\n");
  }
  return [
    `${HEADER} STANDARD task${phaseHint} — apply GSD-quick mindset.`,
    "Flow:",
    "  1. State a 2-3 line plan in your reply.",
    "  2. Implement directly with the appropriate tools.",
    "  3. Verify (tests / type-check / quick smoke) and report evidence.",
    "Skip the discuss/research subagent dance unless a real ambiguity blocks step 1.",
  ].join("\n");
}

function buildQuick(input: DirectiveInput): string {
  const phaseHint = input.phase ? ` phase=${input.phase}` : "";
  return `${HEADER} QUICK task${phaseHint} — handle inline. No plan, no subagents. Make the smallest correct change and report.`;
}

export function buildDirective(input: DirectiveInput): DirectiveOutput {
  switch (input.complexity.tier) {
    case "heavy":
      return { text: buildHeavy(input), tier: "heavy", blocking: true };
    case "standard":
      return { text: buildStandard(input), tier: "standard", blocking: false };
    default:
      return { text: buildQuick(input), tier: "quick", blocking: false };
  }
}
