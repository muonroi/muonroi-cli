/**
 * src/playbook/directives.ts
 *
 * Builds the system-prompt directive block injected per turn by layer4
 * (`src/pil/layer4-gsd.ts`). The directive is what actually changes the agent's
 * behaviour: it injects a HYBRID rubric for the work-depth tier the model chose
 * — the system recommends a depth, the agent declares its path and may
 * escalate/de-escalate. This is the "[playbook]" mindset layer (NOT the real
 * GSD framework / `/gsd:*` skills — it only borrows the discuss→plan→execute
 * mindset).
 *
 * Three tiers:
 *   - heavy:    discuss → research → plan → check-plan → implement → verify.
 *   - standard: short plan → check → implement → verify.
 *   - quick:    minimal hint, run inline.
 *
 * All directive text is English. The agent is responsible for translating
 * user-facing prompts into the user's language at render time.
 */

import type { GsdPhase } from "../gsd/types.js";
import type { ComplexityTier } from "./complexity.js";

export interface DirectiveInput {
  /**
   * Model-decided work depth (agent-first — see layer1 `llm-classify`). Drives
   * which rubric is injected. The rubric itself is HYBRID: it states the
   * recommended depth but lets the agent escalate/de-escalate if the task turns
   * out bigger or smaller than it read.
   */
  tier: ComplexityTier;
  phase: GsdPhase | null;
  /**
   * True when the prompt is informational/explanatory (a question or a
   * self/meta analysis) rather than a request to change code. The deliverable
   * is an ANSWER, not a diff — so the implement/verify flow is nonsensical and
   * (live repro, session 829a83888dd2) leaks into the user-facing reply as a
   * "2-3 line plan" preamble + process narration ("per contract 2/5/7", "emit
   * respond_general"), agent-ifying an answer meant for a human. When set,
   * buildDirective emits a human-facing question directive instead.
   */
  informational?: boolean;
  /**
   * True when the turn is about the Muonroi ECOSYSTEM (the whole platform, BB/
   * .NET packages, building-block, open-core boundary, setup/install) rather than
   * muonroi-cli's own TS internals. When set, buildDirective appends a nudge to
   * consult the authoritative muonroi-docs MCP first. Computed by the caller via
   * mentionsEcosystemScope so a CLI-internals question (which merely contains the
   * word "muonroi") does NOT misfire toward .NET docs.
   *
   * Live miss (session 41ccfeb2ceee turn 1): "bạn hiểu thế nào về ecosystem
   * muonroi…" — muonroi-docs WAS in the toolset (smart-filter kept it) but the
   * question directive steered the agent to read/grep local files, so it answered
   * "no comprehensive ecosystem description in the files read" instead of querying
   * the shipped authoritative source.
   */
  ecosystem?: boolean;
  /**
   * User's reply language (heuristic — Vietnamese|undefined). When set, the
   * directive appends an explicit language nudge so the rule survives the
   * personality/GSD instructions stacking on top of it (storyflow_ui session
   * 22661c8de9f2: user wrote Vietnamese, layered directives + a stalled
   * forced-finalize drowned out the base "reply in user's language" rule and
   * the agent answered in English).
   */
  replyLanguage?: string;
}

export interface DirectiveOutput {
  text: string;
  tier: ComplexityTier;
  /** True when the directive forbids the agent from acting before clarifying. */
  blocking: boolean;
}

const HEADER = "[playbook]";

/**
 * High-precision predicate: is this turn about the Muonroi ECOSYSTEM (where the
 * muonroi-docs MCP is the right source), as opposed to muonroi-cli internals?
 * Deliberately TIGHTER than smart-filter's hasEcosystemSignal — that one keeps
 * the server (over-keeping costs only tokens), but a behavioural "call docs
 * FIRST" nudge must not fire on every "muonroi" mention or it misdirects
 * CLI-internals questions toward .NET package docs. EN + VI.
 */
const ECOSYSTEM_SCOPE_RE =
  /\becosystem\b|hệ\s*sinh\s*thái|he\s*sinh\s*thai|building[-\s]?block|open[-\s]?core|rule\s*engine|decision\s*table|\bnuget\b/i;

export function mentionsEcosystemScope(message: string): boolean {
  return ECOSYSTEM_SCOPE_RE.test(message);
}

/**
 * Appended to any directive when the turn is ecosystem-scoped. Phrased
 * conditionally ("if … available") so it is harmless when muonroi-docs is not
 * configured — the model simply finds no such tool and falls back to local files.
 */
