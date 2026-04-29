---
phase: 00-fork-skeleton
plan: "08"
subsystem: ci,infra
tags: [ci, github-actions, windows-smoke, deps-check, gitignore, decisions, FORK-08, FORK-05, pitfall-16, pitfall-1]

# Dependency graph
requires:
  - phase: 00-fork-skeleton-plan-07
    provides: "--smoke-boot-only flag, loadConfig+loadUsage boot order, src/index.ts wired"
provides:
  - ".github/workflows/windows-smoke.yml: windows-latest CI smoke (bun install + tsc + vitest + boot smoke) per FORK-08"
  - ".github/workflows/deps-check.yml: weekly bun outdated cron (Mon 08:00 UTC) + artifact upload per FORK-05"
  - ".gitignore: covers node_modules/, dist/, *.tmp, .muonroi-cli/, CI artifacts"
  - "DECISIONS.md D-007: vitest@4.1.5 test runner pin (mandatory B-1 gate)"
  - "DECISIONS.md D-008: ollama-ai-provider-v2 version typo logged (1.50.1 -> 1.5.5)"
  - "DECISIONS.md D-009: Phase 0 ships at locked stack marker entry"
  - "Phase 0 complete: all 17 REQs shipped across plans 00.01-00.08"
affects:
  - phase-1-brain-router
  - phase-1-usage-guard

# Tech tracking
tech-stack:
  added:
    - "GitHub Actions windows-latest runner for CI smoke"
    - "GitHub Actions ubuntu-latest runner for weekly dep scan"
  patterns:
    - "--smoke-boot-only: exits 0 after loadConfig+loadUsage without keychain access (CI-safe)"
    - "frozen-lockfile install in CI prevents dep drift (T-00.08-01 mitigated)"
    - "permissions: contents read (minimum required, T-00.08-04 mitigated)"
    - "timeout-minutes capped (15 for smoke, 10 for deps-check) per T-00.08-03"

key-files:
  created:
    - ".github/workflows/windows-smoke.yml"
    - ".github/workflows/deps-check.yml"
    - ".gitignore"
  modified:
    - "src/index.ts"
    - "DECISIONS.md"

key-decisions:
  - "--smoke-boot-only handler exits BEFORE loadAnthropicKey() — CI runners have no keychain configured; plan 00-07's handler called loadAnthropicKey with catch which is subtly wrong for 'no keychain' environments"
  - "DECISIONS.md D-007 mandatory (B-1: vitest@4.1.5 test runner pin confirmed)"
  - "DECISIONS.md D-008 logs ollama-ai-provider-v2 version typo from plan 00-04 (1.50.1 does not exist on npm; used 1.5.5)"
  - "DECISIONS.md D-009 Phase 0 clean-baseline marker: no EE auth-token blocker, no OpenTUI deviation, keytar native build OK"

patterns-established:
  - "Boot smoke pattern: --smoke-boot-only arg short-circuits before any keychain/network access"
  - "CI gate pattern: windows-latest runner validates the primary dev platform (FORK-08)"
  - "Dep tracking pattern: weekly cron uploads bun outdated artifact (FORK-05 / Pitfall 1)"

requirements-completed:
  - FORK-08
  - FORK-05
  - FORK-06

# Metrics
duration: 15min
completed: 2026-04-29
---

# Phase 00 Plan 08: CI Smoke + Deps-Check + DECISIONS Log Summary

**Windows CI smoke (windows-latest: bun install + tsc + vitest + --smoke-boot-only) + weekly deps-check cron + DECISIONS.md D-007/D-008/D-009 appended — Phase 0 ship gate enforced (FORK-08)**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-29T15:05:00Z
- **Completed:** 2026-04-29T15:23:32Z
- **Tasks:** 2 of 2
- **Files modified:** 5

## Accomplishments

