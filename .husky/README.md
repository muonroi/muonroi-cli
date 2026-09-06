# Why `.husky/_/` is tracked

`core.hooksPath` is `.husky/_`. Husky generates that directory and ships a
`.husky/_/.gitignore` containing a single `*`, so by default **the whole hook
runtime is untracked**.

`git worktree add` materialises only *tracked* paths. So in a fresh worktree
`.husky/_/` does not exist, git finds no hook, and **every hook-driven gate
silently does not run** — the commit-msg conventional-commit lint, the
pre-commit secret scan + lint-staged, and the pre-push semantic lint /
self-verify / binary compile smoke. A gate that does not run reports success.

Reproduced before the fix, in a worktree of this repo:

```
$ git worktree add .claude/worktrees/x -b probe/x
$ cd .claude/worktrees/x && git hook run commit-msg -- msg.txt
error: cannot find a hook named commit-msg      # main tree: the hook fires and rejects
```

That matters because `docs/agent-first/SELF-IMPROVEMENT-PLAN.md` §3.1 requires
every self-improvement sprint to run in a fresh worktree — precisely where the
gates were disappearing (§10 row 7).

## How it is fixed

The 15 dispatch stubs plus husky's `h` runtime are **tracked**, so a worktree
checks them out. Two details make this stable:

- **`.husky/_/.gitignore` is deliberately NOT tracked.** `bunx husky` — which
  every `bun install` runs via the `prepare` script — rewrites that file back to
  a bare `*`. Tracking it would produce a spurious diff after every install.
  It does not need to be tracked: **git ignore rules never apply to paths that
  are already in the index**, so the `*` is irrelevant to the stubs once they
  are tracked.
- **Mode must stay `100755`.** Git skips a hook it cannot execute, which on
  POSIX would silently reintroduce the same bug. `core.filemode` is `false` on
  Windows, so `git add` records `100644` there and the bit has to be set
  explicitly.

Verify both at once:

```
git ls-files -s .husky/_        # 15 entries, every one 100755
```

`bunx husky` regenerates the stubs byte-identically for a given husky version,
so the tracked copies stay clean; a husky upgrade shows up as a reviewable diff
instead of a silent behaviour change.

## Adding a new hook

1. Write `.husky/<hook-name>` as usual.
2. Run `bunx husky` (or `bun install`) so the `_/<hook-name>` dispatch stub exists.
3. Force-track the stub — the husky-owned `*` ignore hides it from a plain add:

```
git add -f .husky/_/<hook-name>
git update-index --chmod=+x .husky/_/<hook-name>
```

Skipping step 3 means the hook works on your machine and nowhere else.
