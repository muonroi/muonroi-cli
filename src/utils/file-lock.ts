import { promises as fs } from "node:fs";
import { logger } from "./logger.js";

const DEFAULT_RETRY_MS = [10, 25, 50, 100, 200, 400, 800];
const DEFAULT_TIMEOUT_MS = 10_000;

// In-process mutex: ensures same-process callers are serialized before
// competing for the on-disk lock file, so the first caller always wins.
const inProcessLocks = new Map<string, Promise<void>>();

export interface FileLockOptions {
  retryDelays?: number[];
  timeoutMs?: number;
  /**
   * Treat a lock file older than this many ms as abandoned (its holder crashed
   * mid-critical-section) and break it. Off by default: only callers whose
   * critical section is known to be short may opt in.
   */
  staleMs?: number;
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  // Chain behind any existing in-process waiter for the same path.
  const prev = inProcessLocks.get(filePath) ?? Promise.resolve();
  let resolveInProcess!: () => void;
  const next = new Promise<void>((r) => {
    resolveInProcess = r;
  });
  const tail = prev.then(() => next);
  inProcessLocks.set(filePath, tail);

  try {
    // Wait for our turn in-process first.
    await prev;
    return await acquireFileLock(filePath, fn, opts);
  } finally {
    resolveInProcess();
    // Clean up map entry once this waiter has resolved its slot — only if no later waiter
    // chained behind us (compare the stored promise itself; a fresh `.then()` never matches).
    if (inProcessLocks.get(filePath) === tail) {
      inProcessLocks.delete(filePath);
    }
  }
}

async function acquireFileLock<T>(filePath: string, fn: () => Promise<T>, opts: FileLockOptions): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const retryDelays = opts.retryDelays ?? DEFAULT_RETRY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let attempt = 0;
  let lastCode: string | undefined;
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        // Record the holder so a waiter that times out can name it. Best
        // effort: the lock is already held, so a failed write must not leak it.
        await handle.writeFile(String(process.pid));
      } catch (err) {
        logger.file("warn", "storage", "withFileLock: could not record lock holder", {
          lockPath,
          code: (err as NodeJS.ErrnoException)?.code,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await handle.close();
      }
      try {
        return await fn();
      } finally {
        await fs.unlink(lockPath).catch((err: NodeJS.ErrnoException) => {
          // A lock file that outlives its holder blocks every other waiter for
          // the full timeout — this must never be silent.
          logger.file("warn", "storage", "withFileLock: failed to release lock file", {
            lockPath,
            code: err?.code,
            error: err?.message,
          });
        });
      }
    } catch (e: any) {
      // EEXIST = lock exists (POSIX); EPERM = lock exists and locked (Windows)
      if (e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
      lastCode = e.code;
      if (opts.staleMs !== undefined && (await breakStaleLock(lockPath, opts.staleMs))) continue;
      if (await reclaimDeadOwnerLock(lockPath)) continue;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `withFileLock: timed out waiting for ${lockPath} after ${Date.now() - startedAt}ms (${await describeLockHolder(lockPath, lastCode)})`,
        );
      }
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Who holds `lockPath` and for how long, for a timeout message. Never throws. */
async function describeLockHolder(lockPath: string, lastCode: string | undefined): Promise<string> {
  try {
    const [{ mtimeMs }, holder] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf8")]);
    return `held by pid ${holder.trim() || "unknown"} for ${Math.round(Date.now() - mtimeMs)}ms; last open error ${lastCode}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT"
      ? `lock file absent at timeout; last open error ${lastCode}`
      : `holder unreadable (${code ?? String(err)}); last open error ${lastCode}`;
  }
}

/** Remove `lockPath` when its mtime is older than `staleMs`. Returns whether it was removed. */
async function breakStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const { mtimeMs } = await fs.stat(lockPath);
    if (Date.now() - mtimeMs < staleMs) return false;
    await fs.unlink(lockPath);
    return true;
  } catch (err) {
    // Vanished between open and stat (released normally) — just retry the open.
    logger.file("debug", "storage", "withFileLock: stale-lock check skipped", {
      lockPath,
      code: (err as NodeJS.ErrnoException)?.code,
    });
    return false;
  }
}

/**
 * Whether `pid` names a process that no longer exists. `process.kill(pid, 0)`
 * sends no signal: ESRCH = gone, EPERM = exists but not ours (alive). Any other
 * outcome is treated as alive — never break a lock on a guess.
 */
function isProcessDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * Remove `lockPath` when the pid recorded in it belongs to a dead process (the
 * holder was killed mid-critical-section and can never release it). Lock files
 * whose content is not a positive integer pid are left alone. Returns whether
 * the lock was removed, i.e. whether the caller should retry acquisition now.
 *
 * Race-safety: the file is first renamed to a private name (only one waiter's
 * rename can succeed), then its content is re-verified. If a live holder
 * re-acquired the path between our read and our rename, the file we grabbed is
 * theirs, so it is linked back instead of deleted.
 */
async function reclaimDeadOwnerLock(lockPath: string): Promise<boolean> {
  let pid: number;
  let ageMs: number;
  try {
    const [{ mtimeMs }, raw] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf8")]);
    const text = raw.trim();
    if (!/^\d+$/.test(text)) return false;
    pid = Number(text);
    ageMs = Math.round(Date.now() - mtimeMs);
  } catch (err) {
    // Vanished (released normally) or unreadable — just retry the open.
    logger.file("debug", "storage", "withFileLock: dead-owner check skipped", {
      lockPath,
      code: (err as NodeJS.ErrnoException)?.code,
    });
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !isProcessDead(pid)) return false;

  const grabbed = `${lockPath}.reclaim-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.rename(lockPath, grabbed);
  } catch (err) {
    // Another waiter reclaimed it first, or the file is momentarily busy.
    logger.file("debug", "storage", "withFileLock: dead-owner reclaim rename lost", {
      lockPath,
      pid,
      code: (err as NodeJS.ErrnoException)?.code,
    });
    return false;
  }
  try {
    const grabbedPid = (await fs.readFile(grabbed, "utf8")).trim();
    if (grabbedPid !== String(pid)) {
      // A live holder re-acquired between our read and rename: give the lock back.
      await fs.link(grabbed, lockPath);
      logger.file("warn", "storage", "withFileLock: dead-owner reclaim raced a new holder; lock restored", {
        lockPath,
        deadPid: pid,
        newHolder: grabbedPid,
      });
      return false;
    }
  } catch (err) {
    logger.file("warn", "storage", "withFileLock: dead-owner reclaim could not verify/restore", {
      lockPath,
      pid,
      code: (err as NodeJS.ErrnoException)?.code,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    await fs.unlink(grabbed).catch((err: NodeJS.ErrnoException) => {
      logger.file("warn", "storage", "withFileLock: failed to remove reclaimed lock file", {
        lockPath: grabbed,
        code: err?.code,
        error: err?.message,
      });
    });
  }
  logger.file("warn", "storage", "withFileLock: reclaimed lock held by dead process", { lockPath, pid, ageMs });
  return true;
}
