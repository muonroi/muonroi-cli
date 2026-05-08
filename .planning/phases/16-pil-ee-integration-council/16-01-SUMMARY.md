---
phase: 16-pil-ee-integration-council
plan: "01"
subsystem: ee-council-bridge
tags: [council, experience-engine, types, settings, thin-client]
dependency_graph:
  requires: []
  provides: [CouncilExperienceResult, ExperienceWarningData, ExperienceInjectedData, getCouncilExperienceMode, queryExperience]
  affects: [src/types/index.ts, src/utils/settings.ts, src/ee/council-bridge.ts]
tech_stack:
  added: []
  patterns: [AbortSignal.timeout, fail-open thin-client, score-floor filtering]
key_files:
  created:
    - src/ee/council-bridge.ts
  modified:
    - src/types/index.ts
    - src/utils/settings.ts
decisions:
  - "Score floor 0.55 inherited from PIL Layer 3 for consistency; env MUONROI_PIL_SCORE_FLOOR overrides both"
  - "queryExperience uses AbortSignal.any to respect both caller cancellation and 1.5s hard cap"
  - "EEPoint payload text extraction falls back through text -> json.solution -> json.principle -> json.judgment"
metrics:
  duration: "~15 minutes"
  completed: "2026-05-08"
  tasks_completed: 3
  files_modified: 3
---

# Phase 16 Plan 01: Foundation Types and Council-Bridge Summary

Wave 1 foundation establishing EE integration types and queryExperience thin-client for council debates.

## What Was Built

- **StreamChunk extension**: Added `experience_warning` and `experience_injected` to the type union, plus `ExperienceWarningData` and `ExperienceInjectedData` payload interfaces
- **CouncilExperienceMode**: New setting type `"off" | "advisory" | "enforcing"` with `getCouncilExperienceMode()` accessor defaulting to `"advisory"` (CQ-19)
- **council-bridge.ts**: New module exposing `queryExperience(topic, domain, signal?)` — 1.5s hard cap, score floor 0.55, never throws, returns `CouncilExperienceResult` with `warnings[]` or empty on failure

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extend StreamChunk with experience types | af65a5c | src/types/index.ts |
| 2 | Add CouncilExperienceMode to settings | be0181b | src/utils/settings.ts |
| 3 | Create council-bridge.ts | 06f673e | src/ee/council-bridge.ts |

## Deviations from Plan

None - plan executed exactly as written.

## Threat Model Coverage

| Threat ID | Mitigation | Implemented |
|-----------|-----------|-------------|
| T-16-01-01 | AbortSignal.timeout(1500) hard cap | Yes — COUNCIL_EE_TIMEOUT_MS = 1500 |
| T-16-01-02 | Text is read-only hint (accepted) | N/A — accept disposition |
| T-16-01-03 | Local config single-user (accepted) | N/A — accept disposition |

## Self-Check: PASSED

- src/ee/council-bridge.ts: FOUND
- src/types/index.ts contains "experience_warning": FOUND
- src/utils/settings.ts contains "getCouncilExperienceMode": FOUND
- Commits af65a5c, be0181b, 06f673e: FOUND
- bun tsc --noEmit: CLEAN (no errors)
