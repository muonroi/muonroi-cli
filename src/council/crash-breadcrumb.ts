/**
 * src/council/crash-breadcrumb.ts
 *
 * Durable, append-only crash breadcrumbs for council runs.
 *
 * WHY THIS EXISTS (measured, 2026-09-09, `~/.muonroi-cli/debug.log`)
 * ------------------------------------------------------------------
 * A `/ideal` council run killed the process and left almost nothing on disk:
 *
 *   02:33:54.704 ENTER_IDEAL route — dispatching product loop
 *   02:39:10.448 [council.generate] call failed  (305002ms deadline, stepfun)
 *   ... 7 minutes 11 seconds of ABSOLUTE SILENCE ...
 *   02:46:21.448 candidate did not produce a completion  reason=empty-completion
 *   02:46:21.451 ... second candidate, empty-completion
 *   02:46:21.453 ... third candidate, empty-completion, chain exhausted
 *   <process gone — no crash.log entry, no exit record>
 *
 * Four gaps, and what this module does about each:
 *
 *   G1  A 7m11s hole with no log line at all. → {@link beginCouncilCall} arms a
 *       low-frequency heartbeat that turns a silent stretch into a SERIES of
 *       timestamped samples, so the hole becomes measurable instead of opaque.
 *   G2  Three "empty completions" in 5ms — indistinguishable from "we never
 *       called the provider". → attempt START/END breadcrumbs give every
 *       candidate an elapsed time (see `tracedGenerateWithFallback`).
 *   G3  No record the process ended. → `getLastBreadcrumb()` feeds the
 *       `process.on("exit")` / signal records in `src/index.ts`.
 *   G4  A V8/JSC fatal (OOM) bypasses every JS handler. → every line carries
 *       `process.memoryUsage()`. A heap/RSS series that climbs right up to the
 *       last written line is how an OOM is CONFIRMED or EXCLUDED after the
 *       fact; nothing else in this process can see that event.
 *
 * RUNTIME NOTE (measured on this machine, bun 1.3.13):
 *   Production runs under bun (`dist/src/index.js` starts `#!/usr/bin/env bun`).
 *   Bun's JSC-backed `heapUsed`/`heapTotal` are emulated and tiny/meaningless
 *   (a fresh bun process reports heapUsed ~216KB while rss is ~124MB). **`rss`
 *   is the trustworthy memory signal here** — read the rss series first when
 *   investigating an OOM; heapUsed is recorded anyway because it IS meaningful
 *   when the same code runs under node.
 *
 * DESIGN RULES
 *   - **Synchronous** `fs.appendFileSync`. The whole point is that the process
 *     dies without a chance to flush; a buffered writer is precisely why there
 *     was no trace. (`src/utils/logger.ts:106` is already sync — the gap was
 *     never durability, it was WHAT got logged.)
 *   - **Fails open, always.** A breadcrumb failure must never take the CLI down
 *     and must never slow the hot path. After {@link MAX_CONSECUTIVE_FAILURES}
 *     write failures the writer self-disables for the rest of the process.
 *   - **No model/provider string literals** (Zero Hardcode Rule) — every model
 *     or provider id in a breadcrumb is passed in by the caller.
 *
 * BOUNDING
 *   Single-rollover size cap: when the active file would exceed
 *   {@link MAX_FILE_BYTES} (4 MiB) it is renamed to `council-breadcrumbs.1.jsonl`
 *   (replacing any previous rollover) and a fresh file is started. Worst case on
 *   disk is therefore ~8 MiB, forever, across every session. Chosen over
 *   per-session files because a crash investigation wants the PREVIOUS session's
 *   tail too, and a per-session scheme leaves an unbounded pile of small files
 *   nobody prunes.
 *
 * ENVIRONMENT
 *   MUONROI_COUNCIL_BREADCRUMBS=0|off|false|no
 *       Kill switch. Defaults to ON — the entire point is that the trail is
 *       armed the next time the crash happens.
 *   MUONROI_COUNCIL_BREADCRUMB_FILE=<path>
 *       Override the output path (used by the unit tests; also handy for
 *       pointing a long unattended run at its own file).
 *   MUONROI_COUNCIL_BREADCRUMB_HEARTBEAT_MS=<250..600000>
 *       Heartbeat period while a council call is in flight. Default 5000.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger.js";

/** Wall-clock at module load — the origin for every `tMs` field. */
const PROCESS_START_MS = Date.now();

const FILE_BASENAME = "council-breadcrumbs.jsonl";
const ROTATED_BASENAME = "council-breadcrumbs.1.jsonl";

