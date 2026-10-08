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

  // Round 3 — refuter's fresh HIGH/MEDIUM findings against the string
  // detector. This module is now a defense-in-depth EARLY warning, not the
  // sole guarantee (git-effect-guard.ts is the real backstop for anything
  // except push, which cannot be undone once the remote has it) — but these
  // cheap fixes still close every concretely-named bypass and false positive.

  it("BYPASS FIX: `\\git` (backslash-escaped to bypass a shell alias/function) is still recognized as git", () => {
    expect(detectBlockedGitSubcommand("\\git commit -m x", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("\\git push", dir).blocked).toBe(true);
  });

  it("BYPASS FIX: an inline `-c alias.<x>=<v>` defined on the SAME line resolves even though it was never persisted", () => {
    const res = detectBlockedGitSubcommand("git -c alias.x=commit x -m fast-one", dir);
    expect(res.blocked).toBe(true);
    expect(res.subcommand).toBe("commit");
    expect(res.viaAlias).toBe("x");
  });

  it("BYPASS FIX: `${IFS}`/`$IFS` glued into a word is still whitespace", () => {
    expect(detectBlockedGitSubcommand("git${IFS}commit${IFS}-m${IFS}x", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git$IFS push", dir).blocked).toBe(true);
  });

  it("normalises `command git ...` and `env ... git ...` (no shell-builtin special-casing needed — `git` is found regardless of what precedes it)", () => {
    expect(detectBlockedGitSubcommand("command git commit -m x", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("env FOO=bar git commit -m x", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("env -i git push", dir).blocked).toBe(true);
  });

  it("BYPASS FIX: `xargs git` with the subcommand fed from stdin is blocked conservatively", () => {
    expect(detectBlockedGitSubcommand("echo commit | xargs git", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("echo push | xargs git", dir).blocked).toBe(true);
  });

  it("`xargs git <subcommand>` is classified normally when the subcommand is literal text on the line", () => {
    // The subcommand itself ("log") is fixed in the command line — only the
    // per-line ARGUMENT comes from stdin — so this is read-only regardless
    // of what xargs feeds it.
    expect(detectBlockedGitSubcommand("find . -name '*.ts' | xargs git log --oneline --", dir).blocked).toBe(false);
    // But a literal writing subcommand after `xargs git` is still blocked.
    expect(detectBlockedGitSubcommand("echo x | xargs git commit -m", dir).blocked).toBe(true);
  });

  it("FALSE POSITIVE FIX: `git tag` with no args, `-l`, `--list`, `-n`, or `-v` is read-only", () => {
    expect(detectBlockedGitSubcommand("git tag", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git tag -l", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git tag --list", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git tag -n", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git tag -n5", dir).blocked).toBe(false);
    expect(detectBlockedGitSubcommand("git tag -v v1.0.0", dir).blocked).toBe(false);
  });

  it("`git tag` that actually creates/deletes a tag is still blocked", () => {
    expect(detectBlockedGitSubcommand("git tag v1.0.0", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git tag -d v1.0.0", dir).blocked).toBe(true);
    expect(detectBlockedGitSubcommand("git tag -a v1.0.0 -m x", dir).blocked).toBe(true);
  });
});
