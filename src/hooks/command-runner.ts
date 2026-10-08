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

/**
 * Kill `child` and every process in its group — not just the shell PID.
 * Round-2 fix (MEDIUM): a plain `child.kill()` on timeout only signals the
 * `sh -c "..."` shell itself; a grandchild the shell spawned (`sleep 5`,
 * a background `&` job, anything the hook command forked) can outlive it,
 * defeating the timeout. Requires the child to have been spawned with
 * `detached: true` on POSIX (makes it the leader of its OWN process group,
 * so `-pid` addresses the whole group); Windows has no process-group signal,
 * so `taskkill /T` (kill the tree) is used there instead, mirroring the same
 * pattern `src/tools/bash.ts` already uses for its own tree-kill.
 */
function killProcessGroup(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      if (pid) spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" }).unref();
      else child.kill("SIGKILL");
    } else if (pid) {
      process.kill(-pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // Group/tree kill can fail (process already gone, permission edge cases
    // on some sandboxes) — fall back to a plain single-process kill.
    try {
      child.kill("SIGKILL");
    } catch {
      /* best-effort — nothing more to do */
    }
  }
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
        // POSIX only — see killProcessGroup's doc comment. `detached: true`
        // on win32 spawns a new console instead, which is not what we want
        // there (taskkill /T handles the tree instead).
        detached: process.platform !== "win32",
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
      killProcessGroup(child);
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
      const out = parsed as HookOutput;
      // Round-2 fix (MEDIUM): MAX_CONTEXT_CHARS was only applied on the
      // plain-text fallback below — a hook that adopts the JSON contract
      // could still hand back an unbounded `additionalContext` string.
      if (typeof out.additionalContext === "string" && out.additionalContext.length > MAX_CONTEXT_CHARS) {
        return { ...out, additionalContext: out.additionalContext.slice(0, MAX_CONTEXT_CHARS) };
      }
      return out;
    }
  } catch {
    /* not JSON — fall through to raw-text handling */
  }
  return { additionalContext: trimmed.slice(0, MAX_CONTEXT_CHARS) };
}
