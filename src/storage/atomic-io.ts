import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

// Unique tmp path per call so concurrent writers don't clobber each other's
// .tmp before rename — required for Windows where rename of a file held by
// another writer fails EPERM/EBUSY.
function tmpPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
}

/**
 * Atomically write a JSON value to filePath using .tmp + rename pattern.
 * Pitfall 9 mitigation: a Ctrl+C between write and rename leaves no dangling state.
 *
 * Steps: serialize → ensure parent dir → write to filePath + ".tmp" → rename .tmp → filePath.
 * On serialize failure, .tmp is never created. On rename failure, .tmp is cleaned up.
 */
export async function atomicWriteJSON(filePath: string, value: unknown): Promise<void> {
  const tmpPath = tmpPathFor(filePath);
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (err) {
    throw new Error(`atomicWriteJSON: failed to serialize value for ${filePath}: ${(err as Error).message}`);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, serialized, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // ENOENT on rename means another writer already completed the atomic swap.
    // Verify the final file exists before treating as success.
    if (e.code === "ENOENT") {
      try {
        await fs.access(filePath);
        return; // race loser — final file written by another process
      } catch {
        // final file does not exist — real failure
      }
    }
    // Clean up the .tmp if rename failed mid-flight
    await fs.unlink(tmpPath).catch(() => {
      /* ignore */
    });
    throw err;
  }
}

/**
 * Atomically write plain text content to filePath using .tmp + rename pattern.
 * Same durability guarantees as atomicWriteJSON but without JSON serialization.
 */
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const tmpPath = tmpPathFor(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      try {
        await fs.access(filePath);
        return;
      } catch {}
    }
    await fs.unlink(tmpPath).catch(() => {
      /* ignore */
    });
    throw err;
  }
}

/**
 * Best-effort sweep of stale atomic-write staging files in `dir`.
 *
 * Matches the per-call tmp shape `{name}.{pid}.{hex}.tmp` and removes any
 * older than `maxAgeMs` (default 24h). Designed to run on boot — if a writer
 * crashed mid-rename, its tmp will accumulate forever otherwise.
 *
 * Errors are swallowed: sweeping is opportunistic and must never block boot.
 * Recurses one level (e.g. ~/.muonroi-cli/{sessions,usage}/) but stops there
 * to keep cost bounded.
 */
export async function sweepStaleAtomicTemps(
  dir: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  depth: number = 1,
): Promise<number> {
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth > 0) removed += await sweepStaleAtomicTemps(full, maxAgeMs, depth - 1);
      continue;
    }
    if (!/\.\d+\.[0-9a-f]{12}\.tmp$/.test(ent.name)) continue;
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) {
        await fs.unlink(full);
        removed++;
      }
    } catch {
      /* ignore individual failures */
    }
  }
  return removed;
}

/**
 * Read a JSON file and parse it. Returns null if file is absent (ENOENT).
 * Throws if the file exists but contains invalid JSON.
 */
export async function atomicReadJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