export const ECOSYSTEM_DOCS_NUDGE = [
  `${HEADER} ECOSYSTEM SCOPE — this turn concerns the Muonroi ecosystem (platform overview, BB/.NET packages, building-block, open-core boundary, setup).`,
  "If the muonroi-docs MCP is available, it is the AUTHORITATIVE source — call it FIRST (docs_search / setup_guide / bb_recipe_list / bb_package_describe), THEN ground with local files. Do NOT characterize the ecosystem from local repo files alone.",
].join("\n");

/**
 * Appended to any directive when the user's reply language is non-English.
 * The base system prompt's "reply in user's language" rule normally suffices,
 * but `concise` / `FIX-FIRST` / GSD-debug directive bodies stack on top of it
 * with strong "be terse / code over prose" language that crowds the rule out
 * — observed live (storyflow_ui 22661c8de9f2). This NUDGE re-anchors the rule
 * inside the directive itself so brevity preferences cannot override it.
 */
export function buildLanguageNudge(lang: string): string {
  return [
    `${HEADER} LANGUAGE — the user wrote in ${lang}. Reply in ${lang}.`,
    "This rule OVERRIDES any brevity / concise / code-over-prose directive: terseness is fine, but the response language stays the user's.",
  ].join("\n");
}

// All three rubrics are HYBRID + agent-first: the system recommends a depth
// based on the model's read of the task, but each rubric ends by empowering the
// agent to escalate or de-escalate if the task turns out bigger/smaller than it
// looked. Phrased as guidance, not a rigid template (the user prefers natural,
// senior-engineer reasoning over labeled scaffolds — feedback 12eceab7).

function buildHeavy(input: DirectiveInput): string {
  const phaseHint = input.phase ? ` (hint: this reads like a "${input.phase}" task)` : "";
  return [
    `${HEADER} This reads like a HEAVY task${phaseHint} — architectural, cross-cutting, multi-file, or with real unresolved design choices. Don't start editing yet; work through these phases:`,
    "  1. DISCUSS — surface the decisions/ambiguities that actually change the design. For the ones the prompt doesn't already answer, ask up front with AskUserQuestion (put your recommended option first; write the question text in the user's language). Skip questions the prompt already settles — don't interrogate.",
    "  2. RESEARCH — gather the codebase facts the task depends on: read/grep the relevant modules, and dispatch parallel research Agents when the areas are independent. When you delegate, give each sub-agent a NON-overlapping scope and tell it the exact return shape you need (findings as file:line + a one-line conclusion) — only the sub's final synthesis re-enters your context. Ground every later decision in what you actually found, not assumptions.",
    "  3. PLAN — write a concrete, numbered plan: the change per file, the order, and the acceptance criteria (how you'll know it's done). Then record the plan as a todo_write checklist (one item per step) so the user sees a live progress list.",
    "  4. CHECK-PLAN — review your own plan BEFORE executing: does it cover the acceptance criteria, handle the edge cases, and match what the user actually asked? Revise until it does (update the todo_write list if steps change). Confirm with the user only if the plan diverges from their intent.",
    "  5. IMPLEMENT — execute in atomic steps; parallelize independent work. Keep the todo_write list accurate: mark each item in_progress before you start it and completed when it lands (exactly ONE item in_progress at a time). When you're in a git repo, COMMIT each completed chunk before starting the next one (small, logically-scoped commits; message ends with the mandatory attribution line) — do NOT pile the whole task into one commit at the end.",
    "  6. VERIFY — run the relevant tests / lint / type-check and report evidence (command + result) before claiming done.",
    "This depth is a recommendation from how the task reads. If, once you look, it's genuinely smaller than it appears, say so and drop to the STANDARD flow rather than over-processing it.",
  ].join("\n");
}

