import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

// Unique tmp path per call so concurrent writers don't clobber each other's
// .tmp before rename — required for Windows where rename of a file held by
// another writer fails EPERM/EBUSY.
function tmpPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
}

const RETRIES = 3;
const STEP_TIMEOUT_MS = 10_000;

/**
 * Sentinel `code` stamped on a `withTimeout` rejection. The hang case carries no
 * errno of its own, so it gets one here — that keeps the retry decision a single
 * `code` lookup instead of a second, string-matching branch.
 */
const TIMEOUT_CODE = "EATOMICWRITETIMEOUT";

/**
 * Error codes worth retrying, and ONLY those. Each one is transient contention
 * on the TARGET, which a later attempt can win:
 *
 * - `EPERM`  — measured twice on 2026-09-26, in two different processes, on two
 *              different target files (`usage.json`, `config.json`), both at the
 *              `fs.rename` below. On Windows a rename fails EPERM while another
 *              handle (antivirus / Search Indexer / Explorer preview) holds the
 *              target open for read.
 * - `EBUSY`  — the same class of contention, reported by the same OS path.
 * - timeout  — observed once in E2E: the rename Promise never settles (Bun's
 *              libuv path on a contended target). A hang loses the write just
 *              as thoroughly as a rejection, so it retries.
 *
 * Deliberately NOT retryable: a serialize failure (never reaches here), `ENOSPC`
 * (the disk does not empty in 150ms), `EACCES` / `EROFS` (a standing permission
 * or mount property of the DIRECTORY, not a race), and `ENOENT` (the race-loser
 * check below already turns the winnable case into a success; what is left is a
 * genuinely missing parent, which a retry cannot create).
 * Retrying those only delays a certain failure. `EPERM` is admittedly also what
 * Windows reports for a read-only directory; the cost of being wrong there is
 * bounded at 3 attempts and 150ms of backoff before the same error is thrown.
 */
const RETRYABLE_WRITE_CODES: ReadonlySet<string> = new Set([TIMEOUT_CODE, "EPERM", "EBUSY"]);

/**
 * The one write+rename+retry implementation, shared by `atomicWriteJSON` and
 * `atomicWriteText`. Do not inline a second copy into either caller: a safety
 * behaviour that exists twice drifts, and `atomicWriteJSON` silently went
 * without this retry for its whole life precisely because it was a copy.
 *
 * `opName` is the PUBLIC function on whose behalf we are writing; it prefixes
 * the timeout label so a JSON timeout never reads as a text-function timeout.
 */
async function writeThenRenameWithRetry(
  filePath: string,
  tmpPath: string,
  content: string,
  opName: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      await withTimeout(fs.writeFile(tmpPath, content, "utf8"), STEP_TIMEOUT_MS, `${opName}.writeFile`);
      await withTimeout(fs.rename(tmpPath, filePath), STEP_TIMEOUT_MS, `${opName}.rename`);
      return;
    } catch (err) {
      lastErr = err;
      const e = err as NodeJS.ErrnoException;
      // ENOENT on rename means another writer already completed the atomic swap.
      // Verify the final file exists before treating as success.
      if (e?.code === "ENOENT") {
        try {
          await fs.access(filePath);
          return; // race loser — final file written by another process
        } catch {
          // final file does not exist — real failure, fall through
        }
      }
      // Clean up the .tmp if the write/rename failed mid-flight.
      await fs.unlink(tmpPath).catch(() => {
        /* ignore — the tmp may never have been created; sweepStaleAtomicTemps is the backstop */
      });
      if (!RETRYABLE_WRITE_CODES.has(e?.code ?? "")) break;
      if (attempt < RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
  }
  // Rethrow the LAST REAL error, unwrapped, so callers can still read err.code.
  throw lastErr;
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
  // Serialize BEFORE anything touches the filesystem: a value that cannot be
  // stringified must throw without creating a .tmp. Keep this out of the retry.
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (err) {
    throw new Error(`atomicWriteJSON: failed to serialize value for ${filePath}: ${(err as Error).message}`);
  }
  await writeThenRenameWithRetry(filePath, tmpPath, serialized, "atomicWriteJSON");
}

/**
 * Atomically write plain text content to filePath using .tmp + rename pattern.
 * Same durability guarantees as atomicWriteJSON but without JSON serialization.
 */
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await writeThenRenameWithRetry(filePath, tmpPathFor(filePath), content, "atomicWriteText");
}

/**
 * Race `p` against `ms`. `label` is used VERBATIM — the caller supplies the
 * operation name, so this helper cannot misattribute a timeout to the wrong
 * public function (it used to hardcode an `atomicWriteText.` prefix).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const err: NodeJS.ErrnoException = new Error(`${label} timed out after ${ms}ms`);
        err.code = TIMEOUT_CODE;
        reject(err);
      }, ms);
    }),
  ]);
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
