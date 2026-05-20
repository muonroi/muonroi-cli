/**
 * Plan 23-fix — persist scaffold inputs to `.muonroi-flow/runs/<runId>/` so a
 * scaffold failure (BB template not installed, restore conflict, etc.) can be
 * retried across CLI restarts without re-running the council debate.
 *
 * Design notes:
 *   - `runId` is the loop-driver run id when available. When the user reached
 *     the init-new form via the manual halt-card path (no preceding /ideal
 *     debate), runId falls back to the DB session id so each session gets its
 *     own checkpoint dir.
 *   - Inputs are stored as plain JSON. Functions (`onPackageProgress`,
 *     `onTemplateMissing`) are NOT serialised — they get re-attached when the
 *     checkpoint is replayed by the TUI.
 *   - Status transitions: `submitted` → (`done` | `error`). `submitted` rows
 *     left behind from a hard crash surface as resumable candidates on
 *     startup.
 *   - File is rewritten on every state change. Single-writer (the TUI) so a
 *     simple `writeFile` is sufficient — no lockfile dance.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { FLOW_DIR_NAME } from "./scaffold.js";

export interface ScaffoldCheckpoint {
  /** Schema version — bump when the JSON shape changes. */
  schemaVersion: 1;
  runId: string;
  /** ISO timestamp when this checkpoint was first written. */
  createdAt: string;
  /** ISO timestamp of the last status update. */
  updatedAt: string;
  status: "submitted" | "done" | "error";
  /** Last error message when status === "error". Surfaced in the resume UI. */
  errorMessage?: string;
  /** Project dir when status === "done". */
  projectDir?: string;
  /** Original /ideal prompt that triggered this scaffold, if any. */
  originalPrompt?: string | null;
  /** Inputs replayable by initNewProject(). */
  inputs: {
    projectName: string;
    feStack: "react" | "angular" | "none";
    bbTemplate?: { shortName: string; nugetId: string; version: string };
    eePackages?: string[];
    commercial?: boolean;
  };
}

const CHECKPOINT_FILE = "scaffold-checkpoint.json";

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, FLOW_DIR_NAME, "runs", runId);
}

function checkpointPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), CHECKPOINT_FILE);
}

/**
 * Write or update the scaffold checkpoint for `runId` under `cwd`. Creates the
 * .muonroi-flow/runs/<runId>/ directory if missing. Safe to call repeatedly —
 * only the `updatedAt` and the mutable fields change after the first write.
 */
export async function writeScaffoldCheckpoint(
  cwd: string,
  runId: string,
  patch: Omit<ScaffoldCheckpoint, "schemaVersion" | "createdAt" | "updatedAt" | "runId">,
): Promise<string> {
  const dir = runDir(cwd, runId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = checkpointPath(cwd, runId);

  const now = new Date().toISOString();
  let createdAt = now;
  try {
    const existing = await fs.readFile(filePath, "utf8");
    const prev = JSON.parse(existing) as ScaffoldCheckpoint;
    if (prev.createdAt) createdAt = prev.createdAt;
  } catch {
    // First write — keep createdAt = now.
  }

  const checkpoint: ScaffoldCheckpoint = {
    schemaVersion: 1,
    runId,
    createdAt,
    updatedAt: now,
    ...patch,
  };
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf8");
  return filePath;
}

/**
 * Read a scaffold checkpoint. Returns null when the file is missing or the
 * shape is unrecognised — corrupted checkpoints should not crash the TUI.
 */
export async function readScaffoldCheckpoint(cwd: string, runId: string): Promise<ScaffoldCheckpoint | null> {
  try {
    const raw = await fs.readFile(checkpointPath(cwd, runId), "utf8");
    const parsed = JSON.parse(raw) as ScaffoldCheckpoint;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.runId !== "string" || !parsed.inputs?.projectName) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Scan `.muonroi-flow/runs/*` for checkpoints whose status is not `done`.
 * Returned newest-first. Used at TUI startup to offer cross-session resume.
 */
export async function listResumableScaffoldCheckpoints(cwd: string): Promise<ScaffoldCheckpoint[]> {
  const runsRoot = path.join(cwd, FLOW_DIR_NAME, "runs");
  let entries: string[];
  try {
    entries = await fs.readdir(runsRoot);
  } catch {
    return [];
  }
  const out: ScaffoldCheckpoint[] = [];
  for (const id of entries) {
    const ck = await readScaffoldCheckpoint(cwd, id);
    if (ck && ck.status !== "done") {
      out.push(ck);
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
