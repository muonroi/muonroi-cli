---
phase: 16-pil-ee-integration-council
plan: "05"
subsystem: council
tags: [debate-planner, prompts, experience-engine, eeWarnings, outputStyle]
dependency_graph:
  requires: ["16-01"]
  provides: ["planDebate with EE seeding", "buildSynthesisPrompt with outputStyle"]
  affects: ["src/council/debate-planner.ts", "src/council/prompts.ts"]
tech_stack:
  added: []
  patterns: ["advisory/enforcing stance injection", "PIL outputStyle prepend"]
key_files:
  created: []
  modified:
    - src/council/debate-planner.ts
    - src/council/prompts.ts
decisions:
  - "Use injectAuditorStance helper function to centralize auditor injection at all exit points (generateObject, retry, fallback)"
  - "Inline eeSnippets injection into system string in planDebate rather than modifying buildDebatePlanPrompt signature"
  - "styleDirective prepended before base system string to ensure it takes highest priority in synthesis"
metrics:
  duration: "10m"
  completed: "2026-05-08"
  tasks_completed: 2
  tasks_total: 2
---

# Phase 16 Plan 05: EE Seeding Debate Planner + OutputStyle Synthesis Summary

One-liner: Experience warnings from EE brain injected into debate stances and Experience Auditor auto-added; PIL outputStyle propagated to synthesis prompt.

## What Was Built

### Task 1: planDebate EE seeding + Experience Auditor (f21afee)

Extended `src/council/debate-planner.ts`:

- Added imports: `CouncilWarning` from `../ee/council-bridge.js` and `CouncilExperienceMode` from `../utils/settings.js`
- Signature extended: `planDebate(spec, leaderModelId, llm, eeWarnings?, experienceMode?)`
- EE snippets injected into system prompt: when `eeWarnings.length > 0`, system prompt gains `## Experience Warnings (from brain)` section
- `injectAuditorStance` helper centralizes stance injection logic:
  - `advisory` mode (default when mode != off): appends "Experience Auditor" as 3rd voice
  - `enforcing` mode: replaces last generic stance with "Experience Auditor"
  - `off` mode: no injection
- Auditor `focus` built from `eeWarnings.map(w=>w.text).join("; ").slice(0,300)`
- Applied at all 3 exit points: generateObject success, tracedGenerate retry, FALLBACK_PLAN

### Task 2: buildSynthesisPrompt outputStyle (479b0c0)

Extended `src/council/prompts.ts`:

- `buildSynthesisPrompt` ctx now accepts `outputStyle?: string | null` (CQ-18)
- Style directive computed based on value: `concise` (brief/bullets), `detailed` (thorough), `balanced` (default)
- Directive PREPENDED to system string so it takes priority
- No changes to existing synthesis sections logic

## Deviations from Plan

None - plan executed exactly as written.

## Threat Surface Scan

No new network endpoints or trust boundaries introduced. EE warning text is slice(0,300)-capped before injection per T-16-05-01 disposition (accept).

## Self-Check

- [x] `src/council/debate-planner.ts` modified: f21afee
- [x] `src/council/prompts.ts` modified: 479b0c0
- [x] TypeScript compiles clean (`bun tsc --noEmit` = no output)
- [x] `grep "Experience Auditor" src/council/debate-planner.ts` = 4 matches
- [x] `grep "outputStyle" src/council/prompts.ts` = 6 matches

## Self-Check: PASSED
