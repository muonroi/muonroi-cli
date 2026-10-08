/**
 * F7 — run state written to the wrong directory.
 *
 * Measured 2026-09-09 in `D:\sources\CompanyLibs\tcis-libraries`: the repo held
 * BOTH `.muonroi-flow/` (correct) and `src/.muonroi-flow/planning/` (stray).
 * `sessions.cwd_at_start` for that run is the repo root and `sessions.cwd_last`
 * is `…\tcis-libraries\src` — the bash tool's `cd` handler moved the tool cwd
 * into `src` (tool_calls 2026-09-09T15:21:56Z, `cd …/src && dotnet run …`) and
 * every flow-state resolver downstream reads that drifted value.
 *
 * These tests pin the anchor itself AND the two shipped call sites, because a
 * helper that passes while the real resolver still reads ambient cwd is exactly
 * the shape this repo has been bitten by before.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planningRoot } from "../../gsd/paths.js";
import { setCommitRunRoot } from "../../orchestrator/auto-commit.js";
import { runAnchoredStateRoot } from "../run-root.js";
import { ensureFlowDir } from "../scaffold.js";

const made: string[] = [];

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

/** A run root that looks like a real checkout the run was launched in. */
function repoRoot(): string {
  const d = tmp("f7-repo-");
  mkdirSync(join(d, ".git"));
  mkdirSync(join(d, ".muonroi-flow"), { recursive: true });
  mkdirSync(join(d, "src"), { recursive: true });
  return d;
}

afterEach(() => {
  setCommitRunRoot(null);
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("runAnchoredStateRoot", () => {
  it("re-anchors a cwd that drifted into a subdirectory of the run root", () => {
    const root = repoRoot();
    setCommitRunRoot(root);
    expect(realpathSync(runAnchoredStateRoot(join(root, "src")))).toBe(root);
  });

  it("leaves the run root itself untouched", () => {
    const root = repoRoot();
    setCommitRunRoot(root);
    expect(realpathSync(runAnchoredStateRoot(root))).toBe(root);
  });

  it("leaves a cwd OUTSIDE the run root untouched", () => {
    const root = repoRoot();
    const elsewhere = tmp("f7-other-");
    setCommitRunRoot(root);
    expect(realpathSync(runAnchoredStateRoot(elsewhere))).toBe(elsewhere);
  });

  it("never moves a nested directory that already owns a state tree", () => {
    const root = repoRoot();
    const pkg = join(root, "packages", "a");
    mkdirSync(join(pkg, ".planning"), { recursive: true });
    setCommitRunRoot(root);
    expect(realpathSync(runAnchoredStateRoot(pkg))).toBe(realpathSync(pkg));
  });

  it("does not anchor when the run root is not itself a checkout root (ecosystem-root launch)", () => {
    // `D:\sources\Core` is a real launch directory here and is NOT a git repo;
    // anchoring there would give every sibling repo one shared planning tree.
    const eco = tmp("f7-eco-");
    const repo = join(eco, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(eco, ".muonroi-flow"), { recursive: true });
    setCommitRunRoot(eco);
    expect(realpathSync(runAnchoredStateRoot(repo))).toBe(realpathSync(repo));
  });

  it("does not anchor across a nested worktree boundary", () => {
    const root = repoRoot();
    const wt = join(root, ".wt-sprint");
    mkdirSync(join(wt, ".git"), { recursive: true });
    setCommitRunRoot(root);
    expect(realpathSync(runAnchoredStateRoot(wt))).toBe(realpathSync(wt));
  });
});

describe("F7 call sites — the resolvers a drifted cwd actually reaches", () => {
  it("planningRoot resolves the GSD tree against the run root, not the drifted cwd", () => {
    const root = repoRoot();
    setCommitRunRoot(root);
    // This is the exact shape of the stray: `<repo>/src/.muonroi-flow/planning`.
    expect(planningRoot(join(root, "src"))).toBe(join(root, ".muonroi-flow", "planning"));
  });

  it("ensureFlowDir creates the run's flow dir at the run root and no rival under src/", () => {
    const root = repoRoot();
    setCommitRunRoot(root);
    return ensureFlowDir(join(root, "src")).then((dir) => {
      expect(dir).toBe(join(root, ".muonroi-flow"));
      expect(existsSync(join(root, "src", ".muonroi-flow"))).toBe(false);
    });
  });
});
