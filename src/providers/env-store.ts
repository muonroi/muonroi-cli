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

/**
 * Credentials this CLI owns: it writes them itself (`/login`, `keys set` →
 * persistEnvVar) so its own store is the user's latest intent. Matched by the
 * `*_API_KEY` naming convention shared by ENV_BY_PROVIDER / ENV_BY_CHAT /
 * ENV_BY_MCP — a structural test, not a provider-id list, and importing
 * keychain.ts here would be circular (keychain imports this module).
 */
function isCliOwnedSecret(name: string): boolean {
  return /_API_KEY$/.test(name);
}

/** Last 4 chars + length — enough to tell two keys apart, never enough to use one. */
function maskSecret(value: string): string {
  return `len=${value.length} …${value.slice(-4)}`;
}

/**
 * Which side wins when `.env` and the ambient OS environment disagree.
 *
 * Default `store`: for `*_API_KEY` only, `.env` wins. A stale Windows User-scope
 * var silently beating the key the user just set through the CLI cost a full
 * session of debugging — two council panelists died on a forgotten placeholder
 * key while `.env` held the working one, and nothing said so.
 *
 * `MUONROI_ENV_PRECEDENCE=ambient` restores the old behaviour for CI and
 * scripts that intentionally inject a key for one run.
 */
function ambientWinsForSecrets(): boolean {
  return process.env.MUONROI_ENV_PRECEDENCE === "ambient";
}

/**
 * True while a test runner is driving. Vitest sets both `VITEST` and
 * `NODE_ENV=test`; either is enough.
 */
function isTestRunner(): boolean {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
}

function mirrorToWindowsRegistry(name: string, value: string | null): void {
  if (process.platform !== "win32") return;
  // A unit test must never write the developer's OS-global environment. It did:
  // `bunx vitest run` on Windows left the fixture values from env-store.test.ts,
  // migrate-legacy-keys.test.ts and auth-exclusivity.test.ts sitting in
  // HKCU:\Environment. Those tests point MUONROI_ENV_FILE at a temp dir and
  // clean it up, so they look hermetic — but persistEnvVar also mirrors here,
  // none of them mocks child_process, and nothing cleaned the registry.
  //
  // The credential fixtures then outlived the suite and shadowed the real
  // provider credentials for every NEW process: sub-agents 401'd, the AI SDK
  // reported the resulting empty stream as AI_NoOutputGeneratedError, and
  // /ideal's implementation stage died in 0.6s across three runs — bug "G1",
  // whose own comment blames "gpt-5.4 reasoning models". The model was never
  // involved. Guarding here rather than mocking per-test: the next test to call
  // persistEnvVar would reintroduce the leak, and this is invisible on POSIX.
  if (isTestRunner()) return;
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
 * Load the `.env` store into `process.env` at startup.
 *
 * For ordinary variables the ambient OS environment stays authoritative and
 * `.env` only fills gaps. For `*_API_KEY` credentials the CLI writes itself,
 * `.env` wins and the conflict is logged — see {@link ambientWinsForSecrets}
 * for why, and `MUONROI_ENV_PRECEDENCE=ambient` to opt out.
 */
export function loadEnvFileIntoProcess(): void {
  for (const line of readLines()) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const ambient = process.env[parsed.key];

    if (ambient === undefined) {
      process.env[parsed.key] = parsed.value;
      redactor.enrollSecret(parsed.value);
      continue;
    }
    if (ambient === parsed.value) continue;

    // The two disagree. For non-secrets the ambient stays authoritative, as
    // before. For a CLI-owned credential a silent divergence is exactly the
    // failure that must never happen again, so it is always reported.
    if (!isCliOwnedSecret(parsed.key)) continue;

    redactor.enrollSecret(ambient);
    if (ambientWinsForSecrets()) {
      console.error(
        `[env-store] ${parsed.key}: OS environment (${maskSecret(ambient)}) overrides the CLI store ` +
          `(${maskSecret(parsed.value)}) — MUONROI_ENV_PRECEDENCE=ambient is set. If auth fails, the ` +
          `OS variable is the one being used.`,
      );
      continue;
    }
    console.error(
      `[env-store] ${parsed.key}: the CLI store (${maskSecret(parsed.value)}) takes precedence over a ` +
        `conflicting OS environment variable (${maskSecret(ambient)}). Remove the OS variable to silence ` +
        `this, or set MUONROI_ENV_PRECEDENCE=ambient to let it win.`,
    );
    process.env[parsed.key] = parsed.value;
    redactor.enrollSecret(parsed.value);
  }
}
