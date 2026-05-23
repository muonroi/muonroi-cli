/**
 * src/pil/cheap-model-playbook.ts
 *
 * Tier-aware behavioural suffix injected into the system prompt for budget
 * models. Smart models (sonnet, gpt-5, etc.) make these decisions correctly
 * on their own — the playbook only fires when `modelInfo.tier === "fast"`.
 *
 * Motivation: forensics on DeepSeek V4 Flash sessions showed it ignored the
 * (correctly-worded) `bash_output_get` tool description and re-ran `bunx
 * vitest` three times with different pipe flags before the loop-pattern guard
 * caught it (session 9b56560aeeb6 → e9c510d7d213 — see commit 8674334). Tool
 * descriptions are "read but not weighted"; cheap models adopt instructions
 * far more reliably when surfaced in the SYSTEM PROMPT itself.
 *
 * Design constraints:
 *
 *   - Stay short (~300 chars). Long suffixes dilute the model's attention.
 *   - Concrete prohibitions ("NEVER re-run with `| tail`"), not abstract
 *     principles ("be efficient").
 *   - Name the correct tool right next to the prohibited action so the model
 *     doesn't have to search the tool list.
 *   - One escape hatch: `MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK=1` for users
 *     who want to A/B test impact or have a corner case where the suffix
 *     hurts a specific cheap model.
 */

import type { ModelInfo } from "../types/index.js";

/**
 * The playbook text appended to the system prompt for fast-tier models.
 *
 * Rules ordered by frequency of the underlying anti-pattern in real session
 * forensics — most-violated first so the model sees it before the suffix runs
 * out of attention budget.
 */
export const CHEAP_MODEL_PLAYBOOK = `[BUDGET MODEL TOOL-USE PLAYBOOK — apply strictly]
1. NEVER re-run the same command with different \`| tail\`, \`| head\`, \`| grep\`, or \`> file\` flags.
   The previous bash result included a run_id — call \`bash_output_get(run_id, mode=tail|head|grep|lines)\` instead.
2. Before reading more than 3 files to understand a topic, delegate to \`task(agent="explore")\`.
   The sub-agent returns a compressed summary; you save reading tokens.
3. Use the \`grep\` tool (ripgrep) for content search — NOT \`bash\` with \`grep\` / \`find\` piped.
4. When a tool returns "ERROR: ...", do NOT retry the identical call.
   Either pick a different tool, change inputs meaningfully, or stop and report.
`;

/**
 * Predicate gating playbook injection.
 *
 * Returns true iff:
 *   - `modelInfo.tier === "fast"` (budget tier from catalog.json)
 *   - env `MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK` is unset / not "1"
 *
 * The env check uses `process.env` directly (no settings.ts indirection) so
 * the predicate stays pure and unit-testable by mutating the env in tests.
 */
export function shouldInjectCheapModelPlaybook(modelInfo: ModelInfo | undefined): boolean {
  if (process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK === "1") return false;
  return modelInfo?.tier === "fast";
}

/**
 * Append the playbook to a system prompt, separated by a blank line.
 *
 * Called from message-processor right before streamText so the suffix lands
 * in the model's prompt window for every step of the same turn (it is part
 * of `systemForModel`, not per-step injection).
 *
 * Idempotent: passing an already-suffixed prompt returns it unchanged so the
 * top-level loop and any compaction reruns don't double-stack the suffix.
 */
export function appendCheapModelPlaybook(systemPrompt: string): string {
  if (systemPrompt.includes(CHEAP_MODEL_PLAYBOOK)) return systemPrompt;
  const sep = systemPrompt.endsWith("\n") ? "\n" : "\n\n";
  return `${systemPrompt}${sep}${CHEAP_MODEL_PLAYBOOK}`;
}
