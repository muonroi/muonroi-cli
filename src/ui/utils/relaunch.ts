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
    if (a === "-s" || a === "--session" || a === "--mock-llm") {
      // skip the flag AND its value (if present and not another flag)
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    if (a.startsWith("--session=") || a.startsWith("--mock-llm=")) {
      continue; // skip the combined form
    }
    // Transient launch-mode flags must NOT survive a resume — re-entering
    // agent-mode (named-pipe transport) on a user-driven resume strands the
    // child with no harness server. Drop them.
    if (a === "--agent-mode") {
      continue;
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
  /**
   * Run immediately before the spawn — used to tear down the current TUI
   * (renderer.destroy, restore raw mode / mouse tracking / alt-screen) so the
   * child inherits a CLEAN terminal. Without this the child (and the shell, if
   * the parent exits) inherit a terminal still in mouse-tracking/alt-screen
   * mode, and stray escape bytes get parsed by the shell as a command
   * ("'…' is not recognized as an internal or external command").
   */
  beforeSpawn?: () => void;
  /**
   * When true, the parent stays alive and supervises the child: it exits with
   * the child's exit code instead of exiting the instant the child spawns.
   * This keeps any intermediate launcher (a `bun run` wrapper, the bun bin
   * shim) alive so the shell does NOT regain the terminal foreground while the
   * child is running. Required for a correct in-terminal restart on Windows.
   */
  supervise?: boolean;
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

  // Tear down the current TUI and restore the terminal BEFORE spawning so the
  // child inherits a clean TTY (no raw mode / mouse tracking / alt-screen).
  if (opts.beforeSpawn) {
    try {
      opts.beforeSpawn();
    } catch (err) {
      console.error(`[relaunch] beforeSpawn teardown failed: ${(err as Error)?.message ?? err}`);
    }
  }

  const child = spawnImpl(exec, args, { stdio: "inherit", detached: false });
  child.once("error", (err) => {
    console.error(`[relaunch] spawn failed: ${(err as Error)?.message ?? err}`);
    exit(1);
  });

  if (opts.supervise) {
    // Stay alive until the child exits so any intermediate launcher (bun run
    // wrapper / bin shim) keeps the terminal foreground for the child instead
    // of letting the shell reclaim it mid-restart.
    child.once("exit", (code) => exit(code ?? 0));
    return;
  }

  // Legacy fast-handoff: exit the instant the child spawns. Correct only when
  // there is no intervening launcher waiting on this process.
  child.once("spawn", () => exit(0));
}
