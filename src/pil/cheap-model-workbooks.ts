/**
 * src/pil/cheap-model-workbooks.ts
 *
 * Task-type-aware "workbooks" for budget (fast-tier) models — a focused
 * convergence layer that sits in front of the system prompt alongside the
 * cheap-model playbook (see cheap-model-playbook.ts for the tool-use rules).
 *
 * Motivation (live cost forensics, 2026-05-31): gpt-5.4-mini took 19 LLM calls
 * (~395K input tokens) to apply a ONE-LINE CI fix — broad greps, re-reads,
 * read-budget overruns, many tiny exploration steps. For budget models the
 * dominant cost is `tool-call-count × ~20K input/call` (the system prompt +
 * tool envelope is re-sent every call), so RAMBLING IS THE COST. Smart models
 * converge on their own; fast-tier models need an explicit "do the minimum,
 * then stop" instruction.
 *
 * The workbook is injected only for `modelInfo.tier === "fast"`, is fixed for
 * the whole turn (so it stays inside the cached prefix), and is intentionally
 * short to preserve attention budget.
 *
 * Escape hatch: MUONROI_DISABLE_CHEAP_MODEL_WORKBOOK=1.
 */

import type { ModelInfo } from "../types/index.js";
import type { TaskType } from "./types.js";

/**
 * Universal anti-ramble convergence block — applies to every task type.
 * Kept tight; the per-task addendum below specialises it.
 */
export const CHEAP_MODEL_CONVERGENCE = `[CONVERGENCE — minimise tool calls; the system prompt + tools are re-sent every call, so each extra step is expensive]

- Plan the FEWEST reads you need, then read the specific file/section directly.
  Do NOT broad-grep, re-read a file you already read, or explore "just in case".
- The moment you have enough to act, STOP investigating and make the change.
- Make the SMALLEST correct change for the request; do not widen scope.
- Finish the action before you answer — never stop mid-step (e.g. "I'm verifying…").
  When done, state completion in ONE line (what changed + that it's verified);
  no recap, no next-steps padding.
- GROUND every claim in what you actually read or ran THIS turn: cite real
  file:line, and never invent counts, line numbers, names, or bugs. If a number
  (test/file count) is not verified by a command you ran, run the check or mark
  it "unverified" — do NOT guess a value or assert a finding you did not observe.
- ANTI-MÙ: After compaction note or pre-warn, emit PRESERVE_FULL_CONTEXT (full) or KEEP_TOOL_IDS: id1,id2 to protect high-value (auto for read_file/grep on src/PLAN/error). Use the ee_query tool with "tool-artifact id=XXX" for on-demand full re-hydrate. Recall checkpoints. On long sessions, call the \`compact\` tool yourself to compress history and keep going (don't stop). `;

/**
 * Per-task-type addenda. Each is 1–2 tight lines targeting that type's most
 * common budget-model failure mode. Types not listed fall back to the
 * convergence block alone.
 */
const TASK_WORKBOOKS: Partial<Record<TaskType, string>> = {
  debug:
    "DEBUG: read the ACTUAL error/log/failing output first; fix the smallest root cause with ONE change. " +
    "Never mask a failure to make it pass (no continue-on-error, swallowed catch, skipped test, `|| true`).",
  generate:
    "GENERATE: confirm the target file + the surrounding pattern, write the new code to match it, then stop. " +
    "Do not scaffold extras or restructure unrelated code.",
  build:
    "BUILD: scaffold the MINIMUM runnable project/feature that satisfies the request, matching the chosen stack's " +
    "conventions. Wire it end-to-end and verify it builds/runs before stopping. Do NOT add speculative features, " +
    "extra files, or config the request did not ask for.",
  refactor: "REFACTOR: change only what was named (rename/extract/move). Preserve behaviour; add nothing new.",
  analyze:
    "ANALYZE: answer from what you have already read — do not read the whole codebase. Bullet findings, no narrative. " +
    "For a repo/code review, base findings on the ACTUAL code you inspect (file sizes, structure, key modules), not just AGENTS.md/CLAUDE.md docs.",
  documentation: "DOCS: document only what was asked, with a short example. No tangents.",
  plan: "PLAN: produce concise ordered steps with one line of rationale each. No essays.",
};

/**
 * Map a sub-agent role (agentKey) to the workbook TaskType that best matches
 * its job. Sub-agents never run PIL Layer 1, so they have no classifier-derived
 * taskType — their ROLE is their task type:
 *   - explore           → analyze  (read-only research; "answer from what you read")
 *   - verify*           → debug    (runs tests / diagnoses failures; "read the real error")
 *   - general/vision/computer/custom → null (convergence-only anti-ramble block)
 *
 * Returning null is a safe default: the convergence block still applies, only
 * the per-type addendum is omitted.
 */
export function subagentTaskType(agentKey: string): TaskType | null {
  if (agentKey === "explore") return "analyze";
  if (agentKey === "verify" || agentKey === "verify-detect" || agentKey === "verify-manifest") return "debug";
  return null;
}

/**
 * Build the workbook text for a task type (convergence + optional addendum).
 */
export function getCheapModelWorkbook(taskType: TaskType | null | undefined): string {
  const addendum = taskType ? TASK_WORKBOOKS[taskType] : undefined;
  const body = addendum ? `${CHEAP_MODEL_CONVERGENCE}\n\n${addendum}` : CHEAP_MODEL_CONVERGENCE;
  return `${body}\n[END CONVERGENCE — your regular instructions follow]\n\n`;
}

/**
 * Gate workbook injection. Mirrors the playbook gate: fast tier only, unless
 * disabled via MUONROI_DISABLE_CHEAP_MODEL_WORKBOOK=1.
 */
export function shouldInjectCheapModelWorkbook(modelInfo: ModelInfo | undefined): boolean {
  if (process.env.MUONROI_DISABLE_CHEAP_MODEL_WORKBOOK === "1") return false;
  return modelInfo?.tier === "fast";
}

/**
 * Prepend the task workbook to a system prompt. Idempotent — re-injecting an
 * already-prefixed prompt for the same task type returns it unchanged so
 * compaction reruns don't double-stack.
 */
export function injectCheapModelWorkbook(systemPrompt: string, taskType: TaskType | null | undefined): string {
  const workbook = getCheapModelWorkbook(taskType);
  if (systemPrompt.startsWith(workbook)) return systemPrompt;
  return `${workbook}${systemPrompt}`;
}
