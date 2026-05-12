# Branch Protection — `master`

This repo's `master` branch must enforce the following rules. Apply via the
GitHub UI or run `scripts/setup-branch-protection.sh`.

## Required settings

| Setting | Value |
|---|---|
| Require a pull request before merging | ✅ |
| Required approving reviews | 1 |
| Dismiss stale approvals on new commit | ✅ |
| Require review from Code Owners | ✅ (if `CODEOWNERS` exists) |
| Require status checks to pass | ✅ |
| Require branches to be up to date | ✅ |
| Required checks | `test (ubuntu-latest)`, `test (windows-latest)`, `test (macos-latest)`, `build-smoke (ubuntu-latest)` |
| Require conversation resolution | ✅ |
| Require signed commits | optional (recommended) |
| Require linear history | ✅ (no merge commits — squash or rebase) |
| Include administrators | ✅ (no bypass) |
| Allow force pushes | ❌ |
| Allow deletions | ❌ |

## Why these matter

- **Linear history + Conventional Commits** keeps `git log --oneline` greppable
  and bisectable. Past pain point: `8f78912 "addition advance SEO"` —
  vague header on a 24-file refactor that needed two follow-up patches.
- **Required CI matrix** prevents Windows-only breakages (e.g. the recent
  atomic-IO race that the CI smoke caught).
- **No force-push to master** preserves auditability when secrets are
  accidentally committed — `git filter-repo` is then an explicit, reviewed
  decision rather than a silent rewrite.

## Apply via CLI

```sh
gh auth login
bash scripts/setup-branch-protection.sh
```

The script is idempotent — safe to re-run after CI job names change.
