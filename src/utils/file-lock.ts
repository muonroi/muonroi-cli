import { promises as fs } from "node:fs";

const DEFAULT_RETRY_MS = [10, 25, 50, 100, 200, 400, 800];
const DEFAULT_TIMEOUT_MS = 10_000;

// In-process mutex: ensures same-process callers are serialized before
// competing for the on-disk lock file, so the first caller always wins.
const inProcessLocks = new Map<string, Promise<void>>();

export interface FileLockOptions {
  retryDelays?: number[];
  timeoutMs?: number;
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
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.close();
      try {
        return await fn();
      } finally {
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (e: any) {
      // EEXIST = lock exists (POSIX); EPERM = lock exists and locked (Windows)
      if (e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`withFileLock: timed out waiting for ${lockPath}`);
      }
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
