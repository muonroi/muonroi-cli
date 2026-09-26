/**
 * src/hooks/command-runner.ts
 *
 * Real command execution for user-configured hooks (`~/.muonroi-cli/user-settings.json`
 * `hooks.<Event>` entries, type CommandHook).
 *
 * `src/hooks/index.ts`'s `executeEventHooks` dispatches PreToolUse/PostToolUse/
 * PostToolUseFailure to the Experience Engine HTTP client only — the original
 * shell-spawn executor (`src/hooks/executor.ts`) was deleted (Plan 00.06) and
 * never replaced for events outside that EE trio. That left every OTHER event
 * (SessionStart included) as dead configuration: a user could write a
 * `hooks.SessionStart` command in user-settings.json and it would never run.
 *
 * This module runs the command hooks for one event, matched via
 * `getMatchingHooks` (user-settings only — see hooks/config.ts's own comment;
 * this module never reads a project-level `.muonroi-cli/settings.json`, so a
 * committed repo cannot smuggle in an unsandboxed command).
 *
 * Contract, mirroring Claude Code's own hook shape:
 *  - the hook input (JSON) is written to the child's stdin;
 *  - `cwd` is on that JSON payload already (BaseHookInput.cwd) so a
 *    user-level hook can scope itself to one project by checking that field
 *    (e.g. exit early unless it ends with the project's own dir name) — this
 *    module does not do project scoping itself;
 *  - the child's OWN cwd is set to the hook input's `cwd` (not this process's
 *    cwd) so a relative command (`bash shipd-verify/briefing.sh`) resolves
 *    against the session's working directory;
 *  - stdout is parsed as JSON (a HookOutput) when it parses cleanly,
 *    otherwise the raw stdout text becomes `additionalContext` directly, so a
 *    plain script that just `echo`s text (no JSON contract) still surfaces.
 */

import { spawn } from "node:child_process";
import { logger } from "../utils/logger.js";
import { getMatchingHooks, loadHooksConfig } from "./config.js";
import type { CommandHook, HookEvent, HookInput, HookOutput, HookResult } from "./types.js";
import { getMatchQuery } from "./types.js";

/** Hard ceiling on how much of a hook's raw stdout becomes additionalContext. */
const MAX_CONTEXT_CHARS = 12_000;

/** Default per-command timeout when the hook entry does not set one. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CommandHookRunResult {
  additionalContexts: string[];
  results: HookResult[];
}

/**
 * Run every user-configured command hook matching `event` (+ optional
 * `matchValue`, e.g. SessionStart's `source`). Never throws — a hook that
 * fails to spawn, times out, or exits non-zero is recorded as a HookResult
 * with `outcome: "non_blocking_error"` and simply contributes no context.
 */
export async function runCommandHooksForEvent(
  event: HookEvent,
  input: HookInput,
  matchValue?: string,
): Promise<CommandHookRunResult> {
  const config = loadHooksConfig();
  const commands = getMatchingHooks(config, event, matchValue ?? getMatchQuery(input));
  if (commands.length === 0) return { additionalContexts: [], results: [] };

  const results = await Promise.all(commands.map((hook) => runOneCommandHook(hook, input)));
  const additionalContexts: string[] = [];
  for (const r of results) {
    const ctx = r.output?.additionalContext;
    if (ctx?.trim()) additionalContexts.push(ctx.trim());
  }
  return { additionalContexts, results };
}

function runOneCommandHook(hook: CommandHook, input: HookInput): Promise<HookResult> {
  const timeoutMs = hook.timeout && hook.timeout > 0 ? hook.timeout : DEFAULT_TIMEOUT_MS;
  return new Promise<HookResult>((resolvePromise) => {
    let settled = false;
    const finish = (result: HookResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.command, {
        shell: true,
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      logger.warn("cli", `[hooks] failed to spawn command hook: ${(err as Error)?.message}`, {
        command: hook.command,
      });
      finish({ outcome: "non_blocking_error", exitCode: null, command: hook.command });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    // A command that never reads stdin (the common case — `echo`, a plain
    // script) closes its stdin fd on exit; a write already in flight (or
    // queued right after) then raises EPIPE asynchronously on the stream,
    // which — unlike the synchronous write() call below — a try/catch around
    // that call cannot catch. Swallow it here; the hook's stdout/exit code is
    // unaffected either way.
    child.stdin?.on("error", () => {
      /* fail-open — EPIPE from a command that doesn't read stdin */
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
      finish({
        outcome: "non_blocking_error",
        exitCode: null,
        stderr: `[hook timed out after ${timeoutMs}ms]`,
        command: hook.command,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      logger.warn("cli", `[hooks] command hook errored: ${(err as Error)?.message}`, { command: hook.command });
      finish({ outcome: "non_blocking_error", exitCode: null, stderr: err.message, command: hook.command });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = parseHookOutput(stdout);
      finish({
        outcome: code === 0 ? "success" : "non_blocking_error",
        exitCode: code,
        stderr: stderr || undefined,
        command: hook.command,
        output,
      });
    });

    try {
      child.stdin?.write(JSON.stringify(input));
    } catch {
      /* fail-open — some commands don't read stdin at all */
    }
    child.stdin?.end();
  });
}

/**
 * Parse a hook's stdout. A clean JSON object matching {@link HookOutput}'s
 * shape is used as-is. Anything else (plain text, e.g. a script that just
 * prints a briefing) becomes the `additionalContext` verbatim — this is the
 * common case for a simple `bash some-script.sh` hook that never adopted the
 * JSON contract.
 */
function parseHookOutput(stdout: string): HookOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HookOutput;
    }
  } catch {
    /* not JSON — fall through to raw-text handling */
  }
  return { additionalContext: trimmed.slice(0, MAX_CONTEXT_CHARS) };
}
