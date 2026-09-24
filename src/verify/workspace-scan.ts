/**
 * Where a recipe detector is allowed to look, and how it names a command that
 * has to run somewhere other than the repository root.
 *
 * Two detectors had independently grown a bounded walk — `findDotnetMarkers`
 * (`src/verify/recipes.ts`, `depth < 2`) and `findPytestTargets`
 * (`src/verify/pytest-detect.ts`, `MAX_DEPTH = 2`) — with the same depth and
 * nearly the same skip list. Every other detector had none at all and so could
 * only ever see the root. This module is the ONE place that decides how far to
 * look and what to skip, so the detectors cannot disagree about where a
 * sub-project may live.
 *
 * The bound is the one `findDotnetMarkers` and `findPytestTargets` already
 * justify: it covers a root-level layout, a one-level split like `backend/` +
 * `frontend/` (the real `D:/sources/CompanyLibs/qa-platform`), and a two-level
 * monorepo like `packages/api/`, without walking a whole tree on every recipe
 * inference — which happens on `/ideal`'s hot path and again per verify-floor
 * run (`resolveFloorCommands` / `resolveFloorEcosystem`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BUILD_OUTPUT_DIRS } from "../product-loop/language-registry.js";

/** How deep a detector may look below the repository root. */
export const MAX_SCAN_DEPTH = 2;

/**
 * Virtualenv directory names that carry no dot, so the dot-prefix skip below
 * does not already cover them. A venv vendors thousands of installed packages
 * and their manifests; treating one as a sub-project is never right.
 */
const VENV_DIR_NAMES = new Set(["venv", "env", "site-packages"]);

/**
 * Directories a scan must not descend into.
 *
 * Dot-prefixed covers `.venv`, `.git`, `.pytest_cache`, `.tox`, `.mypy_cache`.
 * `BUILD_OUTPUT_DIRS` (src/product-loop/language-registry.ts) contributes
 * `node_modules`, `dist`, `build`, `obj`, `target`, `__pycache__` — the same set
 * the language registry already excludes when it sizes a repo, so a vendored
 * copy of a package (or a Cargo `target/`) is never mistaken for a sub-project.
 */
export function skipScanDir(name: string): boolean {
  return name.startsWith(".") || BUILD_OUTPUT_DIRS.has(name) || VENV_DIR_NAMES.has(name);
}

/** Directory entries, or none — an unreadable directory is "nothing here", not an error. */
export function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    // Recipe inference runs on arbitrary user trees; a permission-denied or
    // deleted directory must degrade to "no sub-project here" rather than take
    // down the whole verification recipe.
    return [];
  }
}

export function isDirectory(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

export function fileExistsIn(dir: string, file: string): boolean {
  try {
    return fs.existsSync(path.join(dir, file));
  } catch {
    return false;
  }
}

/**
 * Emitted commands run in a shell, and on Windows `path.join` yields
 * backslashes that a POSIX shell reads as escapes. The recipes' own
 * installCommands are POSIX (`cd frontend && npm ci`, `.venv/bin/pip`) and the
 * verify sandbox is Debian, so relative paths are normalised to forward slashes
 * — which cmd.exe and PowerShell also accept.
 */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * A command, run where the sub-project actually is.
 *
 * `cd <dir> && …` is the shape the shipped pytest path already emits
 * (`buildPytestCommand`) and the shape qa-platform's own model-written recipe
 * used (`cd frontend && npm ci`), so every relocated command in the pipeline
 * looks the same to the verify floor's `spawn(command, {shell: true})`.
 */
export function commandIn(dir: string, command: string): string {
  return dir ? `cd ${toPosixPath(dir)} && ${command}` : command;
}

export interface MarkedDirectory<T> {
  /** Directory relative to the scanned root; "" is the root itself. */
  dir: string;
  value: T;
}

/**
 * Every directory under `root` (bounded by {@link MAX_SCAN_DEPTH}) that
 * `classify` claims, shallowest first then alphabetical so the result is stable
 * across platforms and filesystems.
 *
 * `pruneClaimed` stops the walk descending into a directory that was claimed.
 * That is what a Cargo workspace needs — `cargo test` at the workspace root
 * already runs every member, so descending would emit a second, redundant test
 * command per crate. A Node package root is the opposite case and must NOT
 * prune: qa-platform's root `package.json` declares only a `verify` script and
 * does not build or test `frontend/` at all, so pruning there would lose the
 * front end's build gate — which is the gap this scan exists to close.
 *
 * Never throws: callers get an empty list, which yields empty command lists —
 * an honest "nothing found", not a crash.
 */
export function findMarkedDirectories<T>(
  root: string,
  classify: (dir: string) => T | null,
  opts: { pruneClaimed?: boolean } = {},
): Array<MarkedDirectory<T>> {
  const found: Array<MarkedDirectory<T> & { depth: number }> = [];

  const visit = (dir: string, depth: number): void => {
    const value = classify(dir);
    if (value !== null && value !== undefined) {
      found.push({ dir: path.relative(root, dir), value, depth });
      if (opts.pruneClaimed) return;
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    for (const name of safeReaddir(dir).sort()) {
      if (skipScanDir(name)) continue;
      const full = path.join(dir, name);
      if (isDirectory(full)) visit(full, depth + 1);
    }
  };

  try {
    visit(root, 0);
  } catch {
    // Defensive: `visit` already swallows per-directory failures through
    // `safeReaddir` / `isDirectory`, so reaching here means the root itself was
    // unusable, or a `classify` implementation threw.
    return [];
  }

  return found
    .sort((a, b) => a.depth - b.depth || a.dir.localeCompare(b.dir))
    .map(({ depth: _depth, ...marked }) => marked);
}
