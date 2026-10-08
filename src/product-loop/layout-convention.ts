// src/product-loop/layout-convention.ts
/**
 * F4b — state the repo's OWN layout convention, with the counts as evidence.
 *
 * F4a taught the audit to count a repository's files. Counting them is not the
 * same as telling the planner where new code belongs, and the gap cost a full
 * phase: run `mu229bfiaeec` on tcis-libraries wrote nine `.cs` files into
 * `src/analyzers/TCIS.CodeStandards/`, a directory the solution does not
 * reference. Nothing compiled, no test ran, ~50 minutes produced unbuildable
 * work — while 50 projects at `src/src/<Name>/<Name>.csproj` and 48 test
 * projects at `src/tests/<Name>.Tests/` sat in plain sight.
 *
 * This module derives that convention and renders it as a stated rule with the
 * observed counts attached, because the counts are what make it falsifiable:
 * "projects live in src/src/" is an assertion a model can talk itself out of,
 * "50 of them do" is evidence it has to argue with.
 *
 * REPORT ONLY. Nothing here enforces, validates, rewrites a path, or fails.
 * A wrong convention that blocks work is worse than one the planner ignores,
 * so every uncertain case degrades to silence rather than to a guess.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  BUILD_OUTPUT_DIRS,
  isProjectManifest,
  isSolutionManifest,
  isTestDirName,
  splitTestSuffix,
} from "./language-registry.js";

/**
 * How many sibling projects must share a directory before it is called a
 * convention.
 *
 * Three, because two is a coincidence — a repo with `api/` and `worker/` has a
 * pair, not a rule, and telling the planner "projects live in X" on that
 * evidence invents a law from an accident. Three is the smallest count at which
 * a directory is being used repeatedly and on purpose. Pinned by test so the
 * boundary is a decision rather than a leftover.
 */
export const MIN_CONVENTION_EXAMPLES = 3;

/**
 * How far the winning directory must outrank the runner-up.
 *
 * A bare majority was the obvious choice and is wrong here: measured on
 * tcis-libraries the dominant directory holds 50 of 94 non-test projects —
 * 53%, one project away from falling under a >50% bar and silencing the block
 * for the very repo this slice exists to fix. The honest signal is margin, not
 * share: `src/src` (50) against the runner-up `src/samples` (18) is 2.8x, which
 * is unambiguous even though the share is not. 2x keeps a genuinely scattered
 * repo (three directories holding three projects each) silent, which is the
 * case that must not produce a confident answer.
 */
export const MIN_DOMINANCE_RATIO = 2;

/** Depth/entry caps. /ideal runs this per sprint, so it is bounded, not exhaustive. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 40_000;

export interface LayoutConvention {
  /** Repo-relative POSIX directory holding the project directories ("" = repo root). */
  projectsDir: string;
  projectsCount: number;
  /** How a project's manifest is named: `<Name>.csproj`, or a fixed `package.json`. */
  projectManifestName: string;
  testsDir?: string;
  testsCount?: number;
  /** Observed pairing suffix, verbatim — `.Tests`, `.Spec`. */
  testSuffix?: string;
  /** Repo-relative POSIX path of the solution/workspace index, when one exists. */
  solutionFile?: string;
  /** Projects + tests actually observed; the "(observed, N examples)" figure. */
  totalExamples: number;
}

interface ManifestHit {
  /** Repo-relative POSIX path. */
  rel: string;
  /** Directory the project lives in, e.g. "TCIS.Caching". */
  projectDir: string;
  /** Directory HOLDING that project directory, e.g. "src/src" ("" = repo root). */
  container: string;
  fileName: string;
  isTest: boolean;
}

/**
 * Walk `cwd` collecting project manifests and solution indexes. Bounded by
 * depth and entry count; an unreadable subtree contributes nothing rather than
 * failing the scan.
 */
async function collectManifests(cwd: string): Promise<{ projects: string[]; solutions: string[] }> {
  const projects: string[] = [];
  const solutions: string[] = [];
  let budget = MAX_ENTRIES;

  async function walk(dir: string, relDir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || budget <= 0) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Best-effort: permissions or a race with a delete must not fail /ideal.
      console.error(
        `[layout-convention] cannot read "${dir}": ${(err as Error)?.message}`,
        (err as Error)?.stack?.split("\n").slice(0, 3),
      );
      return;
    }
    for (const e of entries) {
      if (budget-- <= 0) return;
      if (e.name.startsWith(".") || BUILD_OUTPUT_DIRS.has(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        if (isSolutionManifest(e.name)) solutions.push(rel);
        else if (isProjectManifest(e.name)) projects.push(rel);
      }
    }
  }

  await walk(cwd, "", 0);
  return { projects, solutions };
}

function toHit(rel: string): ManifestHit | null {
  const segs = rel.split("/");
  // Need at least <projectDir>/<manifest>. A manifest sitting alone at the repo
  // root describes the repo itself, not a project-per-directory convention.
  if (segs.length < 2) return null;
  const fileName = segs[segs.length - 1] as string;
  const projectDir = segs[segs.length - 2] as string;
  const container = segs.slice(0, -2).join("/");
  const isTest = isTestDirName(projectDir) || segs.slice(0, -1).some((s) => isTestDirName(s));
  return { rel, projectDir, container, fileName, isTest };
}

/**
 * Pick the directory that dominates, or null when nothing does. Both guards
 * exist to keep silence the answer when the evidence is thin or split — see
 * {@link MIN_CONVENTION_EXAMPLES} / {@link MIN_DOMINANCE_RATIO}.
 */