/** Active-file size cap before a single rollover. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Heartbeat period while at least one council call is in flight.
 *
 * 5000ms is a deliberate middle: (a) fine enough that a freeze inside the
 * 305_000ms council deadline is bracketed to a 5s window — the measured 7m11s
 * hole would have become ~86 samples instead of zero; (b) coarse enough that a
 * whole council run costs tens of KB, not MB; (c) comfortably longer than the
 * 2000ms event-loop-block threshold (`getLoopBlockThresholdMs`), so a MISSING
 * heartbeat is unambiguous — it means the loop was blocked or the process died,
 * not scheduler jitter.
 */
export const DEFAULT_HEARTBEAT_MS = 5_000;

/** Self-disable after this many consecutive write failures. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface BreadcrumbMemory {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface BreadcrumbRecord {
  /** ISO timestamp of the write. */
  ts: string;
  /** Monotonic-ish ms since this process loaded the module. */
  tMs: number;
  /** Marker / phase name, e.g. `council.phase.enter`. */
  marker: string;
  pid: number;
  sessionId?: string;
  mem: BreadcrumbMemory;
  [extra: string]: unknown;
}

// ── module state ────────────────────────────────────────────────────────────

let sessionId: string | undefined;
let consecutiveFailures = 0;
let disabledAfterFailure = false;
let cachedBytes: number | null = null;
let lastRecord: BreadcrumbRecord | null = null;

/**
 * Returns true unless the kill switch is set.
 *
 * Under vitest the trail is OFF unless `MUONROI_COUNCIL_BREADCRUMB_FILE` names
 * an explicit path: a unit-test suite must never append to (or rotate) the
 * operator's real crash trail, and 6500+ tests doing synchronous appends would
 * be a measurable tax for zero diagnostic value. Tests that exercise the writer
 * set the override and get the full behaviour.
 */
export function isBreadcrumbEnabled(): boolean {
  if (disabledAfterFailure) return false;
  const raw = process.env.MUONROI_COUNCIL_BREADCRUMBS?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
  if (process.env.VITEST && !process.env.MUONROI_COUNCIL_BREADCRUMB_FILE?.trim()) return false;
  return true;
}

/** Absolute path of the active breadcrumb file. */
export function breadcrumbFilePath(): string {
  const override = process.env.MUONROI_COUNCIL_BREADCRUMB_FILE?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".muonroi-cli", FILE_BASENAME);
}

function rotatedPathFor(active: string): string {
  const dir = path.dirname(active);
  const base = path.basename(active);
  // Keep the override case predictable: `foo.jsonl` → `foo.1.jsonl`.
  if (base === FILE_BASENAME) return path.join(dir, ROTATED_BASENAME);
  const ext = path.extname(base);
  return path.join(dir, `${base.slice(0, base.length - ext.length)}.1${ext || ".jsonl"}`);
}

/** Attach the session id to every subsequent breadcrumb. */
export function setBreadcrumbSession(id: string | undefined): void {
  sessionId = id;
}

/** The most recent breadcrumb written by this process, or null. */
export function getLastBreadcrumb(): BreadcrumbRecord | null {
  return lastRecord;
}

