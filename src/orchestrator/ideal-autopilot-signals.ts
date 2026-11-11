/**
 * Host I/O behind the `/ideal` autopilot (see ideal-autopilot.ts): the three
 * progress signals and the spend of a budget window. Everything here reads state
 * the host already owns; none of it asks the model anything.
 *
 * Paths the host (or the FLOW engine) rewrites on every turn regardless of what
 * the model did — `.muonroi-cli/`, `.planning/`, `.muonroi-flow/` (STATE.md is
 * re-synced each turn) — are excluded from the working-tree fingerprint, or each
 * turn would look like progress. Plan/verify rewrites are tracked separately in
 * the FLOW fingerprint by their own mtimes.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { sumSessionCostUsdSince } from "../storage/usage.js";
import { readCostLog } from "../usage/cost-log.js";
import { logger } from "../utils/logger.js";
import { planningArtifact } from "../workflow/paths.js";
import { readCompletionScope, readState } from "../workflow/workflow-engine.js";
import type { AutopilotSignals } from "./ideal-autopilot.js";
import type { IdealJob } from "./ideal-coordination.js";

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 5000;
const MAX_WALK_DEPTH = 8;
const GIT_TIMEOUT_MS = 15_000;

/** Top-level names the host/FLOW engine rewrites each turn or that only hold build output. */
const HOST_OWNED = [".muonroi-cli", ".planning", ".muonroi-flow", ".git"];
const WALK_SKIP = new Set([
  ...HOST_OWNED,
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "bin",
  "obj",
  ".next",
  ".venv",
  "__pycache__",
]);

const isHostOwned = (relPath: string) => {
  const first = relPath.split(/[\\/]/, 1)[0] ?? "";
  return HOST_OWNED.includes(first);
};

function stamp(path: string): string {
  try {
    const st = statSync(path);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch (err) {
    // A path git lists but that is gone (deleted file) is part of the fingerprint, not an error.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    logger.warn("orchestrator", "cannot stat path for the workspace fingerprint", { path, error: String(err) });
    return "unreadable";
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    // Not a repo / no commits yet / git missing: the caller falls back to a directory walk.
    logger.debug("orchestrator", "git unavailable for the workspace fingerprint", { cwd, args, error: String(err) });
    return null;
  }
}

function walk(root: string): string[] {
  const lines: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (lines.length >= MAX_ENTRIES || depth > MAX_WALK_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logger.warn("orchestrator", "cannot list directory for the workspace fingerprint", { dir, error: String(err) });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= MAX_ENTRIES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) visit(full, depth + 1);
      } else if (entry.isFile()) {
        lines.push(`${relative(root, full).split(sep).join("/")}|${stamp(full)}`);
      }
    }
  };
  visit(root, 0);
  return lines;
}

/**
 * Fingerprint of the working tree: HEAD plus every changed/untracked file's
 * path, mtime and size (git repo), or a bounded walk of the tree (no repo).
 * Any edit, create, delete or commit changes it.
 */
export async function workspaceFingerprint(cwd: string): Promise<string> {
  const hash = createHash("sha1");
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (top) {
    const head = (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]))?.trim() ?? "";
    const status = await git(cwd, [
      "-c",
      "core.quotepath=off",
      "status",
      "--porcelain=v1",
      "-z",
      "-uall",
      "--no-renames",
      "--",
      ".",
    ]);
    // cwd's location inside the repo, as git spells it ("" at the top, "sub/" below).
    // Host-owned dirs are judged on the path relative to cwd computed from this
    // prefix, NOT relative(cwd, join(top, path)): git prints top as a REAL path, so
    // on macOS (/var -> /private/var tmpdirs) that relative path began with "../.."
    // and .planning/STATE.md counted as a workspace change (ci-matrix macOS,
    // 2026-11-11, "ignores what the host and FLOW rewrite every turn").
    const prefix = (await git(cwd, ["rev-parse", "--show-prefix"]))?.trim() ?? "";
    if (status !== null) {
      hash.update(`git|${head}\n`);
      const entries = status.split("\0").filter(Boolean).slice(0, MAX_ENTRIES);
      for (const entry of entries) {
        const path = entry.slice(3);
        const fromCwd = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
        if (isHostOwned(fromCwd)) continue;
        hash.update(`${entry.slice(0, 2)}|${path}|${stamp(join(top, path))}\n`);
      }
      return hash.digest("hex");
    }
  }
  hash.update("walk\n");
  for (const line of walk(cwd)) hash.update(`${line}\n`);
  return hash.digest("hex");
}

/** FLOW phase | plan verified | implementation verification | plan and verify artifact mtimes. */
export function flowFingerprint(cwd: string): string {
  try {
    const state = readState(cwd);
    const scope = readCompletionScope(cwd);
    const mtimes = ["PLAN.md", "VERIFY.md"].map((name) => {
      const path = planningArtifact(cwd, name);
      return existsSync(path) ? stamp(path) : "-";
    });
    return [
      state.phase ?? "-",
      state.planVerified ? "verified" : "unverified",
      scope.implementationVerification,
      ...mtimes,
    ].join("|");
  } catch (err) {
    logger.warn("orchestrator", "FLOW state unreadable for the autopilot fingerprint", { cwd, error: String(err) });
    return "unreadable";
  }
}

/** Counts of the run's delegations: started, and those that reached a terminal status. */
export function delegationCounts(jobs: readonly IdealJob[]): { started: number; finished: number } {
  return { started: jobs.length, finished: jobs.filter((j) => j.status !== "running").length };
}

export async function collectSignals(cwd: string, jobs: readonly IdealJob[]): Promise<AutopilotSignals> {
  const counts = delegationCounts(jobs);
  return {
    workspace: await workspaceFingerprint(cwd),
    delegationsStarted: counts.started,
    delegationsFinished: counts.finished,
    flow: flowFingerprint(cwd),
  };
}

/**
 * USD spent by this session since `sinceIso`: the main process's `usage_events`
 * plus the workers' cost-log rows (workers persist no session, so the cost log
 * is their only record; rows carry `parentSessionId`). Null = could not be
 * measured; the caller then does not enforce a cost cap.
 */
export async function spentSince(sessionId: string | undefined, sinceIso: string): Promise<number | null> {
  if (!sessionId) return null;
  try {
    let usd = sumSessionCostUsdSince(sessionId, sinceIso);
    const sinceMs = Date.parse(sinceIso);
    const days = new Set<string>();
    for (let t = sinceMs; t <= Date.now() + 60_000; t += 24 * 3_600_000)
      days.add(new Date(t).toISOString().slice(0, 10));
    days.add(new Date().toISOString().slice(0, 10));
    for (const day of days) {
      for (const row of await readCostLog(day)) {
        if (row.parentSessionId === sessionId && row.ts >= sinceMs) usd += row.estimatedUsd;
      }
    }
    return usd;
  } catch (err) {
    logger.warn("orchestrator", "spend could not be measured; the cost budget is not enforced this turn", {
      sessionId,
      error: String(err),
    });
    return null;
  }
}