- Fixed `--smoke-boot-only` handler in `src/index.ts` — now exits BEFORE `loadAnthropicKey()` as required by FORK-08 spec (plan 00-07's handler called `loadAnthropicKey` with a catch, which was subtly wrong for CI environments with no keychain)
- Created `.gitignore` covering all required patterns (node_modules/, dist/, *.tmp, .muonroi-cli/, deps-outdated.txt, *.log, editor artifacts)
- Created `.github/workflows/windows-smoke.yml` — bun install --frozen-lockfile + tsc + vitest + --smoke-boot-only boot smoke on windows-latest, triggered on every push/PR to master (FORK-08 Phase 1 gate)
- Created `.github/workflows/deps-check.yml` — weekly Monday 08:00 UTC cron + `bun outdated` artifact upload (FORK-05 / Pitfall 1 watch cadence)
- Appended DECISIONS.md D-007 (vitest@4.1.5 mandatory pin), D-008 (ollama-ai-provider-v2 typo 1.50.1→1.5.5), D-009 (Phase 0 clean baseline marker)
- Live smoke verified: `bun run src/index.ts --smoke-boot-only` exits 0 in <2s on Windows 11 dev box
- 197 tests pass; `bunx tsc --noEmit` clean

## Task Commits

1. **Task 1: --smoke-boot-only affordance + .gitignore** - `856f383` (feat)
2. **Task 2: windows-smoke.yml + deps-check.yml + DECISIONS.md** - `f367b1c` (ci)

## Files Created/Modified

- `src/index.ts` — `--smoke-boot-only` handler: exits 0 after loadConfig+loadUsage, BEFORE loadAnthropicKey; option description updated to reflect no-keychain behavior
- `.gitignore` — Standard Bun+TS+dev ignores: node_modules/, .bun/, dist/, *.tsbuildinfo, *.tmp, *.tmp.json, .vscode/, .idea/, .DS_Store, Thumbs.db, deps-outdated.txt, *.log, .muonroi-cli/
- `.github/workflows/windows-smoke.yml` — CI smoke: checkout, setup-bun >=1.3.13, bun install --frozen-lockfile, tsc --noEmit, vitest run, boot smoke via --smoke-boot-only (pwsh)
- `.github/workflows/deps-check.yml` — Weekly cron (Mon 08:00 UTC) + workflow_dispatch; bun outdated; upload-artifact deps-outdated.txt, retention 30 days
- `DECISIONS.md` — Appended D-007, D-008, D-009 entries (append-only; D-001..D-006 untouched)

## Decisions Made

- **Smoke flag fix**: Plan 00-07's `--smoke-boot-only` handler called `loadAnthropicKey()` with a `.catch()` — this is subtly wrong because CI environments without keytar native module could hang or throw before the catch fires. Fixed to strictly exit after `loadConfig()+loadUsage()` only, matching the FORK-08 spec exactly.
- **D-007 mandatory**: vitest@4.1.5 pin confirmed as B-1 requirement (cannot migrate to `bun test` in Phase 0 — all inherited tests are vitest-based).
- **D-008**: ollama-ai-provider-v2 version typo (1.50.1 does not exist) logged. Impact is low — compatible API surface, no Phase 0 functionality affected.
- **D-009 clean baseline marker**: No OpenTUI version deviation (0.1.107 published correctly), no keytar fallback needed (native build OK on Windows 11), no EE auth-token bootstrap blocker (Phase 1 EE-07 scope).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] --smoke-boot-only handler called loadAnthropicKey before exit**
- **Found during:** Task 1 (reviewing plan 00-07's existing implementation vs FORK-08 spec)
- **Issue:** The handler from plan 00-07 called `await loadAnthropicKey().catch(...)` — this can attempt keytar native module access on CI runners which have no keychain configured. The FORK-08 spec requires exit BEFORE keychain access.
- **Fix:** Removed the `loadAnthropicKey()` call from the smoke handler entirely. Handler now exits after `loadConfig() + loadUsage()` only.
- **Files modified:** `src/index.ts`
- **Verification:** `bun run src/index.ts --smoke-boot-only` exits 0 in <2s; verification script confirms smoke handler line < loadAnthropicKey call lines
- **Committed in:** `856f383` (Task 1 feat commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — correctness fix for CI safety)
**Impact on plan:** Fix is necessary for FORK-08 compliance. The smoke handler must not access the keychain in CI environments.

## Issues Encountered

- Sandbox test (`sandbox.test.ts`) showed an intermittent 5s timeout when running the full suite due to resource contention from parallel test execution. Running the test file in isolation passes 4/4. This is a pre-existing flaky test from grok-cli upstream — not caused by plan 00-08 changes. Full suite passed on second run (197/197).

## Phase 0 REQ Traceability — Final Check (17/17)

| REQ | Description | Plan | Status |
|-----|-------------|------|--------|
| FORK-01 | grok-cli forked, LICENSE-grok-cli preserved | 00-01 | DONE |
| FORK-02 | xAI/Telegram/Coinbase surface amputated | 00-02 | DONE |
| FORK-03 | Storage paths renamed ~/.muonroi-cli/ | 00-02 | DONE |
| FORK-04 | Brand rename (grok→muonroi-cli) | 00-03 | DONE |
| FORK-05 | bun outdated weekly dep tracking | 00-08 | DONE |
| FORK-06 | DECISIONS.md + UPSTREAM_DEPS.md companion files | 00-01, 00-08 | DONE |
| FORK-07 | src/orchestrator layout + new subdirs | 00-04 | DONE |
| FORK-08 | Windows CI smoke gate | 00-08 | DONE |
| TUI-01 | OpenTUI renders in interactive mode | 00-07 | DONE |
| TUI-02 | Log redactor patches console.* | 00-05 | DONE |
| TUI-03 | SIGINT exits cleanly | 00-07 | DONE |
| TUI-04 | AbortContext + PendingCallsLog | 00-07 | DONE |
| USAGE-01 | loadConfig() + loadUsage() at boot | 00-06 | DONE |
| USAGE-06 | Monthly usage state schema + atomic IO | 00-06 | DONE |
| EE-01 | EE HTTP client replaces grok-cli shell-spawn hooks | 00-06 | DONE |
| PROV-03 | loadAnthropicKey() with OS keychain + env fallback | 00-05 | DONE |
| PROV-07 | redactor.installGlobalPatches() as first executable line | 00-05 | DONE |

**Phase 0 sign-off: 17/17 REQs shipped. All plans 00.01–00.08 complete. Phase 0 is shippable.**

## Open Follow-ups for Phase 1

- **Full CI matrix**: Win10/Win11/macOS/Linux runners (CORE-05) — Phase 3 polish per original plan
- **node-pty automated TUI render test**: Full "renders within 3s" assertion deferred to Phase 1 (needs node-pty harness per 00-CONTEXT.md)
- **gh-issue creation in deps-check**: Auto-open issue on outdated deps — Phase 1+ polish (requires Actions `issues: write` permission + gh CLI step)
- **SC2/SC3/SC4 end-to-end smoke**: Anthropic stream, session resume, Ctrl+C mid-tool — deferred from plan 00-07; Phase 1 integration test environment with API key
- **TUI-05**: Status bar realtime cap meter + tier badge (config/usage structs plumbed, not yet surfaced in UI)

## Next Phase Readiness

- Phase 0 COMPLETE — all 17 REQs (FORK-01..08, TUI-01..04, USAGE-01, USAGE-06, EE-01, PROV-03, PROV-07) shipped
- `windows-smoke.yml` is live on master — Phase 1 is blocked until it turns green (per FORK-08 + D-003)
- Manual validation required: push to GitHub master, observe windows-smoke CI job green
- Phase 1 begins from clean baseline: Bun >=1.3.13, vitest@4.1.5, @opentui/core@0.1.107, ai@6.0.169, keytar native OK, EE HTTP client ready

---
*Phase: 00-fork-skeleton*
*Completed: 2026-04-29*

## Self-Check: PASSED

- FOUND: .github/workflows/windows-smoke.yml
- FOUND: .github/workflows/deps-check.yml
- FOUND: .gitignore
- FOUND: src/index.ts (smoke-boot-only handler updated)
- FOUND: DECISIONS.md (D-007, D-008, D-009 appended)
- FOUND commit: 856f383 (feat(boot): --smoke-boot-only + .gitignore)
- FOUND commit: f367b1c (ci(fork): windows smoke + deps-check + DECISIONS)
- 197 tests pass, tsc --noEmit clean
- Live smoke: bun run src/index.ts --smoke-boot-only exits 0
