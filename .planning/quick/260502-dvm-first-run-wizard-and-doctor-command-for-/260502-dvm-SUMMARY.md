---
phase: quick
plan: 260502-dvm
subsystem: cli-onboarding
tags: [byok, wizard, doctor, ux]
dependency_graph:
  requires: [utils/settings]
  provides: [first-run-wizard, fixed-doctor-key-check]
  affects: [index.ts, ops/doctor.ts]
tech_stack:
  added: []
  patterns: [readline-wizard, stderr-output]
key_files:
  created: []
  modified:
    - src/index.ts
    - src/ops/doctor.ts
decisions:
  - "Wizard outputs to stderr to avoid polluting piped stdout"
  - "Empty input exits with code 1 (explicit fail, not silent)"
  - "Removed dead keytar/keychain code from doctor — CLI uses user-settings.json"
metrics:
  duration: 108s
  completed: "2026-05-02T03:04:00Z"
---

# Quick Task 260502-dvm: First-Run Wizard and Doctor Fix Summary

Readline-based BYOK wizard on first interactive launch + doctor key check fixed to use MUONROI_API_KEY env and user-settings.json instead of dead ANTHROPIC_API_KEY/keytar path.

## Completed Tasks

| # | Task | Commit | Key Changes |
|---|------|--------|-------------|
| 1 | First-run interactive wizard | f3b8771 | `firstRunWizard()` in index.ts, saves key via `saveUserSettings`, only triggers on interactive TTY with no key |
| 2 | Fix doctor key check + version + upsell | 1650168 | `checkKeyPresence` uses MUONROI_API_KEY + loadUserSettings, version header, cloud upsell footer |

## Deviations from Plan

None - plan executed exactly as written.

## Key Implementation Details

### First-Run Wizard (src/index.ts)
- `firstRunWizard()` uses Node readline with stderr output
- Triggers only when: no apiKey in config AND not headless (no --prompt/--verify) AND stdin is TTY
- Saves entered key via `saveUserSettings({ apiKey })` then mutates config object
- Empty input prints guidance message and returns null (caller exits with code 1)
- try/catch around entire function — non-TTY environments fail silently

### Doctor Fixes (src/ops/doctor.ts)
- `checkKeyPresence()` now checks `process.env.MUONROI_API_KEY` first, then `loadUserSettings().apiKey`
- Removed dead `keytar` dynamic import and keychain check
- `formatDoctorReport(results, version?)` shows CLI version header and cloud upsell footer
- Call site in index.ts passes `packageJson.version`

## Known Stubs

None.

## Self-Check: PASSED

- [x] src/index.ts exists
- [x] src/ops/doctor.ts exists
- [x] Commit f3b8771 found
- [x] Commit 1650168 found
