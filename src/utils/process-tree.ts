import { type ChildProcess, spawn } from "node:child_process";

/**
 * Kill a process and everything it spawned.
 *
 * `child.kill()` signals ONLY the direct child. That is not enough for a
 * `shell: true` / `bash -lc` spawn: the shell re-execs or forks the real
 * workload (observed live: bash.exe 21272 → bash.exe 5024 → bun.exe 7464), so
 * signalling the top process leaves the workload running AND holding the stdio
 * handles — and `close` never fires while any of them is open. Session
 * 7ec700df5589's `bun test src/providers --runInBand; bun run typecheck`
 * survived that way for over 24 hours and burned 59,244s of CPU until it was
 * reaped by hand with `taskkill /F /T`.
 *
 * Contract with the caller: on POSIX the child MUST have been spawned
 * `detached: true` (its own process-group leader) for the group kill to reach
 * the grandchildren; on win32 it must NOT be (`detached` there means "new
 * console window") — `taskkill /T` walks the tree instead.
 *
 * Extracted from `src/tools/bash.ts` so the verify floor's gate timeout
 * (`src/product-loop/verify-floor.ts`) uses the same kill rather than a bare
 * `child.kill()` — `src/orchestrator/delegations.ts` and
 * `src/council/plan-execution.ts` carry their own copies of the same pattern.
 *
 * `label` prefixes the diagnostics so a failed kill names its caller.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals, label: string): void {
  const pid = child.pid;
  if (typeof pid === "number") {
    if (process.platform === "win32") {
      try {
        // /T = tree, /F = force. The only reliable tree kill on Windows — there is
        // no process-group signalling to fall back on.
        spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" }).unref();
        return;
      } catch (err) {
        console.error(
          `[${label}] taskkill tree-kill failed for pid ${pid}, falling back to child.kill: ${(err as Error)?.message}`,
        );
      }
    } else {
      // POSIX: the child is spawned `detached`, making it its own process-group
      // leader, so a NEGATIVE pid signals the whole group — shell, its re-exec, and
      // every grandchild. `child.kill()` alone reaches only the direct child, which
      // CI caught on ubuntu/macos: the grandchild kept ticking (43 -> 63 writes)
      // after the "tree kill" while the Windows job passed.
      try {
        process.kill(-pid, signal);
        return;
      } catch (err) {
        // ESRCH: the group is already gone. Anything else (e.g. the child never
        // became a group leader) falls through to the single-process kill below.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ESRCH") return;
        console.error(
          `[${label}] process-group kill failed for pgid ${pid} (${code ?? "?"}), falling back to child.kill: ${(err as Error)?.message}`,
        );
      }
    }
  }
  try {
    child.kill(signal);
  } catch (err) {
    // Already exited — the caller's settle path still runs, so this is benign.
    console.error(`[${label}] kill(${signal}) failed for pid ${pid ?? "?"}: ${(err as Error)?.message}`);
  }
}
