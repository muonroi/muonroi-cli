/**
 * src/utils/crash-log.ts
 *
 * The last-resort diagnostic sink: `~/.muonroi-cli/crash.log`.
 *
 * Written from the process-level `uncaughtException` / `unhandledRejection`
 * handlers, from the freeze diagnostics, and from the stderr-mirror failure
 * sink — i.e. the paths where every richer channel (the TUI, the logger, the
 * console) is either gone or unsafe to touch.
 *
 * WHY IT LIVES HERE AND NOT IN `src/index.ts`
 * `src/index.ts` calls `program.parse()` at module scope, so importing it runs
 * the whole CLI. That made this sink — one of the few that persists a raw
 * `err.stack` — impossible to cover with a test that reads the written bytes
 * back. `src/index.ts` re-exports `appendCrashLog` so existing importers
 * (`src/ui/app.tsx`, `src/ui/slash/export.ts`) are unaffected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "./logger.js";

/**
 * True while the interactive TUI owns the terminal. Read from the same
 * `globalThis` flag `setTuiActive` publishes (src/index.ts) and that
 * `logger.ts`'s own `isTuiActive` reads, so this module needs no import from
 * the CLI entrypoint. Undefined (never set) reads as false, matching the
 * `let _tuiActive = false` it replaced.
 */
function isTuiActive(): boolean {
  try {
    return (globalThis as Record<string, unknown>).__muonroiTuiActive === true;
  } catch {
    return false;
  }
}

/** Resolved per call so a test can point HOME at a temp dir. */
function crashLogPath(): string {
  return path.join(os.homedir(), ".muonroi-cli", "crash.log");
}

export function appendCrashLog(label: string, msg: string): void {
  try {
    const dir = path.join(os.homedir(), ".muonroi-cli");
    // On a genuinely fresh HOME the directory does not exist yet, and
    // appendFileSync throws ENOENT — which the old bare catch swallowed, so the
    // FIRST crash a new user or agent ever hits was the one crash that left no
    // record at all. Measured 2026-09-09: `muonroi-cli mcp-driver` under a fresh
    // HOME printed `Unhandled rejection: {}` and wrote no crash.log.
    fs.mkdirSync(dir, { recursive: true });
    // Redacted: `msg` is a raw `err.stack || err.message` (see the UNCAUGHT /
    // REJECTION handlers in src/index.ts). A provider auth failure is exactly
    // the class of error that reaches an uncaught handler, and its message can
    // embed the request header or the key it was rejected for — which is how
    // the earlier `serializeError` fix leaked an `sk-proj…` key verbatim into a
    // breadcrumb file. This sink also bypasses the process-wide console patch
    // (`redactor.installGlobalPatches()`), because it writes with
    // `fs.appendFileSync` and never goes through `console.*`.
    //
    // Span-level, so the stack frames, the label and the surrounding message
    // all survive intact — a crash record that lost its cause would defeat the
    // only reason this file exists.
    const line = redactSecrets(`[${new Date().toISOString()}] ${label}: ${msg}\n`);
    fs.appendFileSync(crashLogPath(), line);
  } catch (err) {
    // crash.log is best-effort diagnostics; the logger itself must never throw.
    // But it must not be silent either (No Silent Catch) — a lost crash record
    // is exactly the case where the operator needs to know why.
    if (!isTuiActive()) {
      console.error(`[crash-log] appendCrashLog failed (${label}): ${(err as Error)?.message ?? String(err)}`);
    }
  }
}
