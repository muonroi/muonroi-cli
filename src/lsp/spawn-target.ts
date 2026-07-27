/**
 * src/lsp/spawn-target.ts
 *
 * Windows `.cmd`/`.bat` shim handling for `child_process.spawn`.
 *
 * WHY THIS EXISTS: npm installs a language server's CLI on Windows as a `.cmd`
 * shim (`typescript-language-server.cmd`), and since the CVE-2024-27980 fix
 * (Node 18.20.2 / 20.12.2+) `spawn()` REFUSES to execute a `.cmd`/`.bat`
 * directly — it throws `EINVAL` before the process ever starts. Reproduced on
 * Node v24.18.0: `spawn("x.cmd")` throws `spawn EINVAL`, the same call with
 * `shell: true` succeeds.
 *
 * The fix is to run the shim through `cmd.exe`. We invoke it EXPLICITLY rather
 * than passing `shell: true`, for two reasons:
 *
 *   1. `spawn(cmd, args, { shell: true })` emits Node's DEP0190 deprecation
 *      ("args are not escaped, only concatenated") and is on track to be
 *      restricted further.
 *   2. Explicit invocation + `windowsVerbatimArguments` puts the quoting under
 *      our control instead of Node's. That matters: `cmd.exe /d /s /c` takes ONE
 *      string, so an unquoted path containing a space (`C:\Program Files\…`)
 *      would split into two tokens and an argument containing a shell
 *      metacharacter would be interpreted rather than passed through.
 *
 * This is the same shape `cross-spawn` uses. Non-Windows platforms and real
 * executables are returned untouched — cmd.exe is opt-in per command, never a
 * blanket setting, so the injection surface exists only where the platform
 * forces it.
 */

/** Batch shims are the only files the Node guard rejects. */
const WINDOWS_BATCH_RE = /\.(cmd|bat)$/i;

/**
 * Quote one token for `cmd.exe`.
 *
 * Empty strings must still produce `""` or the argument vanishes from the
 * command line. Embedded double quotes are doubled, which is how `cmd.exe`
 * escapes them inside a quoted span.
 */
export function quoteForCmd(token: string): string {
  if (token.length === 0) return '""';
  // Nothing that cmd.exe would split or interpret → leave it alone, so simple
  // args like `--stdio` stay readable in process listings and error messages.
  if (!/[\s"&|<>^()%!]/.test(token)) return token;
  return `"${token.replace(/"/g, '""')}"`;
}

export interface SpawnTarget {
  command: string;
  args: string[];
  /**
   * True only when the command was wrapped in an explicit `cmd.exe` call. The
   * caller must then pass `windowsVerbatimArguments: true` so Node does not
   * re-quote the already-quoted payload.
   */
  verbatim: boolean;
}

/**
 * Resolve how to hand `command`/`args` to `spawn`.
 *
 * @param platform Injected so the Windows branch is testable from any host.
 * @param comspec  Explicit shell path. Resolved INSIDE the body rather than as a
 *                 default parameter — a default would fire on an explicit
 *                 `undefined` and silently read the host's real `ComSpec`,
 *                 making the fallback branch untestable.
 */
export function resolveSpawnTarget(
  command: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  comspec?: string,
): SpawnTarget {
  if (platform !== "win32" || !WINDOWS_BATCH_RE.test(command)) {
    return { command, args: [...args], verbatim: false };
  }
  // `/d` skips AutoRun registry commands (a machine-local hook we do not want
  // running inside a language-server launch), `/s` fixes the quote handling of
  // the payload, `/c` runs it and exits.
  const payload = [command, ...args].map(quoteForCmd).join(" ");
  return {
    command: comspec || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${payload}"`],
    verbatim: true,
  };
}