function readMemory(): BreadcrumbMemory {
  try {
    const m = process.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
  } catch (err) {
    // memoryUsage() is not expected to throw, but a breadcrumb without memory
    // is still worth writing — do not let the sample kill the record.
    logger.error("orchestrator", "[crash-breadcrumb] process.memoryUsage() failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { rss: -1, heapUsed: -1, heapTotal: -1, external: -1 };
  }
}

function rotateIfNeeded(target: string, incomingBytes: number): void {
  if (cachedBytes === null) {
    try {
      cachedBytes = fs.statSync(target).size;
    } catch {
      // ENOENT on first write of a fresh HOME is the normal path, not an error.
      cachedBytes = 0;
    }
  }
  if (cachedBytes + incomingBytes <= MAX_FILE_BYTES) return;
  try {
    fs.rmSync(rotatedPathFor(target), { force: true });
    fs.renameSync(target, rotatedPathFor(target));
    cachedBytes = 0;
  } catch (err) {
    // Rotation failure is not fatal: keep appending to the active file rather
    // than losing the trail. Report it once per occurrence (No Silent Catch).
    logger.error("orchestrator", "[crash-breadcrumb] rotation failed — continuing on the active file", {
      target,
      message: err instanceof Error ? err.message : String(err),
    });
    cachedBytes = 0;
  }
}

/**
 * Append one breadcrumb line. Never throws, never blocks on anything but the
 * synchronous append (which is the point).
 */
export function breadcrumb(marker: string, extra?: Record<string, unknown>): void {
  if (!isBreadcrumbEnabled()) return;
  let line: string;
  let record: BreadcrumbRecord;
  try {
    record = {
      ts: new Date().toISOString(),
      tMs: Date.now() - PROCESS_START_MS,
      marker,
      pid: process.pid,
      ...(sessionId ? { sessionId } : {}),
      mem: readMemory(),
      ...(extra ?? {}),
    };
    line = `${JSON.stringify(record)}\n`;
  } catch (err) {
    logger.error("orchestrator", "[crash-breadcrumb] failed to serialize breadcrumb", {
      marker,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const target = breadcrumbFilePath();
  try {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(target, Buffer.byteLength(line, "utf8"));
    fs.appendFileSync(target, line, "utf8");
    cachedBytes = (cachedBytes ?? 0) + Buffer.byteLength(line, "utf8");
    consecutiveFailures = 0;
    lastRecord = record;
  } catch (err) {
    consecutiveFailures++;
    // No Silent Catch: name module + operation + message. Report every failure
    // up to the self-disable point, then say so once and stop.
    logger.error("orchestrator", "[crash-breadcrumb] appendFileSync failed", {
      target,
      marker,
      consecutiveFailures,
      message: err instanceof Error ? err.message : String(err),
    });
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      disabledAfterFailure = true;
      logger.error(
        "orchestrator",
        `[crash-breadcrumb] disabled for this process after ${MAX_CONSECUTIVE_FAILURES} consecutive write failures`,
        { target },
      );
    }
  }
}

// ── heartbeat ───────────────────────────────────────────────────────────────

interface InFlightCall {
  marker: string;
  startedMs: number;
  extra?: Record<string, unknown>;
}

const inFlight = new Map<number, InFlightCall>();
let inFlightSeq = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function heartbeatIntervalMs(): number {
  const raw = process.env.MUONROI_COUNCIL_BREADCRUMB_HEARTBEAT_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 250 && n <= 600_000) return Math.floor(n);
  }
  return DEFAULT_HEARTBEAT_MS;
}

function emitHeartbeat(): void {
  if (inFlight.size === 0) return;
  const now = Date.now();
  breadcrumb("council.heartbeat", {
    inFlightCount: inFlight.size,
    inFlight: [...inFlight.values()].map((c) => ({
      marker: c.marker,
      elapsedMs: now - c.startedMs,
      ...(c.extra ?? {}),
    })),
  });
}

function ensureHeartbeat(): void {
  if (heartbeatTimer || !isBreadcrumbEnabled()) return;
  heartbeatTimer = setInterval(emitHeartbeat, heartbeatIntervalMs());
  // MUST unref: a diagnostic timer that keeps the event loop alive would hold
  // the CLI open after the work is done. Same reason `withTimeoutSignal`
  // (src/utils/llm-deadline.ts) hands the caller a `cleanup` thunk.
  (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
}

function stopHeartbeat(): void {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * Mark a council call as in flight and arm the heartbeat. Returns a thunk the
 * caller MUST invoke when the call settles (success, error, or abandonment).
 *
 * The heartbeat only runs while at least one call is registered, and one tick
 * emits ONE line covering every in-flight call — so the eight parallel opening
 * generates of a debate round cost one line per period, not eight.
 *
 * IMPORTANT, and itself diagnostic: if the event loop is BLOCKED, this
 * heartbeat cannot fire either — a timer cannot run while the JS thread is
 * stuck (that is the same blind spot `src/utils/event-loop-monitor.ts` exists
 * for). That is not a defect of this trail: the gap between the last heartbeat
 * and the next recorded event is now a MEASURED duration rather than the
 * unexplained 7-minute silence that motivated this module.
 */
export function beginCouncilCall(marker: string, extra?: Record<string, unknown>): () => void {
  if (!isBreadcrumbEnabled()) return () => {};
  const id = ++inFlightSeq;
  inFlight.set(id, { marker, startedMs: Date.now(), extra });
  ensureHeartbeat();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    inFlight.delete(id);
    if (inFlight.size === 0) stopHeartbeat();
  };
}

/**
 * True when the heartbeat timer is currently armed.
 *
 * @testonly — the invariant it guards is that the timer is DISARMED once the
 * last call settles, so a diagnostic cannot keep the process alive. Nothing in
 * the shipped path needs to ask.
 */
export function isHeartbeatArmed(): boolean {
  return heartbeatTimer !== null;
}

/**
 * Reset all module state. Test-only — production never needs this.
 * @internal
 */
export function __resetBreadcrumbStateForTests(): void {
  sessionId = undefined;
  consecutiveFailures = 0;
  disabledAfterFailure = false;
  cachedBytes = null;
  lastRecord = null;
  inFlight.clear();
  stopHeartbeat();
}
