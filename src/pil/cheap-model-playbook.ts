/**
 * src/pil/cheap-model-playbook.ts
 *
 * Tier-aware behavioural prelude PREPENDED to the system prompt for budget
 * models. Smart models (sonnet, gpt-5, etc.) make these decisions correctly
 * on their own — the playbook only fires when `modelInfo.tier === "fast"`.
 *
 * Why prepend (not append)? Live-session forensics on session 622fdeb8f658
 * (DeepSeek V4 Flash, ~8K system prompt) showed the original append-at-end
 * placement let attention decay before the rules registered: model emitted
 * `bunx vitest run | tail -40` despite the rule saying not to pipe. Primacy
 * effect — putting the rules FIRST, behind a CRITICAL marker — is a real
 * fix, not a workaround.
 *
 * The wording also changed: the previous rule 1 said "NEVER re-run with
 * different pipe flags". Cheap models rationalized that the first call
 * isn't a re-run, so the rule didn't apply. Rule 1 now applies to EVERY
 * bash call where output might need to be queried — including the first.
 *
 * Escape hatch: `MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK=1` for A/B testing.
 */

import type { ModelInfo } from "../types/index.js";

/**
 * Playbook text injected at the TOP of the system prompt for fast-tier models.
 *
 * Wrapped with the `[CRITICAL TOOL-USE RULES ...]` marker so the model knows
 * to treat these as overrides to anything that follows.
 */
export const CHEAP_MODEL_PLAYBOOK = `[CRITICAL TOOL-USE RULES — read before invoking any tool; these override defaults that follow]

1. Bash output is AUTOMATICALLY cached. Every \`bash\` call returns a \`run_id\`
   (e.g. \`bash-1\`) you can re-query via \`bash_output_get(run_id, mode=tail|head|grep|lines)\`.
   - When you want only the last N lines: do NOT pipe \`| tail -N\`. Run the
     bare command, then call \`bash_output_get(run_id, mode=tail, lines=N)\`.
   - Same for \`| head\`, \`| grep PATTERN\`, \`> file\`. Pipes/redirects HIDE
     the full output from the cache; \`bash_output_get\` reads from the cache
     without re-running.
   - This applies to EVERY bash call, not just retries.

2. Before reading more than 3 files to understand a topic, delegate to
   \`task(agent="explore")\`. The sub-agent returns a compressed summary;
   you save reading tokens.

3. Use the \`grep\` tool (ripgrep) for content search — NOT \`bash\` with
   \`grep\` / \`find\` piped.

4. When a tool returns \`ERROR: ...\`, do NOT retry the identical call.
   Pick a different tool, change inputs meaningfully, or stop and report.

[END CRITICAL TOOL-USE RULES — your regular instructions begin below]

`;

/**
 * Predicate gating playbook injection.
 *
 * Returns true iff:
 *   - `modelInfo.tier === "fast"` (budget tier from catalog.json)
 *   - env `MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK` is unset / not "1"
 */
export function shouldInjectCheapModelPlaybook(modelInfo: ModelInfo | undefined): boolean {
  if (process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK === "1") return false;
  return modelInfo?.tier === "fast";
}

/**
 * Prepend the playbook to a system prompt so it lands at the FRONT of the
 * model's attention window. Idempotent — passing an already-prefixed prompt
 * returns it unchanged so compaction reruns don't double-stack.
 *
 * Replaces the earlier `appendCheapModelPlaybook` which placed the rules at
 * the END of the system block. Live forensics showed end-placement let the
 * rules drop under attention threshold for DeepSeek V4 Flash (session
 * 622fdeb8f658 — model emitted `| tail -40` on first call despite the
 * "don't pipe" rule). Primacy fixes that.
 */
export function injectCheapModelPlaybook(systemPrompt: string): string {
  if (systemPrompt.startsWith(CHEAP_MODEL_PLAYBOOK)) return systemPrompt;
  return `${CHEAP_MODEL_PLAYBOOK}${systemPrompt}`;
}

/**
 * Deprecated alias for backwards-compat with call sites that haven't moved
 * to the new name. New code should use `injectCheapModelPlaybook`.
 *
 * @deprecated use injectCheapModelPlaybook (prepends instead of appending)
 */
export const appendCheapModelPlaybook = injectCheapModelPlaybook;
