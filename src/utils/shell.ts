import { existsSync } from "fs";
import os from "os";
import path from "path";

export type ShellKind = "auto" | "bash" | "wsl" | "powershell" | "cmd";

export interface ShellSettings {
  /** Preferred shell. "auto" picks the best available (bash > wsl > pwsh > cmd on Windows; /bin/sh elsewhere). */
  kind?: ShellKind;
  /** Absolute path to a shell binary. Overrides `kind` resolution if provided and exists. */
  path?: string;
}

export interface ResolvedShell {
  /** Absolute path to the shell binary, or `undefined` to let Node use its platform default. */
  binary: string | undefined;
  /** True when the shell understands POSIX syntax (`2>&1 &`, `$()`, `&&`, `'…'`, `/c/path`). */
  isPosix: boolean;
  /** Stable identifier of the resolved shell. */
  kind: ShellKind;
}

const WINDOWS_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\msys64\\usr\\bin\\bash.exe",
  "C:\\cygwin64\\bin\\bash.exe",
];

const WINDOWS_POWERSHELL_CANDIDATES = [
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
];

let cachedResolved: { key: string; value: ResolvedShell } | null = null;

function findFirstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function findInPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? (process.env.PATHEXT?.split(";") ?? [".EXE"]) : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/**
 * Resolve the shell binary to use for `child_process.exec`/`spawn`.
 *
 * On Windows the Node default is `cmd.exe`, which does not understand POSIX
 * syntax (`2>&1 &`, `&&` as logical-AND, `$()`, single quotes, `rm -rf`,
 * `/c/path` mounts). LLM-generated commands are overwhelmingly POSIX, so we
 * route to bash whenever it is available.
 */
export function resolveShell(settings: ShellSettings | undefined = {}): ResolvedShell {
  const cacheKey = JSON.stringify({ s: settings, p: process.platform, env: process.env.MUONROI_SHELL ?? "" });
  if (cachedResolved && cachedResolved.key === cacheKey) return cachedResolved.value;

  const result = resolveShellInner(settings);
  cachedResolved = { key: cacheKey, value: result };
  return result;
}

/** Reset cached shell resolution. Tests only. */
export function _resetResolvedShellCache(): void {
  cachedResolved = null;
}

function resolveShellInner(settings: ShellSettings): ResolvedShell {
  const envOverride = process.env.MUONROI_SHELL;
  if (envOverride && existsSync(envOverride)) {
    return classify(envOverride);
  }

  if (settings.path && existsSync(settings.path)) {
    return classify(settings.path);
  }

  const kind: ShellKind = settings.kind ?? "auto";

  if (process.platform !== "win32") {
    if (kind === "bash") {
      const bash = findInPath("bash");
      if (bash) return { binary: bash, isPosix: true, kind: "bash" };
    }
    return { binary: undefined, isPosix: true, kind: "bash" };
  }

  // Windows
  if (kind === "cmd") {
    return { binary: undefined, isPosix: false, kind: "cmd" };
  }
  if (kind === "powershell") {
    const pwsh = findFirstExisting(WINDOWS_POWERSHELL_CANDIDATES) ?? findInPath("pwsh") ?? findInPath("powershell");
    if (pwsh) return { binary: pwsh, isPosix: false, kind: "powershell" };
  }
  if (kind === "wsl") {
    const wsl = findInPath("wsl");
    if (wsl) return { binary: wsl, isPosix: true, kind: "wsl" };
  }
  if (kind === "bash" || kind === "auto") {
    const bash = findFirstExisting(WINDOWS_BASH_CANDIDATES) ?? findInPath("bash");
    if (bash) return { binary: bash, isPosix: true, kind: "bash" };
  }
  if (kind === "auto") {
    const wsl = findInPath("wsl");
    if (wsl) return { binary: wsl, isPosix: true, kind: "wsl" };
    const pwsh = findFirstExisting(WINDOWS_POWERSHELL_CANDIDATES);
    if (pwsh) return { binary: pwsh, isPosix: false, kind: "powershell" };
  }
  return { binary: undefined, isPosix: false, kind: "cmd" };
}

function classify(binary: string): ResolvedShell {
  const lower = binary.toLowerCase();
  if (lower.endsWith("bash.exe") || lower.endsWith("/bash") || lower.endsWith("\\bash") || lower.endsWith("sh.exe") || lower.endsWith("/sh")) {
    return { binary, isPosix: true, kind: "bash" };
  }
  if (lower.endsWith("wsl.exe") || lower.endsWith("\\wsl") || lower.endsWith("/wsl")) {
    return { binary, isPosix: true, kind: "wsl" };
  }
  if (lower.endsWith("pwsh.exe") || lower.endsWith("powershell.exe")) {
    return { binary, isPosix: false, kind: "powershell" };
  }
  if (lower.endsWith("cmd.exe")) {
    return { binary, isPosix: false, kind: "cmd" };
  }
  return { binary, isPosix: true, kind: "bash" };
}

/**
 * Translate a POSIX-style absolute path to its native form on Windows.
 * `/d/sources/eBerth` → `D:\sources\eBerth`. `/c/Users/x` → `C:\Users\x`.
 * Pass-through for non-Windows or paths that are already native.
 */
export function posixToNative(p: string): string {
  if (process.platform !== "win32") return p;
  const trimmed = p.trim();
  // /<letter>/rest  →  <Letter>:\rest
  const drive = /^\/([a-zA-Z])(\/.*|$)/.exec(trimmed);
  if (drive) {
    const letter = drive[1].toUpperCase();
    const rest = drive[2].replace(/\//g, "\\");
    return `${letter}:${rest || "\\"}`;
  }
  // ~ expansion (POSIX-only convention used in commands targeting bash)
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    const rest = trimmed === "~" ? "" : trimmed.slice(2);
    return path.join(os.homedir(), rest);
  }
  return p;
}

/** Normalize a stored ShellSettings record from disk. Drops unknown fields. */
export function normalizeShellSettings(raw: unknown): ShellSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const out: ShellSettings = {};
  if (typeof obj.kind === "string") {
    const v = obj.kind.toLowerCase();
    if (v === "auto" || v === "bash" || v === "wsl" || v === "powershell" || v === "cmd") {
      out.kind = v;
    }
  }
  if (typeof obj.path === "string" && obj.path.trim()) {
    out.path = obj.path.trim();
  }
  return Object.keys(out).length ? out : undefined;
}
