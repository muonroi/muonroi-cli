/**
 * src/utils/stderr-mirror.ts
 *
 * Mirror JS-level `process.stderr` writes to `~/.muonroi-cli/tui-stderr.log`
 * while the interactive TUI owns the terminal.
 *
 * WHY (G4, 2026-09-09): a `/ideal` council run killed the process with no crash
 * record. One candidate explanation is a fatal error whose only output is
 * stderr — and while the TUI is mounted, anything printed to stderr lands in
 * OpenTUI's alternate screen buffer and is gone the instant the buffer is
 * swapped back on teardown. "We found nothing in stderr" was therefore not
 * evidence that nothing was printed.
 *
 * WHAT THIS CATCHES: every write that goes through `process.stderr.write` while
 * the TUI is mounted — `withVisibleRetry`'s fallback retry line, a dependency's
 * warning, a `console.error` from a path that does not check `_tuiActive`.
 *
 * WHAT THIS DOES **NOT** CATCH — read this before trusting it for an OOM:
 * a V8/JSC fatal error ("FATAL ERROR: Reached heap limit"), a bun panic, or a
 * native crash trace is written to file descriptor 2 from NATIVE code. It never
 * passes through `process.stderr.write`, so no JS-level patch can observe it.
 * Redirecting fd 2 itself requires `dup2`, which is not reachable from JS.
 * `process.report` is not an escape hatch either: measured on this machine
 * (bun 1.3.13, the runtime `dist/src/index.js` actually shebangs to),
 * `process.report.writeReport("x.json")` returns the filename and writes NO
 * file — it is a stub, so `--report-on-fatalerror` / `reportOnFatalError`
 * buys nothing here.
 *
 * For that class of death the working evidence is the `rss` series in the
 * council breadcrumb JSONL (`src/council/crash-breadcrumb.ts`) plus the
 * `process.exit` record; capturing the native message itself needs an
 * out-of-process launcher that redirects fd 2 before exec.
 *
 * SAFETY: the original `write` is always invoked with the original arguments
 * and its return value is passed straight through, so the bytes reaching the
 * terminal are byte-identical to before. A tee that emits no output of its own
 * cannot corrupt the framebuffer — which is the whole reason stderr is treated
 * as off-limits under OpenTUI in the first place.
 *
 * ENVIRONMENT
 *   MUONROI_TUI_STDERR_MIRROR=0   disable (defaults to ON)
 *   MUONROI_TUI_STDERR_MIRROR_FILE=<path>   override the output path
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "./logger.js";

const BASENAME = "tui-stderr.log";

/** Hard cap per process; past this the mirror mutes itself (writes still pass through). */
export const MAX_MIRROR_BYTES = 1024 * 1024;

type WriteFn = typeof process.stderr.write;

let originalWrite: WriteFn | null = null;
let bytesWritten = 0;
let muted = false;
/** Set while inside the mirror's own append, so a nested stderr write cannot recurse. */
let reentrant = false;

/** Reported through this sink rather than console.* — writing to stderr from inside a stderr patch recurses. */
type FailureSink = (message: string) => void;
let failureSink: FailureSink | null = null;

/**
 * Where a mirror failure is reported. `src/index.ts` points this at
 * `appendCrashLog`; without one the failure is dropped (never printed), because
 * the only output channel available at that point is the one that just failed.
 */
export function setStderrMirrorFailureSink(sink: FailureSink | null): void {
  failureSink = sink;
}

/**
 * Root of the muonroi home.
 *
 * Priority: MUONROI_CLI_HOME env → os.homedir()/.muonroi-cli — the same
 * `muonroiHome()` convention already used by src/storage/config.ts,
 * src/usage/ledger.ts, src/chat/channel-manager.ts et al. Resolved lazily per
 * call, never as a module-level `const`, so the suite-wide pin in
 * `src/__test-stubs__/vitest-setup.ts` can reach it (`src/lsp/npm-cache.ts:20-28`
 * records why a const cannot be redirected from a test).
 */
function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

