import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PLANNING_DIR = ".planning";

/**
 * Consolidated home for GSD planning state once it is folded under the flow
 * directory (`.muonroi-flow/planning/`). See `src/flow/fold-planning.ts`.
 */
export const FOLDED_PLANNING_DIR = join(".muonroi-flow", "planning");

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
 */
export function planningRoot(cwd: string): string {
  const canonical = join(cwd, PLANNING_DIR);
  if (existsSync(canonical)) return canonical;
  const folded = join(cwd, FOLDED_PLANNING_DIR);
  if (existsSync(folded)) return folded;
  return canonical;
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
