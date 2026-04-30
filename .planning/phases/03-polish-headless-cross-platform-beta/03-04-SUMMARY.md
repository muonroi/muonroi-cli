---
phase: 03-polish-headless-cross-platform-beta
plan: "04"
subsystem: infra
tags: [github-actions, ci, bun, cross-platform, release, binary-compilation, npm-publish]

# Dependency graph
requires:
  - phase: 03-02
    provides: smoke-boot-only headless flag and vitest suite passing on Windows

provides:
  - Cross-platform CI matrix (ubuntu/windows/macos) running typecheck + tests + boot smoke
  - Release pipeline building 4 standalone binaries via bun build --compile on tag push
  - GitHub Releases publish with release notes documenting env-var API key for standalone users
  - npm publish step in release workflow
  - package.json files field for npm publish surface

affects:
  - release management
  - distribution

# Tech tracking
tech-stack:
  added:
    - oven-sh/setup-bun@v2 (cross-platform bun setup action)
    - actions/upload-artifact@v4 (binary artifact upload)
    - actions/download-artifact@v4 (binary artifact download in release job)
    - gh cli (GitHub Releases creation)
  patterns:
    - bun build --compile per-platform matrix for standalone binary distribution
    - fail-fast: false on all CI matrices for independent platform reporting
    - build job + release job separation so all binaries uploaded before release is created

key-files:
  created:
    - .github/workflows/ci-matrix.yml
    - .github/workflows/release-binary.yml
  modified:
    - package.json

key-decisions:
  - "ci-matrix build-smoke job only verifies binary compiles — does NOT run it (cross-compile for arm64 on macos-latest cannot run on x64 runner)"
  - "release workflow separates build jobs from release job via needs: build so all 4 artifacts are collected before gh release create"
  - "Standalone binary users documented to use ANTHROPIC_API_KEY env var (keytar native addon will not work in compiled bun binary)"
  - "package.json files field added to include src/ and dist/ for npm publish surface"

patterns-established:
  - "Pattern 1: Per-platform binary matrix — each platform builds only its native binary target; cross-compilation avoided for reliability"
  - "Pattern 2: Build/release job split — build matrix runs in parallel, release job aggregates via download-artifact merge-multiple: true"

requirements-completed: [CORE-05, CORE-06]

# Metrics
duration: 8min
completed: 2026-04-30
---

# Phase 03 Plan 04: Cross-Platform CI Matrix + Binary Release Pipeline Summary

**GitHub Actions CI matrix on ubuntu/windows/macos with bun build --compile release pipeline publishing 4 standalone binaries to GitHub Releases and npm on v* tag push**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-30T09:00:00Z
- **Completed:** 2026-04-30T09:08:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Created `.github/workflows/ci-matrix.yml` — full cross-platform matrix (ubuntu/windows/macos) with typecheck + vitest + headless boot smoke + native binary compile-smoke per platform
- Created `.github/workflows/release-binary.yml` — tag-triggered pipeline that builds 4 standalone binaries (linux-x64, windows-x64, darwin-x64, darwin-arm64) and uploads to GitHub Releases with env-var API key release notes, plus npm publish
- Updated `package.json` — added `files` field to include `src/` and `dist/` for correct npm publish surface

## Task Commits

1. **Task 1: Create cross-platform CI matrix workflow** - `7425880` (feat)
2. **Task 2: Create release-binary workflow + package.json build script** - `da7917d` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified

- `.github/workflows/ci-matrix.yml` — CI matrix: test job (typecheck+vitest+boot-smoke) x 3 OS + build-smoke job (bun build --compile) x 3 platforms; fail-fast: false on both
- `.github/workflows/release-binary.yml` — Tag-triggered release: 4-platform binary build matrix, GitHub Releases via gh cli, npm publish via NPM_TOKEN secret
- `package.json` — Added `files: ["src/", "dist/"]` for npm publish

## Decisions Made

- `build-smoke` job verifies binary compiles but does NOT run it — cross-compile for arm64 on macos-latest cannot run on x64 runner; runtime smoke covered by the `test` job's `--smoke-boot-only` flag on matching OS
- Release job uses `needs: build` so it waits for all 4 matrix build jobs to finish before creating the GitHub Release; `merge-multiple: true` on download-artifact flattens all artifacts into `dist/`
- Standalone binaries documented to use `ANTHROPIC_API_KEY` env var in release notes — keytar native addon does not work inside compiled bun binary (pre-documented Pitfall 2)
- `package.json` `files` field added (not in plan spec) to correctly scope npm publish to only `src/` and `dist/` — prevents accidental inclusion of test fixtures, `.github/`, `.planning/`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `files` field to package.json**
- **Found during:** Task 2 (package.json updates)
- **Issue:** Plan specified adding `build:binary` script and `bin` field (both already existed). `files` field was not in original package.json — without it, `npm publish` would include all repo files including test fixtures, .github/, .planning/, and development config
- **Fix:** Added `"files": ["src/", "dist/"]` to package.json
- **Files modified:** package.json
- **Verification:** `grep '"files"' package.json` returns match
- **Committed in:** da7917d

---

**Total deviations:** 1 auto-fixed (1 missing critical — npm publish correctness)
**Impact on plan:** Necessary for correct npm publish surface. No scope creep.

## Issues Encountered

- `bunx tsc --noEmit` has pre-existing errors (`tests/stubs/ee-server.ts` outside rootDir) that exist before this plan's changes — out of scope per scope boundary rule. Pre-existing errors are tracked elsewhere.

## User Setup Required

Before the release pipeline can run, the following repository secrets must be configured:

- `NPM_TOKEN` — npm access token for `npm publish --access public`
- `GITHUB_TOKEN` — auto-provided by GitHub Actions (no manual setup required for `gh release create`)

None of these require changes to code — secrets configuration only.

## Next Phase Readiness

- CI matrix covers all 3 platforms for typecheck + test + boot smoke — ready for any future PR validation
- Release pipeline is complete — push a `v*` tag to trigger binary compilation and GitHub Releases publish
- npm publish wired — `npm install -g muonroi-cli` will work once first release tag is pushed and NPM_TOKEN secret configured

---
*Phase: 03-polish-headless-cross-platform-beta*
*Completed: 2026-04-30*

## Self-Check: PASSED

- FOUND: .github/workflows/ci-matrix.yml
- FOUND: .github/workflows/release-binary.yml
- FOUND: build:binary in package.json
- FOUND: bin field in package.json
- FOUND: files field in package.json
- FOUND commit: 7425880 (Task 1)
- FOUND commit: da7917d (Task 2)
