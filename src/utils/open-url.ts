import { execFile } from "node:child_process";

/**
 * Centralized, injection-safe "open a URL in the user's browser" helper.
 *
 * WHY THIS EXISTS
 * ---------------
 * The MCP OAuth `onOAuthRequired` handlers used to do:
 *
 *   const cmd = win32 ? `start "" "${urlStr}"` : darwin ? `open "${urlStr}"` : `xdg-open "${urlStr}"`;
 *   exec(cmd);
 *
 * `exec()` runs the string through a shell. The authorization URL comes from
 * the MCP server — i.e. it is UNTRUSTED. Shell command substitution (`$(...)`
 * and backticks) executes even INSIDE double quotes, so a malicious server
 * could return an auth URL like `https://x/?a=1$(rm -rf ~)` and achieve
 * arbitrary command execution on the user's machine.
 *
 * This helper closes the vector:
 *   1. Validates the URL parses and uses an http(s) scheme (rejects `file:`,
 *      `javascript:`, custom schemes).
 *   2. Re-serializes through the WHATWG URL parser, which percent-encodes
 *      quotes, spaces and control characters.
 *   3. Passes the URL as a SINGLE argv element to execFile — no shell ever
 *      interprets it.
 *
 * Windows note: we deliberately do NOT use `cmd /c start`. `cmd.exe` re-parses
 * `&` as a command separator (proven: an OAuth URL with `&calc&` splits into
 * separate commands) and mangles `%XX` percent-encodings via env-var
 * expansion. `rundll32 url.dll,FileProtocolHandler <url>` receives the URL as a
 * single argv element with no shell in the chain, so both `&` and `%` are
 * preserved and no injection is possible.
 */

export interface OpenCommand {
  command: string;
  args: string[];
}

export interface OpenUrlOptions {
  /** Override platform detection (used by tests). */
  platform?: NodeJS.Platform;
  /**
   * Injected runner (used by tests). Receives the resolved command + argv.
   * The production default spawns via execFile with NO shell.
   */
  run?: (command: string, args: string[]) => void;
}

/**
 * Resolve the platform-specific opener. The URL is ALWAYS its own argv element
 * — it is never concatenated into a shell string or into another argument.
 */
export function resolveOpenCommand(platform: NodeJS.Platform, url: string): OpenCommand {
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Open an http(s) URL in the user's default browser without invoking a shell.
 *
 * @returns `true` if an opener was dispatched, `false` if the URL was rejected
 *          (malformed or a non-http(s) scheme).
 */
export function openUrl(url: string | URL, options: OpenUrlOptions = {}): boolean {
  const platform = options.platform ?? process.platform;

  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch (err) {
    console.error(`[open-url] refusing to open malformed URL: ${truncate(String(url))}`, {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.error(
      `[open-url] refusing to open non-http(s) URL scheme '${parsed.protocol}': ${truncate(parsed.toString())}`,
    );
    return false;
  }

  const target = parsed.toString();
  const { command, args } = resolveOpenCommand(platform, target);

  const run =
    options.run ??
    ((cmd: string, cmdArgs: string[]): void => {
      // execFile — NOT exec — so no shell parses the URL. Shell metacharacters
      // in `target` are inert because the URL is a single argv element.
      execFile(cmd, cmdArgs, (err) => {
        if (err) {
          console.error(`[open-url] failed to launch browser opener '${cmd}': ${err.message}`, {
            url: target,
            stack: err.stack?.split("\n").slice(0, 3),
          });
        }
      });
    });

  run(command, args);
  return true;
}
