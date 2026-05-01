/**
 * PendingCallsLog — append-only JSONL audit log for in-flight tool calls.
 *
 * Purpose (Pitfall 9 mitigation):
 *   Track every tool call that may stage .tmp partial writes so that, on the
 *   next boot, reconcile() can clean up any dangling .tmp files left behind by
 *   a crashed or Ctrl+C-killed process.
 *
 * Storage: ~/.muonroi-cli/sessions/<sessionId>/pending_calls.jsonl
 *   - This is the SIBLING dir managed by getSessionDir() — NOT SQLite.
 *   - Each tool call generates two append-only lines: "begin" and "end".
 *   - reconcile() reads the JSONL, finds entries with status="pending" from a
 *     prior process, tries to clean their staged_paths, then marks "abandoned".
 *
 * Concurrency safety:
 *   All writes are serialised through a Promise chain so that concurrent
 *   begin() calls cannot interleave partial JSON lines in the JSONL file.
 *
 * References: TUI-04, Pitfall 9, 00-CONTEXT.md decision section.
 */

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getSessionDir } from "../storage/session-dir.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PendingCallEntry {
  call_id: string;
  tool_name: string;
  started_ms: number;
  ended_ms?: number;
  status: "pending" | "settled" | "aborted" | "abandoned";
  staged_paths?: string[];
}

export interface PendingCallsLog {
  /**
   * Record the start of a tool call.  Call BEFORE the tool runner is invoked.
   * Serialised internally — safe to call concurrently.
   */
  begin(
    entry: Omit<PendingCallEntry, "started_ms" | "status"> & {
      staged_paths?: string[];
    },
  ): Promise<void>;

  /**
   * Record the end of a tool call with its final status.
   * Call from both the success and error paths of the tool runner.
   */
  end(call_id: string, status: "settled" | "aborted"): Promise<void>;

  /**
   * Boot-time reconciliation.
   *
   * Reads the JSONL, computes per-call_id final status, and for any entry
   * still "pending" (i.e., orphaned from a prior process):
   *   - For each staged_path ending in .tmp:
   *       • if .tmp exists and final does NOT → unlink .tmp (rollback)
   *       • if both exist                      → unlink the orphan .tmp
   *   - Appends an "end" event with status="abandoned".
   *
   * Returns { abandoned, settled } counts for the caller to log.
   */
  reconcile(): Promise<{ abandoned: number; settled: number }>;
}

// ─── stableCallId ─────────────────────────────────────────────────────────────

/**
 * Derives a deterministic call_id from (turnId, toolName, input).
 *
 * Determinism is required so that if the same logical call is re-attempted
 * after a partial failure, the log can identify it as the same operation.
 * Uses SHA-256; returns the first 16 hex chars (64 bits — collision-safe for
 * session-scoped call volumes).
 */
export function stableCallId(turnId: string, toolName: string, input: unknown): string {
  const h = crypto.createHash("sha256");
  h.update(turnId);
  h.update(":");
  h.update(toolName);
  h.update(":");
  h.update(JSON.stringify(input ?? null));
  return h.digest("hex").slice(0, 16);
}

// ─── createPendingCallsLog ────────────────────────────────────────────────────

/**
 * Create a PendingCallsLog for the given session.
 *
 * @param sessionId  Session identifier — passed to getSessionDir() to resolve
 *                   the sibling audit directory under ~/.muonroi-cli/sessions/.
 *                   Does NOT interact with SQLite.
 */
export function createPendingCallsLog(sessionId: string): PendingCallsLog {
  // Resolve the session directory lazily on first write (avoids blocking import).
  let dirPromise: Promise<string> | null = null;

  async function getDir(): Promise<string> {
    if (!dirPromise) {
      dirPromise = getSessionDir(sessionId);
    }
    return dirPromise;
  }

  // All writes are serialised through this chain to prevent JSONL corruption.
  let writeChain: Promise<void> = Promise.resolve();

  async function appendLine(obj: unknown): Promise<void> {
    const dir = await getDir();
    const filePath = path.join(dir, "pending_calls.jsonl");
    await fs.appendFile(filePath, `${JSON.stringify(obj)}\n`, "utf8");
  }

  function serialize(work: () => Promise<void>): Promise<void> {
    // The chain continues even if the previous step throws, so errors in one
    // write don't permanently break the chain.
    writeChain = writeChain.then(work, work);
    return writeChain;
  }

  async function readEntries(): Promise<Array<PendingCallEntry & { event?: string }>> {
    const dir = await getDir();
    const filePath = path.join(dir, "pending_calls.jsonl");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PendingCallEntry & { event?: string });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  return {
    async begin(entry) {
      const full: PendingCallEntry & { event: string } = {
        event: "begin",
        ...entry,
        started_ms: Date.now(),
        status: "pending",
      };
      return serialize(() => appendLine(full));
    },

    async end(call_id, status) {
      return serialize(() =>
        appendLine({
          event: "end",
          call_id,
          status,
          ended_ms: Date.now(),
        }),
      );
    },

    async reconcile() {
      const lines = await readEntries();

      // Build latest-status-per-call_id by replaying the event log.
      const byId = new Map<string, PendingCallEntry>();
      for (const line of lines) {
        if (line.event === "begin") {
          byId.set(line.call_id, {
            call_id: line.call_id,
            tool_name: line.tool_name,
            started_ms: line.started_ms,
            status: "pending",
            staged_paths: line.staged_paths,
          });
        } else if (line.event === "end") {
          const existing = byId.get(line.call_id);
          if (existing) {
            byId.set(line.call_id, {
              ...existing,
              status: line.status,
              ended_ms: line.ended_ms,
            });
          }
        }
      }

      const stillPending = [...byId.values()].filter((e) => e.status === "pending");

      for (const entry of stillPending) {
        // Best-effort cleanup of staged .tmp paths.
        for (const tmp of entry.staged_paths ?? []) {
          if (!tmp.endsWith(".tmp")) continue; // safety guard

          const finalPath = tmp.slice(0, -4); // strip ".tmp"

          try {
            const tmpExists = await fs
              .access(tmp)
              .then(() => true)
              .catch(() => false);
            const finalExists = await fs
              .access(finalPath)
              .then(() => true)
              .catch(() => false);

            if (tmpExists) {
              // Whether or not the final file exists, the .tmp is now orphaned.
              // Case A (rollback): .tmp exists, final does NOT → partial write,
              //   unlink the .tmp (the rename never completed).
              // Case B (cleanup): both exist → rename completed pre-crash,
              //   unlink the now-orphaned .tmp.
              await fs.unlink(tmp);
            } else if (!tmpExists && !finalExists) {
              // Neither exists — nothing to do.
            }

            // Suppress unused variable warning for finalExists in case A/B above.
            void finalExists;
          } catch (err) {
            console.warn(`[muonroi-cli] reconcile: could not clean staged path ${tmp}: ${(err as Error).message}`);
          }
        }

        // Mark the entry as abandoned in the log.
        await serialize(() =>
          appendLine({
            event: "end",
            call_id: entry.call_id,
            status: "abandoned",
            ended_ms: Date.now(),
          }),
        );
      }

      return { abandoned: stillPending.length, settled: 0 };
    },
  };
}
