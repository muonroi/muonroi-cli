/**
 * Directory scaffolding for .muonroi-flow/.
 *
 * Creates the locked directory structure on first access. Idempotent —
 * second call does not overwrite existing files.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const FLOW_DIR_NAME = ".muonroi-flow";

const TOP_LEVEL_FILES = ["roadmap.md", "state.md", "backlog.md", "decisions.md"];
const SUBDIRS = ["history", "runs"];

/**
 * Ensure the .muonroi-flow/ directory exists with the locked structure:
 *
 * .muonroi-flow/
 * ├── roadmap.md
 * ├── state.md
 * ├── backlog.md
 * ├── decisions.md
 * ├── history/
 * └── runs/
 *
 * Returns the absolute path to the .muonroi-flow/ directory.
 * Only creates files if they do NOT already exist (idempotent).
 */
export async function ensureFlowDir(cwd: string): Promise<string> {
  const flowDir = path.join(cwd, FLOW_DIR_NAME);

  // Create the root directory and subdirectories
  await fs.mkdir(flowDir, { recursive: true });
  for (const sub of SUBDIRS) {
    await fs.mkdir(path.join(flowDir, sub), { recursive: true });
  }

  // Create top-level files only if absent (idempotent)
  for (const file of TOP_LEVEL_FILES) {
    const filePath = path.join(flowDir, file);
    try {
      await fs.access(filePath);
      // File exists — do not overwrite
    } catch {
      // ENOENT — create empty file
      await fs.writeFile(filePath, "", "utf8");
    }
  }

  return flowDir;
}
