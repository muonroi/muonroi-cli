/**
 * Read image data from the OS clipboard.
 * Returns base64-encoded image or null if clipboard has no image.
 *
 * - Windows: PowerShell Get-Clipboard -Format Image → save to temp PNG → read
 * - macOS: osascript to check pasteboard type, then pngpaste/screencapture
 * - Linux: xclip -selection clipboard -t image/png
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClipboardImage {
  base64: string;
  mediaType: string;
}

export function readClipboardImage(): ClipboardImage | null {
  const platform = os.platform();

  if (platform === "win32") return readWin32();
  if (platform === "darwin") return readDarwin();
  if (platform === "linux") return readLinux();

  return null;
}

function readWin32(): ClipboardImage | null {
  const tmpFile = path.join(os.tmpdir(), `muonroi-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    const escaped = tmpFile.replace(/\\/g, "\\\\");
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($img -ne $null) {
        $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
        $img.Dispose()
      }
    `;
    const result = spawnSync("powershell", ["-NoProfile", "-Command", ps], { timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    if (!fs.existsSync(tmpFile)) return null;
    const buf = fs.readFileSync(tmpFile);
    if (buf.length < 100) return null;
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function readDarwin(): ClipboardImage | null {
  try {
    const check = execSync(
      "osascript -e 'clipboard info' 2>/dev/null",
      { timeout: 3000, encoding: "utf8" },
    );
    if (!check.includes("«class PNGf»") && !check.includes("public.png") && !check.includes("TIFF")) {
      return null;
    }
  } catch {
    return null;
  }

  const tmpFile = path.join(os.tmpdir(), `muonroi-clip-${Date.now()}.png`);
  try {
    const pngpaste = spawnSync("pngpaste", [tmpFile], { timeout: 5000 });
    if (pngpaste.status !== 0) {
      spawnSync("screencapture", ["-c", "-x"]);
      const osascript = `
        set imgData to the clipboard as «class PNGf»
        set f to open for access POSIX file "${tmpFile}" with write permission
        write imgData to f
        close access f
      `;
      spawnSync("osascript", ["-e", osascript], { timeout: 5000 });
    }
    if (!fs.existsSync(tmpFile)) return null;
    const buf = fs.readFileSync(tmpFile);
    if (buf.length < 100) return null;
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function readLinux(): ClipboardImage | null {
  try {
    const targets = execSync("xclip -selection clipboard -t TARGETS -o 2>/dev/null", {
      timeout: 3000, encoding: "utf8",
    });
    if (!targets.includes("image/png")) return null;

    const buf = execSync("xclip -selection clipboard -t image/png -o 2>/dev/null", {
      timeout: 5000, maxBuffer: 50 * 1024 * 1024,
    });
    if (buf.length < 100) return null;
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch {
    // Try wl-paste for Wayland
    if (process.env.WAYLAND_DISPLAY) {
      try {
        const buf = execSync("wl-paste -t image/png 2>/dev/null", {
          timeout: 5000, maxBuffer: 50 * 1024 * 1024,
        });
        if (buf.length < 100) return null;
        return { base64: buf.toString("base64"), mediaType: "image/png" };
      } catch {
        return null;
      }
    }
    return null;
  }
}
