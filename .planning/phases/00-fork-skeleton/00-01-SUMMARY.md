---
phase: 00-fork-skeleton
plan: 01
subsystem: infra
tags: [fork, grok-cli, bun, typescript, license, mit, upstream-tracking]

# Dependency graph
requires: []
provides:
  - "Full grok-cli source tree at upstream HEAD 09b64bc imported to muonroi-cli"
  - "LICENSE (MIT, muonroi 2026) at repo root"
  - "LICENSE-grok-cli (MIT, Vibe Kit) preserved verbatim at repo root"
  - "UPSTREAM_DEPS.md with fork commit hash, pinned dependency release feeds, and removed-deps table"
  - "package.json renamed to muonroi-cli with bin.muonroi-cli, version 0.0.1, author muonroi"
  - "engines.bun >= 1.3.13 constraint set (D-003)"
  - "DECISIONS.md companion-files cross-reference appended"
affects:
  - "00-02-strip-dead-surface"
  - "00-03-storage-rename"
  - "00-04-deps-swap"
  - "all subsequent Phase 0 plans (nothing to modify before this plan)"

# Tech tracking
tech-stack:
  added:
    - "grok-cli source tree (TypeScript, Bun runtime)"
    - "OpenTUI (@opentui/core@^0.1.88, @opentui/react@^0.1.88)"
    - "AI SDK (ai@^6.0.116)"
    - "vitest, biome, husky, lint-staged"
  patterns:
    - "Conventional commits: feat(fork)/docs(fork) for import + license laydown"
    - "Dual LICENSE pattern: LICENSE-grok-cli (upstream immutable) + LICENSE (our own)"
    - "UPSTREAM_DEPS.md as single source of truth for dependency provenance and CVE feeds"

key-files:
  created:
    - "LICENSE"
    - "LICENSE-grok-cli"
    - "UPSTREAM_DEPS.md"
    - "package.json"
    - "src/ (148 files from grok-cli)"
    - "tsconfig.json"
    - "biome.json"
    - "vitest.config.ts"
    - "bun.lock"
    - "install.sh"
    - "README.md"
    - "AGENTS.md"
    - "CHANGELOG.md"
  modified:
    - "DECISIONS.md (companion-files cross-reference appended)"

key-decisions:
  - "Used git clone --depth 1 from https://github.com/muonroi/grok-cli.git because local D:/sources/Core/grok-cli/ did not exist on this machine — upstream hash confirmed identical (09b64bc)"
  - "engines.bun >= 1.3.13 added to package.json per D-003 even though plan did not explicitly list it in Task 1 action — forward-compatible with UPSTREAM_DEPS.md pin"
  - "LICENSE-grok-cli is byte-identical to upstream grok-cli/LICENSE (diff -q verified)"

patterns-established:
  - "Fork import pattern: copy verbatim, rename metadata, preserve upstream LICENSE separately"
  - "UPSTREAM_DEPS.md pattern: every dependency must appear with source + release feed + notes"

requirements-completed:
  - FORK-01
  - FORK-05
  - FORK-06

# Metrics
duration: 7min
completed: 2026-04-29
---

# Phase 00 Plan 01: Fork Import Summary

**grok-cli main HEAD (09b64bc) imported as muonroi-cli fork base with dual MIT licenses, pinned dependency feed table (UPSTREAM_DEPS.md), and package.json renamed to muonroi-cli**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-29T13:24:57Z
- **Completed:** 2026-04-29T13:32:00Z
- **Tasks:** 2
- **Files modified:** 151 (148 created, 3 modified)

## Accomplishments

