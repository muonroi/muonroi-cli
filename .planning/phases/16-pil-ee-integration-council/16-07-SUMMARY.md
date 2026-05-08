---
phase: 16-pil-ee-integration-council
plan: "07"
subsystem: ops/doctor
tags: [ee, health, doctor, brain-emptiness, diagnostics]
dependency_graph:
  requires:
    - "16-04"
    - "16-06"
  provides:
    - ee-health-detailed-reporting
    - brain-emptiness-diagnostic
  affects:
    - src/ops/doctor.ts
tech_stack:
  added: []
  patterns:
    - fail-open try-catch for optional diagnostics
    - SQL COUNT query with date filter for brain emptiness
    - sub-system health reporting (mode/circuit/server/gates)
key_files:
  created: []
  modified:
    - src/ops/doctor.ts
decisions:
  - "checkEE() replaced by checkEEDetailed() using healthDetailed() from ee/health.ts — provides mode/circuit/server/gates sub-status"
  - "BRAIN_EMPTY_THRESHOLD set to 50 consecutive no_match events (30-day window)"
  - "Both new checks are fail-open (try-catch returning pass/warn) to never block doctor output"
  - "Brain emptiness hint references both 'experience extract'/'experience evolve' AND MUONROI_PIL_SCORE_FLOOR for actionability"
metrics:
  duration: "~8 min"
  completed: "2026-05-08"
  tasks: 1
  files: 1
requirements:
  - CQ-16c
  - CQ-16d
---

# Phase 16 Plan 07: Doctor EE Detailed Health + Brain Emptiness Diagnostic Summary

## One-liner

`checkEEDetailed()` replaces `checkEE()` in doctor with mode/circuit/server/gates sub-status via `healthDetailed()`; `checkBrainEmptiness()` added for no_match injection event diagnostic with bootstrap hint.

## What Was Built

Upgraded `muonroi doctor` command to surface richer EE diagnostics:

1. **`checkEEDetailed()`** — replaces the old `checkEE()`:
   - Calls `healthDetailed()` (from `src/ee/health.ts`) instead of the basic `health()`
   - Reports `ee.health` check result with `mode=`, `circuit=`, `server=`, `gates=` sub-fields
   - On failure in thin-client mode: actionable hint pointing to VPS `experience.muonroi.com` and `~/.experience/config.json`
   - Wrapped in try-catch — fails as `warn`, never throws

2. **`checkBrainEmptiness()`** — new check (CQ-16d):
   - Queries `interaction_logs` SQLite table for `event_type='ee_injection' AND event_subtype='no_match'` in last 30 days
   - `BRAIN_EMPTY_THRESHOLD = 50`: if count >= 50, returns `ee.brain=warn` with hint to run `experience extract` + `experience evolve`
   - Hint also mentions lowering `MUONROI_PIL_SCORE_FLOOR` for filtered-but-existing matches
   - Fail-open: if DB unavailable, returns `pass` with "brain check skipped" message

3. **`runDoctor()` updated** — both `checkEEDetailed()` and `checkBrainEmptiness()` added to Promise.all

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Surface Scan

No new network endpoints or auth paths introduced. Doctor reads local SQLite DB (read-only COUNT query) — consistent with threat model T-16-07-03 (accepted via indexed simple query). VPS health probe already covered by T-16-07-01 (HEALTH_TIMEOUT_MS=3000 in health.ts + try-catch in doctor).

## Self-Check

**Files created/modified:**
- `src/ops/doctor.ts` — FOUND (modified, 91 lines inserted)

**Commits:**
- `f220791` feat(16-07): replace checkEE with checkEEDetailed + add checkBrainEmptiness in doctor.ts — FOUND

## Self-Check: PASSED
