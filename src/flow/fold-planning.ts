/**
 * Fold `.planning/` into `.muonroi-flow/planning/` — net-new, non-destructive
 * consolidation migration (Sprint-2 Part A, staged per REV-3 Kill B).
 *
 * WHY staged / copy-only:
 *   GSD phases are still CREATED by the external `gsd-tools.cjs` subprocess,
 *   which writes to `.planning/` (hardcoded). Until that writer is removed
 *   (Part B — deferred), `.planning/` must remain the live tree. So this
 *   migration COPIES `.planning/` into the consolidated location and NEVER
 *   deletes the original — the read layer (`paths.ts::planningRoot`) keeps
 *   preferring `.planning/` while it exists, so there is zero desync risk.
 *   Once Part B stops writing `.planning/`, the folded tree becomes the live
 *   source transparently via the same read fallback.
 *
 * Guarantees:
 *   - Idempotent: guarded by a `.migrated` marker (NOT by directory existence —
 *     an empty `.muonroi-flow/planning/` must not make the fold skip forever;
 *     see REV-2 Kill #2).
 *   - Non-destructive: source `.planning/` is left untouched.
 *   - Byte-preserving: every copied file is asserted equal in size to its source.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

const FLOW_DIR = ".muonroi-flow";
const PLANNING_DIR = ".planning";
const FOLDED_SUBDIR = "planning";
const MARKER = ".migrated";

export interface FoldResult {
  /** True when a fold copy was performed this call. */
  migrated: boolean;
  /** Reason a fold was skipped (marker present / no source). */
  skipReason?: "already-migrated" | "no-source";
  /** Number of files copied. */
  filesCopied: number;
  /** Absolute path to the folded planning root. */
  foldedRoot: string;
}

/** Recursively copy a directory, asserting byte-size preservation per file. */
async function copyTreePreserving(src: string, dest: string): Promise<number> {
  let copied = 0;
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied += await copyTreePreserving(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
      const [srcStat, destStat] = await Promise.all([fs.stat(from), fs.stat(to)]);
      if (srcStat.size !== destStat.size) {
        throw new Error(`fold-planning: byte mismatch copying ${from} (${srcStat.size} != ${destStat.size})`);
      }
      copied += 1;
    }
    // Symlinks / other node types are intentionally skipped — .planning holds
    // only regular files and dirs; a stray symlink is not worth following.
  }
  return copied;
}

/**
 * Perform the fold. Safe to call repeatedly; returns `{migrated:false}` when the
 * marker is already present or there is no `.planning/` to fold.
 */
export async function foldPlanningIntoFlow(cwd: string): Promise<FoldResult> {
  const foldedRoot = path.join(cwd, FLOW_DIR, FOLDED_SUBDIR);
  const markerPath = path.join(foldedRoot, MARKER);

  // Marker guard — idempotent regardless of whether the folded dir is empty.
  try {
    await fs.access(markerPath);
    return { migrated: false, skipReason: "already-migrated", filesCopied: 0, foldedRoot };
  } catch {
    /* marker absent → proceed */
  }

  const source = path.join(cwd, PLANNING_DIR);
  try {
    const st = await fs.stat(source);
    if (!st.isDirectory()) {
      return { migrated: false, skipReason: "no-source", filesCopied: 0, foldedRoot };
    }
  } catch {
    return { migrated: false, skipReason: "no-source", filesCopied: 0, foldedRoot };
  }

  const filesCopied = await copyTreePreserving(source, foldedRoot);

  // Stamp the marker LAST so a crash mid-copy leaves no false "migrated" flag —
  // the next call re-copies (copyFile overwrites, byte-assert still holds).
  await fs.writeFile(
    markerPath,
    JSON.stringify({ migratedFrom: PLANNING_DIR, filesCopied, note: "copy-only; original left in place" }, null, 2),
    "utf8",
  );

  return { migrated: true, filesCopied, foldedRoot };
}
