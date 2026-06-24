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
import type { ShellKind } from "../utils/shell.js";

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
   - To VIEW a file use \`read_file\` (start_line/end_line) — never sed/cat a
     file. \`bash_output_get\` is for COMMAND output, not files.

2. Before reading more than 3 files to understand a topic, delegate to
   \`task(agent="explore")\`. The sub-agent returns a compressed summary;
   you save reading tokens.

3. Use the \`grep\` tool (ripgrep) for content search — NOT \`bash\` with
   \`grep\` / \`find\` piped.

4. When a tool returns \`ERROR: ...\`, do NOT retry the identical call.
   Pick a different tool, change inputs meaningfully, or stop and report.

5. Fix the ROOT CAUSE, never mask a failure to make it "pass"
   (\`continue-on-error\`, swallowed try/catch, skipped/deleted test, \`|| true\`).
   If a step fails from a missing secret/config, make it CONDITIONAL (skip when
   absent) so it still runs when present — do NOT blanket-ignore it.

6. For a build / CI / test failure, read the ACTUAL failure log or stack trace
   BEFORE hypothesizing — fix the real error, not a guess from source alone.

7. ANTI-MÙ / COMPACTION (for long sessions): On pre-warn or "[context compacted at step...", emit PRESERVE_FULL_CONTEXT (full veto) or lighter KEEP_TOOL_IDS: id1,id2 (from stub id=) to protect specific high-value results. read_file/grep/lsp/bash on src/PLAN/error are auto-kept (idea 1). Use ee.query tool with "tool-artifact id=XXX" for on-demand full. Self-check "task finished?" / "compacted yet?". Use EE checkpoints. If you are reaching tool/step limits in a long session, suggest the user run "/compact" in the chat to compress this session's history.

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

/**
 * A2 — front-loaded one-line shell directive for fast-tier models.
 *
 * The authoritative ENVIRONMENT block (orchestrator/prompts.ts) already states
 * the OS / shell / cwd, but it lives in the BODY of the mode prompt. Live
 * forensics on fast-tier models (e.g. DeepSeek V4 Flash, gpt-5.4-mini) show
 * they underweight rules that are not front-loaded — the same primacy effect
 * that motivated prepending the playbook. So for budget models we ALSO echo a
 * single, imperative shell line at the very front of the system prompt.
 *
 * Pure function: takes the resolved shell kind + platform so it is trivially
 * unit-testable; the caller passes `resolveShell({}).kind` and
 * `process.platform` (mirroring how buildEnvironmentBlock resolves them).
 *
 * One line only — primacy matters more than detail, and tokens are the cost.
 */
export function cheapModelShellLine(kind: ShellKind, platform: NodeJS.Platform): string {
  const osName =
    platform === "win32"
      ? "Windows"
      : platform === "darwin"
        ? "macOS"
        : platform === "linux"
          ? "Linux"
          : String(platform);
  if (kind === "bash" || kind === "wsl") {
    return `[ENV] OS=${osName}; the bash tool runs POSIX shell — use ONLY POSIX commands (ls, grep, sed, awk, cat, head, tail); NEVER PowerShell cmdlets or cmd.exe syntax.`;
  }
  if (kind === "powershell") {
    return `[ENV] OS=${osName}; the bash tool runs PowerShell — use ONLY PowerShell cmdlets (Get-ChildItem, Select-String, Measure-Object, $env:VAR); NEVER POSIX grep/sed/awk or cmd.exe syntax.`;
  }
  if (kind === "cmd") {
    return `[ENV] OS=${osName}; the bash tool runs cmd.exe — use ONLY cmd syntax (dir, type, copy, del); NEVER POSIX (grep/sed/ls) or PowerShell cmdlets.`;
  }
  // "auto" / anything undetermined: do NOT assert a syntax we cannot confirm —
  // point the model at the authoritative ENVIRONMENT block instead.
  return `[ENV] OS=${osName}; confirm the shell syntax from the ENVIRONMENT block before running any bash command.`;
}

/**
 * Prepend the one-line shell directive to a system prompt. Outermost layer —
 * call AFTER the playbook/workbook injection so the shell line lands at the
 * very front (maximum primacy). Idempotent.
 */
export function injectCheapModelShellDirective(systemPrompt: string, shellLine: string): string {
  const block = `${shellLine}\n\n`;
  if (systemPrompt.startsWith(block)) return systemPrompt;
  return `${block}${systemPrompt}`;
}
