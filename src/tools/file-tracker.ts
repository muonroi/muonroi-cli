import { createHash } from "crypto";

/**
 * Per-session guard that enforces "read before edit/overwrite" semantics
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
 * back-to-back edits in the same session keep working.
 */
export interface ReadRecord {
  hash: string;
  mtimeMs: number;
}

export class FileTracker {
  private records = new Map<string, ReadRecord>();

  /** Record content as known to the agent. Called after a successful read. */
  markRead(absolutePath: string, content: string, mtimeMs: number): void {
    this.records.set(absolutePath, { hash: hashOf(content), mtimeMs });
  }

  /** True if the file has been recorded as read this session. */
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
        `Use the read_file tool to load the current content, then retry the edit/write.`
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
  }
}

function hashOf(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
