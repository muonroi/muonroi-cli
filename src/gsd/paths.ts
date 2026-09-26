import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runAnchoredStateRoot } from "../flow/run-root.js";
import { canonicalize, isInside, worktreeRootOfDir } from "../tools/write-scope.js";
import { loadProjectSettings } from "../utils/settings.js";

export const PLANNING_DIR = ".planning";

/**
 * Consolidated home for GSD planning state once it is folded under the flow
 * directory (`.muonroi-flow/planning/`). See `src/flow/fold-planning.ts`.
 */
export const FOLDED_PLANNING_DIR = join(".muonroi-flow", "planning");

/**
 * Explicit relocation override for GSD planning state — env `MUONROI_STATE_DIR`
 * (wins) or project setting `stateDir` (`.muonroi-cli/settings.json`).
 *
 * Exists for repos that already use `.planning/` at their root for something
 * of their own (e.g. a Shipd/Olympus challenge repo's own plan folders):
 * without this, `planningRoot` picks `.planning/` unconditionally whenever it
 * exists, so every muonroi-cli session litters that repo's own directory with
 * `STATE.md` / `config.json` / `phases/`. Returns undefined when neither is
 * set — callers fall through to the existing `.planning/` / folded-location
 * logic unchanged.
 *
 * Round-2 fix (HIGH: a repo-committed `stateDir` could point the CLI at
 * `/etc`, `../../x`, or any path outside the checkout):
 *   - env `MUONROI_STATE_DIR` is USER-controlled (an attacker who can set the
 *     invoking user's environment already owns the session), so it is
 *     trusted and allowed anywhere — but the directory is created 0700 (not
 *     whatever the process umask would otherwise give it) since it's about
 *     to hold session state.
 *   - project setting `stateDir` is REPO-controlled (committed, reviewed by
 *     nobody in particular) — only a path that resolves, symlinks and all
 *     (`canonicalize` = realpath the deepest existing ancestor), to somewhere
 *     INSIDE the project's own git root is honoured. An absolute path, or a
 *     relative one that escapes the root (`../../x`), is rejected with a
 *     console warning and the caller falls back to the default `.planning/`/
 *     folded-location resolution — never silently written elsewhere.
 */
export function resolveStateDirOverride(cwd: string): string | undefined {
  const envDir = process.env.MUONROI_STATE_DIR;
  if (envDir?.trim()) {
    const resolved = isAbsolute(envDir) ? envDir : join(cwd, envDir);
    try {
      mkdirSync(resolved, { recursive: true, mode: 0o700 });
    } catch (err) {
      console.error(`[gsd-paths] could not create MUONROI_STATE_DIR ${resolved}: ${(err as Error).message}`);
    }
    return resolved;
  }

  const projectDir = loadProjectSettings().stateDir;
  if (projectDir?.trim()) {
    if (isAbsolute(projectDir)) {
      console.error(
        `[gsd-paths] project setting "stateDir" (${projectDir}) is absolute — rejected (must be a relative ` +
          "path inside the project's git root). Falling back to the default planning location.",
      );
      return undefined;
    }
    const root = worktreeRootOfDir(cwd);
    if (!root) {
      console.error(
        `[gsd-paths] project setting "stateDir" (${projectDir}) ignored — ${cwd} is not inside a git repo, so ` +
          "there is no root to confine it to. Falling back to the default planning location.",
      );
      return undefined;
    }
    const candidate = canonicalize(join(cwd, projectDir));
    if (!isInside(root, candidate)) {
      console.error(
        `[gsd-paths] project setting "stateDir" (${projectDir}) escapes the project's git root (${root}) — ` +
          "rejected. Falling back to the default planning location.",
      );
      return undefined;
    }
    return candidate;
  }
  return undefined;
}

/**
 * Resolve the active GSD planning root.
 *
 * Sprint-2 (Part A, staged per REV-3 Kill B): `.planning/` still WINS whenever
 * it exists — that is where the `gsd-tools.cjs` subprocess writes phases today,
 * so reads and writes stay in sync and behavior is byte-identical to before.
 * The folded location (`.muonroi-flow/planning/`) is used only as a READ
 * fallback — i.e. once the subprocess writer is removed (Part B) and `.planning/`
 * no longer exists, GSD reads transparently continue from the consolidated tree.
 * This is purely additive: no live cutover, no desync risk.
 *
 * `resolveStateDirOverride` (env `MUONROI_STATE_DIR` / project `stateDir`) is
 * checked FIRST and short-circuits all of the above when set — see its doc
 * comment. Default behavior (no override configured) is unchanged.
 */
export function planningRoot(rawCwd: string): string {
  const cwd = runAnchoredStateRoot(rawCwd);
  const override = resolveStateDirOverride(cwd);
  if (override) return override;
  const canonical = join(cwd, PLANNING_DIR);
  // Existing `.planning/` projects keep using it (back-compat, no disruption).
  if (existsSync(canonical)) return canonical;
  const folded = join(cwd, FOLDED_PLANNING_DIR);
  if (existsSync(folded)) return folded;
  // Part B step 2 — LIVE CUTOVER: now that native code owns all GSD path
  // resolution (the subprocess that hardcoded `.planning/` is gone), a FRESH
  // project consolidates its GSD state under `.muonroi-flow/planning/` — one
  // state tree alongside the /ideal `.muonroi-flow/runs/`. Opt back into the
  // legacy split location with MUONROI_GSD_LEGACY_PLANNING=1.
  if (process.env.MUONROI_GSD_LEGACY_PLANNING === "1") return canonical;
  return folded;
}

export function planningArtifact(cwd: string, name: string): string {
  return join(planningRoot(cwd), name);
}

export function planningPhasesRoot(cwd: string): string {
  return join(planningRoot(cwd), "phases");
}

export function listPhaseDirs(cwd: string): string[] {
  const root = planningPhasesRoot(cwd);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    console.error(`[gsd-paths] listPhaseDirs failed: ${(err as Error).message}`);
    return [];
  }
}

export function latestPhaseDir(cwd: string): string | null {
  const dirs = listPhaseDirs(cwd);
  return dirs.length ? dirs[dirs.length - 1]! : null;
}

export function phaseDirPath(cwd: string, dirName: string, artifact?: string): string {
  const base = join(planningPhasesRoot(cwd), dirName);
  return artifact ? join(base, artifact) : base;
}
