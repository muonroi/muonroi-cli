import { createHash } from "crypto";

/**
 * Per-tool-registry guard that enforces "read before edit/overwrite" semantics
 * (mirrors Claude Code's safety rule). Prevents the LLM from blindly
 * overwriting files whose current content it has not seen — and from
 * stomping on changes another process made between read and write.
 *
 * The tracker keys on the absolute, normalized file path. It stores a
 * SHA-256 of the content at read time; on write, the on-disk content is
 * re-hashed and compared. A mismatch means the file changed externally
 * since the last read, and the write is rejected.
 *
 * New-file creation is allowed without a prior read (there is nothing to
 * read). After every successful write/edit, the tracker is refreshed so
 * back-to-back edits in the same tool run keep working. Rebuilding the tool
 * registry creates a fresh tracker; earlier-turn reads are not restored here.
 */
export interface ReadRecord {
  hash: string;
  mtimeMs: number;
}

export class FileTracker {
  private records = new Map<string, ReadRecord>();
  // Absolute paths the agent CREATED/MODIFIED via write_file/edit_file in this
  // tool run. Distinct from `records` (which also holds read-only files). The
  // git_commit tool stages exactly these so an agent commit never sweeps the
  // user's unrelated working-tree changes or files the agent merely read.
  private written = new Set<string>();

  /** Record content as known to the agent. Called after a successful read. */
  markRead(absolutePath: string, content: string, mtimeMs: number): void {
    this.records.set(absolutePath, { hash: hashOf(content), mtimeMs });
  }

  /** Record that the agent wrote/edited this file. Called after a successful write. */
  markWritten(absolutePath: string): void {
    this.written.add(absolutePath);
  }

  /** Absolute paths the agent created or modified via this registry's tools. */
  writtenPaths(): string[] {
    return [...this.written];
  }

  /** True if the file has been recorded as read by this registry. */
  hasRead(absolutePath: string): boolean {
    return this.records.has(absolutePath);
  }

  /**
   * Verify a write to an EXISTING file is safe. Returns null when the write
   * may proceed, or a human-readable error message otherwise.
   */
  checkBeforeWrite(absolutePath: string, currentContent: string): string | null {
    const rec = this.records.get(absolutePath);
    if (!rec) {
      return (
        `File must be read first: ${absolutePath}. ` +
        `Use read_file to load the current content in this tool run, then retry the edit/write. ` +
        `Reads from earlier turns may no longer be registered.`
      );
    }
    if (rec.hash !== hashOf(currentContent)) {
      return (
        `File has changed on disk since last read: ${absolutePath}. ` +
        `Re-read it with read_file to see the current content, then retry.`
      );
    }
    return null;
  }

  /** Drop the record (e.g. file was deleted). */
  forget(absolutePath: string): void {
    this.records.delete(absolutePath);
  }

  /** Drop everything (e.g. on /clear). */
  reset(): void {
    this.records.clear();
    this.written.clear();
  }
}

function hashOf(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
