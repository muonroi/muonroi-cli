/**
 * src/ui/utils/relaunch.ts
 *
 * Helpers for "relaunch the CLI with a different session" — used by the
 * /sessions picker so the user does not have to remember the id + restart
 * the binary manually (the whole motivation of the picker).
 *
 * The argv mangling is a PURE function so it is unit-testable in isolation
 * from the spawn side effects. `relaunchWithSession` glues argv mangling +
 * child_process spawn + parent exit; it returns nothing (process replaces).
 */

import { spawn } from "node:child_process";

/**
 * Strip any existing `-s <id>` / `--session <id>` / `--session=<id>` from
 * argv (kept indices intact otherwise) and append a fresh `--session <id>`.
 * Pure — input arrays are not mutated.
 *
 * `argv` is in the shape Node provides: `[exec, scriptOrFirstArg, ...rest]`.
 * The caller passes `process.argv.slice(1)` (the args part) and re-prepends
 * `process.argv[0]` itself. We sanitize the WHOLE args portion in one pass.
 */
export function sanitizeArgvForResume(args: ReadonlyArray<string>, sessionId: string): string[] {
  if (!sessionId || !sessionId.trim()) {
    throw new Error("sanitizeArgvForResume: sessionId is required");
  }
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-s" || a === "--session") {
      // skip the flag AND its value (if present and not another flag)
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    if (a.startsWith("--session=")) {
      continue; // skip the combined form
    }
    out.push(a);
  }
  out.push("--session", sessionId);
  return out;
}

export interface RelaunchOptions {
  /** Override process.argv (tests). Defaults to live process.argv. */
  argv?: ReadonlyArray<string>;
  /** Override the exit hook (tests). Defaults to process.exit. */
  onExit?: (code: number) => void;
  /** Injected spawn for tests. Defaults to the real node:child_process spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Spawn a fresh CLI process bound to {sessionId} and exit the current one.
 * Cross-platform: uses `stdio: "inherit"` so the child takes over the TTY,
 * and `detached: false` so killing the parent's terminal kills the child
 * (the user expects "close window = kill" semantics).
 *
 * NOTE: the caller should disconnect/teardown the current TUI before invoking
 * this — the spawn happens immediately and the parent exit is on next tick,
 * so any open file handles / MCP transports must be released first.
 */
export function relaunchWithSession(sessionId: string, opts: RelaunchOptions = {}): void {
  const argv = opts.argv ?? process.argv;
  const exec = argv[0];
  if (!exec) {
    throw new Error("relaunchWithSession: process.argv[0] is empty — cannot relaunch");
  }
  const exit = opts.onExit ?? ((code) => process.exit(code));
  const spawnImpl = opts.spawnFn ?? spawn;
  const args = sanitizeArgvForResume(argv.slice(1), sessionId);
  const child = spawnImpl(exec, args, { stdio: "inherit", detached: false });
  child.once("error", (err) => {
    console.error(`[relaunch] spawn failed: ${(err as Error)?.message ?? err}`);
    exit(1);
  });
  // Hand the TTY to the child and exit cleanly. The child takes over rendering.
  child.once("spawn", () => exit(0));
}
