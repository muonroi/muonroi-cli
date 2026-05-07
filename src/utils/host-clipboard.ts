import { spawnSync } from "node:child_process";
import os from "node:os";

/**
 * Put plain text on the OS clipboard (OpenCode-style fallback when OSC 52 is not enough).
 */
export function copyTextToHostClipboard(text: string): void {
  const platform = os.platform();

  if (platform === "darwin") {
    const r = spawnSync("pbcopy", [], { input: text });
    if (r.status === 0) return;
  }

  if (platform === "linux") {
    if (process.env.WAYLAND_DISPLAY) {
      const w = spawnSync("wl-copy", [], { input: text });
      if (w.status === 0) return;
    }
    const x = spawnSync("xclip", ["-selection", "clipboard"], { input: text });
    if (x.status === 0) return;
    const s = spawnSync("xsel", ["--clipboard", "--input"], { input: text });
    if (s.status === 0) return;
  }

  if (platform === "win32") {
    const clip = spawnSync("clip", [], { input: text });
    if (clip.status === 0) return;
  }
}

/**
 * Read plain text from the OS clipboard. Returns empty string on failure
 * or when the clipboard does not contain text. Used by the right-click
 * paste shortcut in the prompt input.
 */
export function readTextFromHostClipboard(): string {
  const platform = os.platform();

  if (platform === "darwin") {
    const r = spawnSync("pbpaste", [], { encoding: "utf8" });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
    return "";
  }

  if (platform === "linux") {
    if (process.env.WAYLAND_DISPLAY) {
      const w = spawnSync("wl-paste", ["--no-newline"], { encoding: "utf8" });
      if (w.status === 0 && typeof w.stdout === "string") return w.stdout;
    }
    const x = spawnSync("xclip", ["-selection", "clipboard", "-o"], { encoding: "utf8" });
    if (x.status === 0 && typeof x.stdout === "string") return x.stdout;
    const s = spawnSync("xsel", ["--clipboard", "--output"], { encoding: "utf8" });
    if (s.status === 0 && typeof s.stdout === "string") return s.stdout;
    return "";
  }

  if (platform === "win32") {
    // Powershell Get-Clipboard returns text content, with a trailing CRLF.
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
      { encoding: "utf8" },
    );
    if (r.status === 0 && typeof r.stdout === "string") {
      return r.stdout.replace(/\r\n$/, "");
    }
    return "";
  }

  return "";
}