function dominantContainer(hits: readonly ManifestHit[]): { dir: string; count: number } | null {
  if (hits.length === 0) return null;
  const tally = new Map<string, number>();
  for (const h of hits) tally.set(h.container, (tally.get(h.container) ?? 0) + 1);
  // Sort by count, then by path for a deterministic winner on exact ties.
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [dir, count] = ranked[0] as [string, number];
  if (count < MIN_CONVENTION_EXAMPLES) return null;
  const runnerUp = ranked[1]?.[1] ?? 0;
  if (runnerUp > 0 && count < runnerUp * MIN_DOMINANCE_RATIO) return null;
  return { dir, count };
}

/** `TCIS.X/TCIS.X.csproj` → `<Name>.csproj`; `foo/package.json` → `package.json`. */
function manifestNameShape(hits: readonly ManifestHit[], dir: string): string {
  const inDir = hits.filter((h) => h.container === dir);
  // Prefix, not "text before the first dot": .NET project names are themselves
  // dotted (`TCIS.Caching/TCIS.Caching.csproj`), so splitting on the first dot
  // compares "TCIS" against "TCIS.Caching" and never matches.
  const named = inDir.filter((h) => h.fileName.startsWith(`${h.projectDir}.`));
  if (named.length * 2 >= inDir.length && named.length > 0) {
    const sample = named[0] as ManifestHit;
    return `<Name>${sample.fileName.slice(sample.projectDir.length)}`;
  }
  return (inDir[0] as ManifestHit).fileName;
}

/**
 * The solution index a new project must be registered in. When a repo carries
 * several (templates and samples ship their own), the shallowest wins: it is
 * the one that spans the dominant project directory rather than a nested
 * sub-tree. Ties break on path for determinism.
 */
function pickSolution(solutions: readonly string[]): string | undefined {
  if (solutions.length === 0) return undefined;
  return [...solutions].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
}

/**
 * Derive the convention from collected manifest paths. Pure — the walk is the
 * caller's job — so the thresholds can be tested without a filesystem.
 */
export function deriveLayoutConvention(
  projectManifests: readonly string[],
  solutionFiles: readonly string[] = [],
): LayoutConvention | null {
  const hits = projectManifests.map(toHit).filter((h): h is ManifestHit => h !== null);
  const prod = hits.filter((h) => !h.isTest);
  const tests = hits.filter((h) => h.isTest);

  // The projects directory is the load-bearing claim ("where does new code
  // go?"). Without it there is nothing worth stating, so the whole block is
  // withheld rather than emitting a tests-only fragment.
  const projects = dominantContainer(prod);
  if (!projects) return null;

  const convention: LayoutConvention = {
    projectsDir: projects.dir,
    projectsCount: projects.count,
    projectManifestName: manifestNameShape(prod, projects.dir),
    totalExamples: projects.count,
  };

  const testHome = dominantContainer(tests);
  if (testHome) {
    convention.testsDir = testHome.dir;
    convention.testsCount = testHome.count;
    convention.totalExamples += testHome.count;

    // Pairing: report a suffix only when it actually pairs with a production
    // project of that name. A suffix that matches nothing is a naming habit,
    // not a rule the planner can follow.
    const prodNames = new Set(prod.map((h) => h.projectDir));
    const bySuffix = new Map<string, number>();
    for (const t of tests.filter((h) => h.container === testHome.dir)) {
      const split = splitTestSuffix(t.projectDir);
      if (!split || !prodNames.has(split.base)) continue;
      bySuffix.set(split.suffix, (bySuffix.get(split.suffix) ?? 0) + 1);
    }
    const topSuffix = [...bySuffix.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (topSuffix && topSuffix[1] >= MIN_CONVENTION_EXAMPLES) convention.testSuffix = topSuffix[0];
  }

  const solution = pickSolution(solutionFiles);
  if (solution) convention.solutionFile = solution;

  return convention;
}

/** Walk + derive. Returns null when the repo shows no dominant layout. */
export async function scanLayoutConvention(cwd: string | undefined): Promise<LayoutConvention | null> {
  if (!cwd) return null;
  const { projects, solutions } = await collectManifests(cwd);
  return deriveLayoutConvention(projects, solutions);
}

function joinDir(dir: string, tail: string): string {
  return dir ? `${dir}/${tail}` : tail;
}

/**
 * Render the convention. The counts stay in the output deliberately — they are
 * the evidence that turns an assertion into something the model must argue
 * with — so they are never trimmed to save tokens.
 */
export function formatLayoutConvention(c: LayoutConvention): string {
  const rows: Array<[string, string, string]> = [
    ["projects", joinDir(c.projectsDir, `<Name>/${c.projectManifestName}`), `(${c.projectsCount} found)`],
  ];
  if (c.testsDir !== undefined && c.testsCount !== undefined) {
    const shape = c.testSuffix ? `<Name>${c.testSuffix}/` : "<Name>/";
    rows.push(["tests", joinDir(c.testsDir, shape), `(${c.testsCount} found)`]);
  }
  const pathWidth = Math.max(...rows.map((r) => r[1].length));
  const lines = [
    `Layout convention (observed, ${c.totalExamples} examples):`,
    ...rows.map(([label, p, count]) => `  ${label.padEnd(10)} ${p.padEnd(pathWidth)} ${count}`),
  ];
  if (c.solutionFile) {
    lines.push(`  ${"solution".padEnd(10)} ${c.solutionFile} — new projects MUST be registered here`);
  }
  lines.push("New code belongs in these directories unless the task explicitly says otherwise.");
  return lines.join("\n");
}
