/**
 * Round 2, HIGH finding: `analyzeGitCommand`'s isCommit/isPush run on a
 * QUOTE-STRIPPED command, so `sh -c "git commit -am x"` — the whole
 * invocation inside the quotes — vanishes before the regex ever sees it, and
 * only `commit`/`push` were recognized at all (merge, cherry-pick, rebase,
 * am, revert, commit-tree, update-ref, tag, pull, and a user's own alias all
 * write history/refs too). `detectBlockedGitSubcommand` is the fix: it scans
 * the RAW command (quotes included) and recognizes every history/ref-writing
 * subcommand, plus one-level alias resolution.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectBlockedGitSubcommand } from "../git-safety.js";

describe("detectBlockedGitSubcommand", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-safety-blocked-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks a direct git commit / push", () => {
    expect(detectBlockedGitSubcommand("git commit -m x", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git push origin main", dir).blocked).toBe(true);
  });

  it("BYPASS FIX: catches `git commit` hidden inside sh -c / bash -c / eval quotes", () => {
    expect(detectBlockedGitSubcommand('sh -c "git commit -am x"', dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand('bash -c "git push origin main"', dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand('eval "git commit -m x"', dir).blocked).toBe(true);
  });

  it("BYPASS FIX: resolves a user git alias to its real (blocked) subcommand", () => {
    execFileSync("git", ["config", "alias.ci", "commit"], { cwd: dir });
    const res = detectBlockedGitSubcommand("git ci -m x", dir);
    expect(res.blocked).toBe(true);
    expect(res.subcommand).toBe("commit");
    expect(res.viaAlias).toBe("ci");
  });

  it("an alias that resolves to a non-blocked subcommand is not blocked", () => {
    execFileSync("git", ["config", "alias.st", "status"], { cwd: dir });
    expect(detectBlockedGitSubcommand("git st", dir).blocked).toBe(false);
  });

  it.each([
    ["git merge feature", "merge"],
    ["git cherry-pick abc123", "cherry-pick"],
    ["git rebase --continue", "rebase"],
    ["git am patch.diff", "am"],
    ["git revert HEAD", "revert"],
    ["git commit-tree abc123", "commit-tree"],
    ["git update-ref refs/heads/main abc123", "update-ref"],
    ["git tag v1.0.0", "tag"],
    ["git pull origin main", "pull"],
  ])("BYPASS FIX: blocks %s (history/ref-writing subcommand)", (cmd, subcommand) => {
    const res = detectBlockedGitSubcommand(cmd, dir);
    expect(res.blocked).toBe(true);
    expect(res.subcommand).toBe(subcommand);
  });

  it("BYPASS FIX: blocks `stash push`/`stash store` (writes refs/stash) but not apply/pop/list/show/drop", () => {
    expect(detectBlockedGitSubcommand("git stash push", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git stash store abc123", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git stash apply", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git stash pop", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git stash list", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git stash show", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git stash drop", dir).blocked).toBe(false);
  });

  it("BYPASS FIX: blocks a writing `git notes` subword but not read ones", () => {
    expect(detectBlockedGitSubcommand("git notes add -m x", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git notes show", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git notes list", dir).blocked).toBe(false);
  });

  it("MEDIUM FIX: `git log --grep push` is not a push (subcommand slot is `log`, not `push`)", () => {
    expect(detectBlockedGitSubcommand("git log --grep push", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git log --grep=push", dir).blocked).toBe(false);
  });

  it("keeps read-only git commands working", () => {
    for (const cmd of [
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "git show HEAD",
      "git blame src/index.ts",
      "git grep TODO",
      "git rev-parse HEAD",
      "git for-each-ref",
    ]) {
      expect(detectBlockedGitSubcommand(cmd, dir).blocked).toBe(false);
    }
  });

  it("handles global flags before the subcommand (-C dir, -c k=v, --no-pager)", () => {
    expect(detectBlockedGitSubcommand(`git -C ${dir} commit -m x`, dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git -c core.pager=cat commit -m x", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git --no-pager log", dir).blocked).toBe(false);
  });

  it("finds a blocked subcommand chained after a read-only one", () => {
    expect(detectBlockedGitSubcommand("git status && git commit -m x", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git log; git push", dir).blocked).toBe(true);
  });
});