- Imported full grok-cli source tree (src/, tsconfig.json, biome.json, vitest.config.ts, bun.lock, install.sh, README.md, AGENTS.md, CHANGELOG.md) at upstream commit `09b64bc518f110424cb58bdbb3cf2ce2b388dbe5`
- Created dual LICENSE structure: `LICENSE` (MIT, muonroi 2026) + `LICENSE-grok-cli` (MIT, Vibe Kit, byte-identical to upstream) per D-001 / Pitfall 15
- Created `UPSTREAM_DEPS.md` tracking fork commit hash, 18 runtime dependency release feeds, 6 packages scheduled for removal in plan 00-04, and Phase 4 holdbacks
- Renamed package.json from `grok-dev` to `muonroi-cli`, set version `0.0.1`, updated bin key, updated build:binary outfile, set author `muonroi`, added `engines.bun >= 1.3.13` (D-003)
- Appended companion-files cross-reference to DECISIONS.md without modifying any of the 6 locked D-001..D-006 entries

## Task Commits

Each task was committed atomically:

1. **Task 1: Import grok-cli main HEAD as muonroi-cli fork base** - `fd8e594` (feat)
2. **Task 2: Create LICENSE + UPSTREAM_DEPS.md + DECISIONS cross-refs** - `ec80b8f` (docs)

## Files Created/Modified

- `src/` (148 files) - Full grok-cli source tree: agent, hooks, grok, ui, lsp, mcp, headless, daemon, storage, telegram, audio, wallet, payments, tools, types, utils, verify
- `LICENSE` - muonroi-cli MIT license (Copyright 2026 muonroi)
- `LICENSE-grok-cli` - Upstream Vibe Kit MIT license, byte-identical to grok-cli/LICENSE, immutable
- `UPSTREAM_DEPS.md` - Fork commit hash + dependency provenance + release feed table
- `package.json` - Renamed to muonroi-cli, version 0.0.1, bin.muonroi-cli, author muonroi, engines.bun >= 1.3.13
- `tsconfig.json`, `biome.json`, `vitest.config.ts` - Build config inherited from grok-cli
- `bun.lock`, `install.sh`, `README.md`, `AGENTS.md`, `CHANGELOG.md` - Inherited from grok-cli
- `DECISIONS.md` - Companion-files cross-reference appended (locked entries untouched)

## Decisions Made

- **Clone source:** Local `D:/sources/Core/grok-cli/` did not exist on this machine. Used `git clone --depth 1 https://github.com/muonroi/grok-cli.git` into a temp directory. Upstream HEAD hash confirmed `09b64bc518f110424cb58bdbb3cf2ce2b388dbe5` — identical to plan spec. No change to any plan constraint.
- **engines.bun added to package.json:** Plan D-003 locks `>=1.3.13` and UPSTREAM_DEPS.md documents the Bun pin. Adding it to `package.json` engines field is consistent with D-003 and was the right time to establish it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Sourced grok-cli via git clone because local path missing**
- **Found during:** Task 1 (import step)
- **Issue:** Plan specified `D:/sources/Core/grok-cli/` as source; that path does not exist on this machine
- **Fix:** Cloned `https://github.com/muonroi/grok-cli.git --depth 1` to `/d/tmp/grok-cli-import/`. HEAD hash confirmed identical. All subsequent cp commands used the temp clone path.
- **Files modified:** None — source path change only, no output file differences
- **Verification:** `git rev-parse HEAD` on clone returned `09b64bc518f110424cb58bdbb3cf2ce2b388dbe5` (exact match). `diff -q LICENSE-grok-cli /d/tmp/grok-cli-import/LICENSE` returned 0.
- **Committed in:** fd8e594

---

**Total deviations:** 1 auto-fixed (1 blocking — missing source path resolved by cloning upstream)
**Impact on plan:** Zero impact on output. All artifacts are byte-identical to what a local copy would have produced.

## Issues Encountered

None beyond the source path resolution above.

## Known Stubs

None. This plan is a pure import — no feature logic, no data rendering, no UI wiring.

## Next Phase Readiness

Plan 00-02 (strip dead surface) can run immediately:
- `src/telegram/`, `src/audio/`, `src/wallet/`, `src/payments/` are present and ready to delete
- `package.json` is renamed and ready for dependency pruning in 00-04
- `LICENSE-grok-cli` and `LICENSE` are in place — 00-02 will not touch either
- DECISIONS.md D-001..D-006 all locked and intact

No blockers for 00-02.

---
*Phase: 00-fork-skeleton*
*Completed: 2026-04-29*
