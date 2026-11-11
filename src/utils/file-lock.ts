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
  inProcessLocks.set(
    filePath,
    prev.then(() => next),
  );

  try {
    // Wait for our turn in-process first.
    await prev;
    return await acquireFileLock(filePath, fn, opts);
  } finally {
    resolveInProcess();
    // Clean up map entry once this waiter has resolved its slot.
    if (inProcessLocks.get(filePath) === prev.then(() => next)) {
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
