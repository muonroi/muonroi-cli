import { describe, expect, it, vi } from "vitest";
import { openUrl, resolveOpenCommand } from "./open-url";

/**
 * Security regression suite for the centralized browser opener.
 *
 * Root cause being guarded: the MCP OAuth `onOAuthRequired` handlers used to
 * build a shell command string from a server-supplied authorization URL and
 * run it via child_process.exec(). A malicious/compromised MCP server could
 * return an auth URL containing shell metacharacters and achieve command
 * execution. The fix routes every opener through execFile with the URL as a
 * SINGLE argv element and NO shell.
 */
describe("resolveOpenCommand — URL is always one argv element, never a shell string", () => {
  it("linux: xdg-open <url> (url as single arg)", () => {
    const { command, args } = resolveOpenCommand("linux", "https://example.com/a?x=1&y=2");
    expect(command).toBe("xdg-open");
    expect(args).toEqual(["https://example.com/a?x=1&y=2"]);
  });

  it("darwin: open <url> (url as single arg)", () => {
    const { command, args } = resolveOpenCommand("darwin", "https://example.com/a?x=1&y=2");
    expect(command).toBe("open");
    expect(args).toEqual(["https://example.com/a?x=1&y=2"]);
  });

  it("win32: routes through rundll32 (no cmd.exe) with url as a separate argv element", () => {
    const { command, args } = resolveOpenCommand("win32", "https://example.com/a?x=1&y=2");
    // cmd.exe re-parses '&' as a command separator even inside execFile argv,
    // so we must NOT shell out to cmd on Windows.
    expect(command).not.toBe("cmd");
    expect(command).toBe("rundll32");
    // The URL is its OWN argv element — never concatenated into the entrypoint.
    expect(args[args.length - 1]).toBe("https://example.com/a?x=1&y=2");
    expect(args).toContain("url.dll,FileProtocolHandler");
  });

  it.each([
    "linux",
    "darwin",
    "win32",
  ] as const)("%s: the opener command is a real binary, never a shell", (platform) => {
    const { command } = resolveOpenCommand(platform, "https://example.com/");
    expect(["sh", "bash", "cmd", "powershell", "pwsh", "/bin/sh"]).not.toContain(command);
  });
});

describe("openUrl — validation + injection safety", () => {
  it("passes a metacharacter-laden URL as ONE argv element, not interpreted by a shell", () => {
    const run = vi.fn();
    // The canonical injection probe from the task description.
    const ok = openUrl('https://x/?a=1";calc;"', { platform: "linux", run });

    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args] = run.mock.calls[0]!;
    expect(command).toBe("xdg-open");
    // Exactly one argument — the whole URL — so `;calc;` can never become its
    // own token / command.
    expect(args).toHaveLength(1);
    // Double-quotes are percent-encoded by WHATWG URL serialization.
    expect(args[0]).toBe("https://x/?a=1%22;calc;%22");
    // `calc` is never a standalone argv element — it stays embedded in the URL.
    expect(args.some((a: string) => a === "calc")).toBe(false);
  });

  it("rejects a javascript: scheme (returns false, never spawns)", () => {
    const run = vi.fn();
    const ok = openUrl("javascript:alert(1)", { platform: "linux", run });
    expect(ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a file: scheme (returns false, never spawns)", () => {
    const run = vi.fn();
    const ok = openUrl("file:///etc/passwd", { platform: "darwin", run });
    expect(ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL (returns false, never spawns)", () => {
    const run = vi.fn();
    const ok = openUrl("not a url", { platform: "linux", run });
    expect(ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts a URL object and re-serializes it through the WHATWG parser", () => {
    const run = vi.fn();
    const ok = openUrl(new URL("https://example.com/cb?code=abc&state=xyz"), { platform: "win32", run });
    expect(ok).toBe(true);
    const [, args] = run.mock.calls[0]!;
    expect(args[args.length - 1]).toBe("https://example.com/cb?code=abc&state=xyz");
  });
});
