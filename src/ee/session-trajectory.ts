/**
 * src/ee/session-trajectory.ts
 *
 * P0 native observation — append-only JSONL trajectory log per session.
 *
 * Writes to ~/.experience/sessions/<sessionId>.jsonl. One line per event.
 * Events are NOT sent to the EE server in P0 — this is data capture for the
 * P1 replay harness (novel-case proof per docs/specs/2026-04-22-experience-
 * formation-vnext.md).
 *
 * Why client-side?
 *   - Hooks across runtimes only see {toolName, toolInput, outcome.success}.
 *     The CLI sees PIL output, intercept matches, verifier results, user
 *     turns, and full trajectory. That data is invisible from the server's
 *     perspective and would never reach the brain otherwise.
 *
 * Rotation policy: 30-day age + 100MB total directory cap. Cheap synchronous
 * stat-based rotation runs at most once per process boot.
 *
 * Failure mode: every write is best-effort. Disk full / permission denied
 * is logged once per process and silently skipped — never blocks the agent.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface BaseTrajectoryEvent {
  ts: string;
  sessionId: string;
}

export interface InterceptTrajectoryEvent extends BaseTrajectoryEvent {
  kind: "intercept";
  toolName: string;
  decision: "allow" | "block";
  matchCount: number;
  matchIds: string[];
  reason?: string;
}

export interface PostToolTrajectoryEvent extends BaseTrajectoryEvent {
  kind: "posttool";
  toolName: string;
  success: boolean;
  durationMs?: number;
  mistakeKind?: string;
  verifyResult?: string;
  buildExitCode?: number;
}

export interface UserTurnTrajectoryEvent extends BaseTrajectoryEvent {
  kind: "user_turn";
  excerpt: string;
  vetoDetected: boolean;
}

export interface VerifyTrajectoryEvent extends BaseTrajectoryEvent {
  kind: "verify";
  result: "pass" | "fail" | "skip";
  detail?: string;
}

export interface WarningSurfacedTrajectoryEvent extends BaseTrajectoryEvent {
  kind: "warning_surfaced";
  principleIds: string[];
  toolName: string;
}

export type TrajectoryEvent =
  | InterceptTrajectoryEvent
  | PostToolTrajectoryEvent
  | UserTurnTrajectoryEvent
  | VerifyTrajectoryEvent
  | WarningSurfacedTrajectoryEvent;

const DEFAULT_DIR = path.join(os.homedir(), ".experience", "sessions");
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB

let _sessionsDir = DEFAULT_DIR;
let _disabled = false;
let _rotationDone = false;
let _warnedOnce = false;

/** Override the sessions directory. Test-only — production reads from $HOME. */
export function setSessionsDir(dir: string): void {
  _sessionsDir = dir;
  _rotationDone = false;
  _disabled = false;
  _warnedOnce = false;
}

/** Disable trajectory logging entirely. Useful for tests + opt-out. */
export function disableTrajectoryLogging(disabled = true): void {
  _disabled = disabled;
}

export function getSessionsDir(): string {
  return _sessionsDir;
}

/**
 * Append one event to the session JSONL. Best-effort: errors are swallowed
 * after one warning per process. Never throws to the caller.
 */
export async function appendTrajectoryEvent(event: TrajectoryEvent): Promise<void> {
  if (_disabled) return;
  if (!event.sessionId) return;

  try {
    if (!_rotationDone) {
      await rotateOldSessions().catch(() => {
        /* rotation failures must never block writes */
      });
      _rotationDone = true;
    }

    await fs.mkdir(_sessionsDir, { recursive: true });
    const file = sessionFilePath(event.sessionId);
    const line = `${JSON.stringify(event)}\n`;
    await fs.appendFile(file, line, "utf8");
  } catch (err) {
    if (!_warnedOnce) {
      _warnedOnce = true;
      console.warn(
        `[muonroi-cli] trajectory log write failed (${(err as Error).message}); subsequent failures will be silent.`,
      );
    }
  }
}

/** Synchronous-friendly fire-and-forget wrapper for hot paths. */
export function fireTrajectoryEvent(event: TrajectoryEvent): void {
  void appendTrajectoryEvent(event);
}

function sessionFilePath(sessionId: string): string {
  // Sanitize: only allow [a-zA-Z0-9_-], cap length. Prevents path traversal.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return path.join(_sessionsDir, `${safe}.jsonl`);
}

/**
 * Apply rotation policy. Removes files older than 30 days, then evicts
 * oldest files until directory under 100 MB.
 */
export async function rotateOldSessions(): Promise<{ removedAge: number; removedSize: number }> {
  let removedAge = 0;
  let removedSize = 0;

  let entries: string[];
  try {
    entries = await fs.readdir(_sessionsDir);
  } catch {
    return { removedAge, removedSize };
  }

  type Stat = { name: string; full: string; mtimeMs: number; size: number };
  const stats: Stat[] = [];
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(_sessionsDir, name);
    try {
      const s = await fs.stat(full);
      stats.push({ name, full, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* unreadable entry — ignore */
    }
  }

  // Phase 1: age cull
  for (const s of stats) {
    if (now - s.mtimeMs > MAX_AGE_MS) {
      try {
        await fs.unlink(s.full);
        removedAge++;
      } catch {
        /* swallow */
      }
    }
  }

  // Phase 2: size cap (oldest-first eviction). Re-stat after age cull.
  let surviving: Stat[];
  try {
    const after = await fs.readdir(_sessionsDir);
    surviving = [];
    for (const name of after) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(_sessionsDir, name);
      try {
        const s = await fs.stat(full);
        surviving.push({ name, full, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        /* skip */
      }
    }
  } catch {
    return { removedAge, removedSize };
  }

  let total = surviving.reduce((acc, s) => acc + s.size, 0);
  if (total <= MAX_TOTAL_BYTES) return { removedAge, removedSize };

  surviving.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  for (const s of surviving) {
    if (total <= MAX_TOTAL_BYTES) break;
    try {
      await fs.unlink(s.full);
      total -= s.size;
      removedSize++;
    } catch {
      /* skip */
    }
  }

  return { removedAge, removedSize };
}

/** Test-only — force rotation flag back to "not yet run". */
export function resetTrajectoryState(): void {
  _rotationDone = false;
  _warnedOnce = false;
}
