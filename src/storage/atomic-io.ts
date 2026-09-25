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
 * errno of its own, so it gets one here: it keeps the fail-fast decision below a
 * single `code` lookup with no string matching, and it gives a caller inspecting
 * `err.code` something to distinguish a timeout from a real errno.
 */
const TIMEOUT_CODE = "EATOMICWRITETIMEOUT";

/**
 * Codes that make a retry pointless, and ONLY those. Everything else retries.
 *
 * This is a DENYLIST, not a retry allowlist, and the direction is the whole
 * point. On a write path the two outcomes are not symmetric: a wasted retry
 * costs ~150ms of backoff, while a retry NOT taken costs the user's data. The
 * set of codes an OS can report at a rename is open-ended, so a closed
 * allowlist fails by silently losing a write on any code nobody enumerated —
 * which is the exact defect class this module exists to close. `EMFILE` /
 * `ENFILE` (handle exhaustion) and `EAGAIN` are the obvious examples: genuinely
 * transient, and MORE likely under precisely the load that produced the two
 * measured EPERMs. So: retry unless the code is a standing property of the
 * environment rather than a race.
 *
 * - `ENOSPC`            — the disk does not empty itself within 150ms.
 * - `EACCES` / `EROFS`  — a standing permission or mount property of the
 *                         DIRECTORY, not contention on the target.
 * - `ENOENT`            — the race-loser check below already converts the
 *                         winnable case into a success; what remains is a
 *                         genuinely missing parent, which a retry cannot create.
 *
 * `EPERM` is deliberately NOT here, and must stay out. It is the measured
 * failure — twice on 2026-09-26, two different processes, two different target
 * files (`usage.json`, `config.json`), both at the `fs.rename` below, where
 * Windows reports it while antivirus / Search Indexer / Explorer briefly holds
 * the target open for read. Windows ALSO reports `EPERM` for a read-only
 * directory, so a standing permission failure costs 3 attempts and ~150ms
 * before throwing the same error with its `code` intact. That is the accepted
 * trade: moving `EPERM` into this denylist to save those 150ms reopens the
 * measured data-loss bug. Don't.
 *
 * A serialize failure never reaches here at all — `atomicWriteJSON` throws
 * before the helper is entered. The timeout sentinel is not here either: a
 * rename that never settles loses the write just as thoroughly as one that
 * rejects, so it retries.
 */
const FAIL_FAST_WRITE_CODES: ReadonlySet<string> = new Set(["ENOSPC", "EACCES", "EROFS", "ENOENT"]);

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
      // Retry by DEFAULT — only a code we can argue is a standing property of
      // the environment stops us. An unknown code is assumed winnable, because
      // losing the write is far more expensive than one wasted attempt.
      if (FAIL_FAST_WRITE_CODES.has(e?.code ?? "")) break;
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
