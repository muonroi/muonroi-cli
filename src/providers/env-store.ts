/**
 * src/providers/env-store.ts
 *
 * Canonical CLI key store: a `~/.muonroi-cli/.env` file (mode 0600) that is
 * loaded into process.env at startup and written when the user sets a key.
 * On Windows we ALSO mirror to the User-scope registry env so other OS
 * processes see the key. Replaces the OS keychain (keytar).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactor } from "../utils/redactor.js";

export function envFilePath(): string {
  return process.env.MUONROI_ENV_FILE ?? join(homedir(), ".muonroi-cli", ".env");
}

function readLines(): string[] {
  try {
    return readFileSync(envFilePath(), "utf8").split(/\r?\n/);
  } catch {
    // Missing file is the normal first-run case — no key store yet.
    return [];
  }
}

function writeLines(lines: string[]): void {
  const p = envFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const body = lines.filter((l, i) => !(l === "" && i === lines.length - 1)).join("\n");
  writeFileSync(p, body === "" ? "" : `${body}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch (err) {
    // Non-fatal on filesystems without POSIX perms (e.g. some Windows FS).
    if (process.env.MUONROI_DEBUG_ENVSTORE) {
      console.error(`[env-store] chmod failed for ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Parse "KEY=value" — value may contain "="; comments/blank lines ignored. */
function parseLine(line: string): { key: string; value: string } | null {
  if (!line || line.trimStart().startsWith("#")) return null;
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1) };
}

/** Env-var names we will ever mirror are plain identifiers; reject anything else. */
function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function mirrorToWindowsRegistry(name: string, value: string | null): void {
  if (process.platform !== "win32") return;
  if (!isValidEnvName(name)) {
    // Defense-in-depth: never let a non-identifier name reach the shell.
    if (process.env.MUONROI_DEBUG_ENVSTORE) {
      console.error(`[env-store] refusing to mirror invalid env name: ${name}`);
    }
    return;
  }
  try {
    // Neither name nor value is interpolated into the script — both are read
    // from the child's environment as literal strings, so no PowerShell
    // metacharacters in either can be interpreted as commands (injection-safe).
    const script =
      value === null
        ? "[Environment]::SetEnvironmentVariable($env:MUONROI_ENVSTORE_NAME, $null, 'User')"
        : "[Environment]::SetEnvironmentVariable($env:MUONROI_ENVSTORE_NAME, $env:MUONROI_ENVSTORE_VALUE, 'User')";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env:
        value === null
          ? { ...process.env, MUONROI_ENVSTORE_NAME: name }
          : { ...process.env, MUONROI_ENVSTORE_NAME: name, MUONROI_ENVSTORE_VALUE: value },
      stdio: "ignore",
    });
  } catch (err) {
    // .env + in-memory write already succeeded; OS-wide mirror is best-effort.
    if (process.env.MUONROI_DEBUG_ENVSTORE) {
      console.error(
        `[env-store] registry mirror failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Upsert `name=value` in the `.env` store, set `process.env[name]` for the
 * current process, and (on Windows) mirror to the User registry env.
 */
export function persistEnvVar(name: string, value: string): void {
  redactor.enrollSecret(value);
  const lines = readLines();
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed?.key === name) {
      if (!replaced) {
        out.push(`${name}=${value}`);
        replaced = true;
      }
    } else if (line !== "") {
      out.push(line);
    }
  }
  if (!replaced) out.push(`${name}=${value}`);
  writeLines(out);
  process.env[name] = value;
  mirrorToWindowsRegistry(name, value);
}

/** Remove `name` from the `.env` store, `process.env`, and Windows registry. */
export function clearEnvVar(name: string): void {
  const lines = readLines();
  const out = lines.filter((line) => parseLine(line)?.key !== name && line !== "");
  writeLines(out);
  delete process.env[name];
  mirrorToWindowsRegistry(name, null);
}

/**
 * Load the `.env` store into `process.env` at startup. A variable already
 * present in the real OS environment at launch is authoritative and is NOT
 * overwritten — `.env` only fills gaps.
 */
export function loadEnvFileIntoProcess(): void {
  for (const line of readLines()) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
      redactor.enrollSecret(parsed.value);
    }
  }
}
