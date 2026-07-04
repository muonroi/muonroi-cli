import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PLANNING_DIR = ".planning";

export function planningRoot(cwd: string): string {
  return join(cwd, PLANNING_DIR);
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
