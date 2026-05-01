/**
 * Offline queue module for Experience Engine write operations.
 *
 * Persists failed EE requests (feedback, extract, prompt-stale) to disk so they
 * survive process restarts and are replayed when EE recovers.
 *
 * Design decisions (from CONTEXT.md):
 *  - D-01: One JSON file per entry in ~/.muonroi-cli/ee-offline-queue/
 *  - D-02: Timestamp-based filenames for natural FIFO ordering
 *  - D-03: Each entry stores endpoint, body, enqueuedAt
 *  - D-04: Cap at 100 entries; oldest deleted before writing new
 *  - D-08: drainQueue() is fire-and-forget (returns void)
 *  - D-11: Queue directory created lazily on first enqueue
 *
 * NO imports from client.ts or intercept.ts (prevents circular deps).
 * fetchImpl and headers are passed as parameters.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_QUEUE_SIZE = 100;
const QUEUE_DIR_NAME = "ee-offline-queue";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Queue entry shape — self-contained, no external type deps. */
export interface QueueEntry {
  endpoint: string; // e.g. "/api/feedback", "/api/extract", "/api/prompt-stale"
  body: unknown; // original request payload verbatim
  enqueuedAt: number; // Date.now() at enqueue time
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to the offline queue directory.
 * Consistent with auth.ts homeOverride pattern.
 */
export function getQueueDir(homeOverride?: string): string {
  return path.join(homeOverride ?? os.homedir(), ".muonroi-cli", QUEUE_DIR_NAME);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Generate a unique filename for a new queue entry.
 * Format: `{Date.now()}-{random4}.json` (D-02)
 * The timestamp prefix ensures natural FIFO ordering on readdir + sort.
 */
function makeFilename(): string {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rnd}.json`;
}

/**
 * Returns sorted list of .json filenames in the queue directory.
 * Lexicographic sort on timestamp-prefixed names = chronological FIFO order.
 *
 * Throws ENOENT if directory does not exist — callers handle this.
 */
async function getSortedFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.endsWith(".json")).sort();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persists a failed EE request to the local queue.
 *
 * Creates queue directory lazily (D-11).
 * Enforces MAX_QUEUE_SIZE cap by deleting oldest entry (D-04).
 */
export async function enqueue(entry: QueueEntry, homeOverride?: string): Promise<void> {
  const dir = getQueueDir(homeOverride);

  // D-11: lazy init — create dir only when needed
  await fs.mkdir(dir, { recursive: true });

  const files = await getSortedFiles(dir);

  // D-04: cap enforcement — drop oldest before writing new
  if (files.length >= MAX_QUEUE_SIZE) {
    await fs.unlink(path.join(dir, files[0])).catch(() => {
      /* ignore if already gone */
    });
  }

  const filename = makeFilename();
  await fs.writeFile(path.join(dir, filename), JSON.stringify(entry), "utf8");

  if (process.env.MUONROI_DEBUG) {
    console.debug(
      "[muonroi-cli] EE offline queue: enqueued %s (cap=%d)",
      entry.endpoint,
      MAX_QUEUE_SIZE,
    );
  }
}

/**
 * Internal async implementation shared by drainQueue (fire-and-forget)
 * and drainQueueAsync (awaitable, for tests).
 *
 * Sequential replay (D-06):
 *  - Reads sorted queue files in FIFO order
 *  - POSTs each entry to baseUrl + entry.endpoint
 *  - Deletes file on HTTP success (resp.ok)
 *  - Discards corrupt (unparseable) files silently
 *  - Stops on HTTP failure or network error (D-07) — leaves file + remaining
 *
 * D-11: If queue directory doesn't exist yet, returns early (no error).
 */
async function drainQueueInternal(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  baseUrl: string,
  homeOverride?: string,
): Promise<void> {
  const dir = getQueueDir(homeOverride);

  let files: string[];
  try {
    files = await getSortedFiles(dir);
  } catch {
    // ENOENT — queue dir never created (no entries ever queued). Normal path.
    return;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);

    // Parse entry — discard corrupt files
    let entry: QueueEntry;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      entry = JSON.parse(raw) as QueueEntry;
    } catch {
      // Corrupt JSON — delete silently and continue
      await fs.unlink(filePath).catch(() => {});
      continue;
    }

    // Replay the entry
    try {
      const resp = await fetchImpl(`${baseUrl}${entry.endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(entry.body),
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        // Success — delete file and continue to next
        await fs.unlink(filePath).catch(() => {});

        if (process.env.MUONROI_DEBUG) {
          console.debug(
            "[muonroi-cli] EE offline queue: replayed %s",
            entry.endpoint,
          );
        }
      } else {
        // D-07: server returned error — stop drain, leave file + remaining
        break;
      }
    } catch {
      // D-07: network failure — stop drain, leave file + remaining
      break;
    }
  }
}

/**
 * Replays queued EE requests in FIFO order.
 *
 * Fire-and-forget wrapper (D-08) — returns void immediately.
 * The caller (recordCircuitSuccess in client.ts) must NOT await this.
 *
 * @param fetchImpl - fetch implementation (injectable for tests)
 * @param headers   - HTTP headers to include (Content-Type + optional auth)
 * @param baseUrl   - EE base URL (e.g. "http://localhost:8082")
 * @param homeOverride - Optional home dir override (for tests)
 */
export function drainQueue(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  baseUrl: string,
  homeOverride?: string,
): void {
  // D-08: fire-and-forget — the returned Promise is intentionally not awaited
  void drainQueueInternal(fetchImpl, headers, baseUrl, homeOverride);
}

/**
 * Awaitable version of drainQueue — for tests only.
 *
 * Production code must use drainQueue() (void).
 * Tests use drainQueueAsync() to await completion before asserting.
 */
export async function drainQueueAsync(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  baseUrl: string,
  homeOverride?: string,
): Promise<void> {
  await drainQueueInternal(fetchImpl, headers, baseUrl, homeOverride);
}
