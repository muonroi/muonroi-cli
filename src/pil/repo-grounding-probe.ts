/**
 * src/pil/repo-grounding-probe.ts
 *
 * Deterministic repo-grounding probe (Design B). Given a prompt + the
 * checked-in REPO_DEEP_MAP index, measure how much repository surface the
 * prompt's targets actually cover — file count, total LOC, directory spread,
 * symbol collisions — so routing sizes on facts, not on the sentence length.
 *
 * PURE + deterministic: NO LLM call, NO network. Filesystem access is bounded
 * to at most one existsSync + line-count read per distinct target that is an
 * exact path absent from the index. Buckets come from a monotonic threshold
 * FORMULA over measured counts — never a fixed depth→route table.
 *
 * See docs/superpowers/plans/2026-07-16-pil-repo-grounding-probe.md and the
 * council synthesis (Design B) for the accepted invariants.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPathTokens } from "./layer1_5-complexity-size.js";
import type { RepoStructureHint } from "./repo-structure-hints.js";

export type GroundingBucket = "none" | "small" | "medium" | "large";

export interface RepoGroundingProbeResult {
  ran: boolean;
  targets: string[];
  matchedFiles: number;
  totalLoc: number;
  matchedDirs: number;
  collision: boolean;
  bucket: GroundingBucket;
  groundingUncertainty: boolean;
}

/** Distinct top-two path segments, e.g. "src/auth/login.ts" → "src/auth". */
function topDir(path: string): string {
  const segs = path.split("/");
  return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : (segs[0] ?? path);
}

/** A target is a "bare basename" when it has no slash (a symbol/file name, not a path). */
function isBareName(target: string): boolean {
  return !target.includes("/");
}

/**
 * Measured LOC/file bucket. Monotonic in every input: more files, more LOC, or
 * wider directory spread never lowers the bucket. Thresholds are counts (not a
 * depth map) and are covered by fixture tests — the only knob the council
 * permits for sizing.
 */
function bucketOf(matchedFiles: number, totalLoc: number, matchedDirs: number): GroundingBucket {
  if (matchedFiles === 0) return "none";
  if (matchedFiles >= 8 || totalLoc >= 4000 || matchedDirs >= 4) return "large";
  if (matchedFiles <= 2 && totalLoc < 500 && matchedDirs <= 1) return "small";
  return "medium";
}

export function probeRepoGrounding(
  prompt: string,
  hints: RepoStructureHint[],
  opts?: { cwd?: string },
): RepoGroundingProbeResult {
  const targets = extractPathTokens(prompt);
  if (targets.length === 0) {
    return {
      ran: false,
      targets: [],
      matchedFiles: 0,
      totalLoc: 0,
      matchedDirs: 0,
      collision: false,
      bucket: "none",
      groundingUncertainty: false,
    };
  }

  const index = new Map(hints.map((h) => [h.path.toLowerCase(), h]));
  // basename → the distinct indexed paths carrying it (for collision detection).
  const byBasename = new Map<string, Set<string>>();
  for (const h of hints) {
    const base = h.path.toLowerCase().split("/").pop() ?? h.path.toLowerCase();
    const set = byBasename.get(base) ?? new Set<string>();
    set.add(h.path.toLowerCase());
    byBasename.set(base, set);
  }

  const matchedPaths = new Set<string>();
  let totalLoc = 0;
  let collision = false;

  for (const target of targets) {
    // 1. Exact indexed path.
    const exact = index.get(target);
    if (exact) {
      if (!matchedPaths.has(exact.path.toLowerCase())) {
        matchedPaths.add(exact.path.toLowerCase());
        totalLoc += exact.lineCount;
      }
      continue;
    }
    // 2. Bare basename/symbol resolving across >1 indexed path → collision.
    if (isBareName(target)) {
      const carriers = byBasename.get(target);
      if (carriers && carriers.size > 1) {
        collision = true;
        for (const p of carriers) {
          if (!matchedPaths.has(p)) {
            matchedPaths.add(p);
            totalLoc += index.get(p)?.lineCount ?? 0;
          }
        }
        continue;
      }
      if (carriers && carriers.size === 1) {
        const only = [...carriers][0];
        if (only && !matchedPaths.has(only)) {
          matchedPaths.add(only);
          totalLoc += index.get(only)?.lineCount ?? 0;
        }
        continue;
      }
    }
    // 3. Exact path not in the index but present on disk → confirm + count (bounded).
    const cwd = opts?.cwd;
    if (cwd && target.includes("/")) {
      const abs = join(cwd, target);
      try {
        if (existsSync(abs)) {
          const loc = readFileSync(abs, "utf8").split(/\r?\n/).length;
          if (!matchedPaths.has(target)) {
            matchedPaths.add(target);
            totalLoc += loc;
          }
        }
      } catch (err) {
        console.error(`[repo-grounding-probe] on-disk LOC read failed for ${target}: ${(err as Error)?.message}`);
      }
    }
    // else: unmatched target — contributes to a zero-match uncertainty signal.
  }

  const matchedFiles = matchedPaths.size;
  const matchedDirs = new Set([...matchedPaths].map(topDir)).size;
  const bucket = bucketOf(matchedFiles, totalLoc, matchedDirs);
  const groundingUncertainty = matchedFiles === 0 || collision;

  return {
    ran: true,
    targets,
    matchedFiles,
    totalLoc,
    matchedDirs,
    collision,
    bucket,
    groundingUncertainty,
  };
}