/**
 * Where the mirror appends.
 *
 * `MUONROI_TUI_STDERR_MIRROR_FILE` names an exact file and stays the most
 * specific override — it wins outright. Below it the general home pin applies,
 * so a test that sets neither still cannot append to the operator's real
 * `~/.muonroi-cli/tui-stderr.log`.
 */
export function stderrMirrorPath(): string {
  const override = process.env.MUONROI_TUI_STDERR_MIRROR_FILE?.trim();
  if (override) return override;
  return path.join(muonroiHome(), BASENAME);
}

export function isStderrMirrorEnabled(): boolean {
  const raw = process.env.MUONROI_TUI_STDERR_MIRROR?.trim().toLowerCase();
  return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

/**
 * True while the tee is installed.
 *
 * @testonly — pins install/restore symmetry, so a mirror can never be left
 * wrapping stderr after the TUI unmounts. No shipped caller asks.
 */
export function isStderrMirrorInstalled(): boolean {
  return originalWrite !== null;
}

function report(message: string): void {
  // No Silent Catch, but the honest constraint is that console.error here would
  // re-enter the patched write. Route to the sink; if none is wired, the failure
  // is dropped deliberately rather than risking recursion inside a crash path.
  try {
    failureSink?.(message);
  } catch {
    // The sink itself is best-effort diagnostics (appendCrashLog already logs
    // its own failures). Nothing further is safe to attempt from inside a
    // stderr write.
  }
}

function appendMirror(text: string): void {
  if (muted || reentrant) return;
  reentrant = true;
  try {
    const target = stderrMirrorPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Redact the DURABLE copy only. The tee forwards `chunk` untouched further
    // down (see installStderrMirror), so the terminal still receives
    // byte-identical output — the safety property this whole module rests on.
    //
    // `console.*` output arrives here already scrubbed, because
    // `redactor.installGlobalPatches()` (src/index.ts:7) wraps the console
    // methods. But this tee sits on `process.stderr.write`, and everything that
    // reaches that function WITHOUT going through console bypasses that patch
    // entirely — `withVisibleRetry`'s fallback line, a dependency writing to
    // stderr directly, a formatted rejection. Those are the writes that were
    // landing in a 1 MB durable file unfiltered.
    const line = `[${new Date().toISOString()}] ${redactSecrets(text)}`;
    fs.appendFileSync(target, line, "utf8");
    bytesWritten += Buffer.byteLength(line, "utf8");
    if (bytesWritten >= MAX_MIRROR_BYTES) {
      muted = true;
      fs.appendFileSync(target, `[${new Date().toISOString()}] [stderr-mirror] size cap reached — muted\n`, "utf8");
    }
  } catch (err) {
    muted = true;
    report(`[stderr-mirror] append failed, mirror muted: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    reentrant = false;
  }
}

/** Install the tee. Idempotent; a no-op when disabled by env. */
export function installStderrMirror(): void {
  if (originalWrite || !isStderrMirrorEnabled()) return;
  const orig = process.stderr.write.bind(process.stderr) as WriteFn;
  originalWrite = orig;
  bytesWritten = 0;
  muted = false;
  // biome-ignore lint/suspicious/noExplicitAny: matching Writable.write's overloads
  (process.stderr as any).write = (chunk: any, encoding?: any, cb?: any): boolean => {
    try {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      appendMirror(text);
    } catch (err) {
      muted = true;
      report(`[stderr-mirror] could not decode chunk, mirror muted: ${(err as Error)?.message ?? String(err)}`);
    }
    // Always forward, unchanged, and return exactly what the original returned:
    // the terminal must see byte-identical output.
    return (orig as (c: unknown, e?: unknown, f?: unknown) => boolean)(chunk, encoding, cb);
  };
}

/** Restore the original `process.stderr.write`. Idempotent. */
export function restoreStderrMirror(): void {
  if (!originalWrite) return;
  // biome-ignore lint/suspicious/noExplicitAny: restoring the original overloads
  (process.stderr as any).write = originalWrite;
  originalWrite = null;
}

/**
 * Reset internal counters. Test-only.
 * @internal
 */
export function __resetStderrMirrorForTests(): void {
  restoreStderrMirror();
  bytesWritten = 0;
  muted = false;
  reentrant = false;
  failureSink = null;
}
