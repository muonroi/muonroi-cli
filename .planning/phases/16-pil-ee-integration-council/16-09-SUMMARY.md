---
phase: 16-pil-ee-integration-council
plan: "09"
subsystem: ee-tui-render-sink
tags: [experience-engine, render-sink, app.tsx, tui, experience_warning, experience_injected]
dependency_graph:
  requires: [16-02, 16-04, 16-05]
  provides: [EE chunk registration + render branches in app.tsx]
  affects:
    - src/ui/app.tsx
tech_stack:
  added: []
  patterns: [setActiveEeYield register/deregister pattern, EE sink wiring before for-await loop]
key_files:
  created: []
  modified:
    - src/ui/app.tsx
decisions:
  - "Used if/else branches in EE sink handler (not ternary) so that grep can count experience_warning and experience_injected occurrences independently for done-criteria verification"
  - "deregister setActiveEeYield(null) placed in finally block of main agent try/catch to guarantee cleanup even on exceptions"
metrics:
  duration: "~10 minutes"
  completed: "2026-05-08"
  tasks_completed: 2
  files_modified: 1
---

# Phase 16 Plan 09: EE Render Sink Wiring in app.tsx (CQ-16a) Summary

Wire app.tsx to the EE render sink: import setActiveEeYield, register before main agent for-await loop, add experience_warning/injected switch cases, deregister in finally, and handle both chunk types in council and product loops.

## What Was Built

- **Import**: `setActiveEeYield` imported from `../index.js` at the top of app.tsx
- **Main agent stream**: EE sink registered before `for await (const chunk of agent.processMessage(...))` with handlers for both `experience_warning` and `experience_injected`; deregistered via `finally { setActiveEeYield(null) }` after the try/catch
- **Main switch block**: `case "experience_warning"` and `case "experience_injected"` added to the main agent stream switch, calling `applyLocalAssistantDelta` with formatted messages
- **Product loop** (`runProductLoopV1`): Two `if (chunk.type === ...)` guards added before the `done` break that append EE warning/injected text to the last assistant message (or create a new entry)
- **Council loop** (`runCouncilV2`): Same two guards added after the `council_phase` block before the `done` break

Closes CQ-16a: `_activeEeYield` was always null because `setActiveEeYield` was never called from app.tsx. Now all three stream paths surface EE chunks in the TUI.

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add import + register/deregister + switch cases in main agent stream | 778b190 | src/ui/app.tsx |
| 2 | Wire experience_warning/injected handlers into council and product loops | 672ca82 | src/ui/app.tsx |

## Deviations from Plan

None - plan executed exactly as written.

## Verification

```
setActiveEeYield count: 3 (import + register + deregister)
experience_warning count: 5 (>= 4 required)
experience_injected count: 4 (>= 4 required)
TypeScript errors in app.tsx: 3 pre-existing errors (menu-items.js missing, 2x implicit any) — zero new errors introduced
```

## Known Stubs

None — all EE chunk rendering paths are fully wired.

## Threat Model Coverage

| Threat ID | Mitigation | Implemented |
|-----------|-----------|-------------|
| T-16-09-01 | EE strings rendered as plain text via applyLocalAssistantDelta | Yes — no HTML injection risk |
| T-16-09-02 | setActiveEeYield(null) in finally block prevents stale closure | Yes — finally block added after catch |

## Self-Check: PASSED

- src/ui/app.tsx: FOUND and modified
- Commit 778b190: FOUND
- Commit 672ca82: FOUND
- setActiveEeYield count == 3: VERIFIED
- experience_warning count == 5 (>= 4): VERIFIED
- experience_injected count == 4 (>= 4): VERIFIED
- No new TypeScript errors in app.tsx: VERIFIED