function buildStandard(input: DirectiveInput): string {
  const phaseHint = input.phase ? ` (hint: this reads like a "${input.phase}" task)` : "";
  // Debug-phase variant: tighten exploration budget. Session 7d56a049e1e3
  // ran 109 tool calls (58 bash + 33 read_file + 16 grep + 2 mcp) over 6
  // minutes WITHOUT a single edit_file / write_file — agent over-researched
  // the CI failure instead of attempting a fix. Keep the FIX-FIRST exploration
  // cap, but still require a brief check against reality before editing.
  if (input.phase === "debug") {
    return [
      `${HEADER} This reads like a DEBUG task${phaseHint} — work FIX-FIRST, but think before you edit:`,
      "  1. HYPOTHESIS — state a 2-3 line hypothesis (what's failing + your best guess why) BEFORE reading more than 3 files.",
      "  2. CHECK — confirm the hypothesis against the actual failing code/log (read the key file, re-read the error). Adjust if reality disagrees.",
      "  3. FIX — apply the smallest plausible fix with edit_file / write_file. Commit to a hypothesis and ship the diff; don't keep exploring.",
      "  4. VERIFY — rerun the failing command/test and report evidence. When you're in a git repo and the fix verifies, commit it (message ends with the mandatory attribution line).",
      "Hard limits — exceed only if a tool result genuinely contradicts your hypothesis:",
      "  - ≤ 8 read_file calls before first edit_file",
      "  - ≤ 5 grep calls before first edit_file",
      "  - ≤ 10 bash log-fetching calls (gh run view, cat log, etc.) before first edit_file",
      "If the limits are blown and you still have no fix, STOP and report what you tried + why you're stuck.",
    ].join("\n");
  }
  return [
    `${HEADER} This reads like a STANDARD task${phaseHint} — work like a senior engineer, but keep it lightweight:`,
    "  1. PLAN — state a short, concrete plan: the files/functions you'll touch and in what order. A few bullets in your reply, not an essay. If it breaks into ≥3 steps, also record them with todo_write so the user gets a live checklist.",
    "  2. CHECK — sanity-check that plan against the real code (read the key files you named) and against the user's intent; fix the plan if reality differs. If a genuine ambiguity blocks you, ask ONE focused question via AskUserQuestion instead of guessing.",
    "  3. IMPLEMENT — execute the plan in small steps with the appropriate tools. If you made a todo_write checklist, keep it updated as you go (exactly one item in_progress at a time). When you're in a git repo, COMMIT each cohesive chunk as it lands (small commits; message ends with the mandatory attribution line) rather than batching everything into one final commit.",
    "  4. VERIFY — run the relevant tests / type-check / quick smoke and report evidence before claiming done.",
    "You don't need subagents or a discussion round for this. But if it turns out to be architectural or spans many files, escalate to the HEAVY flow (discuss → research → checked plan) rather than charging ahead.",
  ].join("\n");
}

function buildQuestion(): string {
  // Informational / question / meta-analysis turns. The deliverable is the
  // answer itself — there is no code to implement or test. Keep the agent's
  // process OUT of the reply: a human asked, a human reads the result.
  return [
    `${HEADER} QUESTION / explanatory request — no code change is being asked for.`,
    "Answer it directly and completely, written for the HUMAN who asked:",
    "  1. Investigate only as needed — read/grep the specific files that ground your answer this turn.",
    "  2. Lead with the answer. Use clear prose + structure (headings, bullets). Where a claim rests on the code, cite a concise file:line inline.",
    "  3. Do NOT output an implementation plan, do NOT narrate your own process or restate these instructions, and do NOT name internal layers / contract rules / tools as if the reader were the agent.",
    "There is no implement/verify step — the answer is the deliverable.",
  ].join("\n");
}

function buildQuick(input: DirectiveInput): string {
  const phaseHint = input.phase ? ` (hint: "${input.phase}")` : "";
  return [
    `${HEADER} This reads like a QUICK task${phaseHint} — handle it inline. Make the smallest correct change (or give the direct answer) and report what you did. No plan, no subagents.`,
    "If, as you work, it turns out bigger than it looked — multiple files, unclear requirements — say so and switch to the STANDARD flow (short plan → check → implement → verify) instead of forcing it.",
  ].join("\n");
}

export function buildDirective(input: DirectiveInput): DirectiveOutput {
  // Informational/meta prompts answer a human — never apply the
  // implement/verify scaffold (it agent-ifies the reply), regardless of tier.
  const base: DirectiveOutput = input.informational
    ? { text: buildQuestion(), tier: input.tier, blocking: false }
    : input.tier === "heavy"
      ? { text: buildHeavy(input), tier: "heavy", blocking: true }
      : input.tier === "standard"
        ? { text: buildStandard(input), tier: "standard", blocking: false }
        : { text: buildQuick(input), tier: "quick", blocking: false };

  // Ecosystem-scoped turns get a docs-first nudge regardless of tier (question
  // OR task): muonroi-docs is the authoritative source and must not be skipped
  // in favour of guessing from local files (session 41ccfeb2ceee turn 1).
  let text = base.text;
  if (input.ecosystem) {
    text = `${text}\n${ECOSYSTEM_DOCS_NUDGE}`;
  }
  // Language nudge: re-anchor the "reply in user's language" rule INSIDE the
  // directive when the user wrote in a non-English language, so layered
  // brevity/concise directives can't drown it (storyflow_ui 22661c8de9f2).
  if (input.replyLanguage) {
    text = `${text}\n${buildLanguageNudge(input.replyLanguage)}`;
  }
  return { ...base, text };
}
