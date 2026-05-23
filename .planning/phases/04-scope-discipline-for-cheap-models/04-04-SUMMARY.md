---
phase: 04-scope-discipline-for-cheap-models
plan: 04-4B-ceiling-forced-finalize
subsystem: orchestrator/scope-ceiling
tags: [orchestrator, scope-discipline, step-ceiling, forced-finalize, session-counter]
requires:
  - "Plan 02 (4C complexity-size) — pilCtx.complexitySize must be populated"
provides:
  - "resolveCeiling(taskType, size) — locked 7x3 (task_type × small/medium/large) matrix"
  - "parseBudgetOverride(raw) — extracts --budget-rounds N before PIL classifies"
  - "softWarnStep(ceiling) = floor(ceiling * 0.7) for 4A handoff"
  - "get/inc/resetSessionStepCount — globalThis-backed per-session counter"
  - "forcedFinalize({model, messages, system}) — single generateText call with toolChoice:'none'"
  - "Top-level orchestrator integration: hard halt + forced-finalize + warn/info toasts"
  - "Sub-agent stream-runner integration: ceiling alongside stepCountIs(maxSteps)"
affects:
  - "src/orchestrator/message-processor.ts — dynamicStopWhen composes ceiling with cap+pattern guard"
  - "src/orchestrator/stream-runner.ts — sub-agent stopWhen composes ceiling alongside maxSteps"
tech-stack:
  added: []
  patterns:
    - "Logical OR composition of stopWhen predicates (existing tool-loop-cap untouched, ceiling layered on top)"
    - "globalThis Map<sessionId, count> mirrors 4R bash-repeat / C3 cross-turn-dedup pattern"
    - "Pre-PIL flag extraction so --budget-rounds never reaches the LLM"
    - "Zero Hardcode Rule: forcedFinalize receives model from caller; no provider/model literals"
key-files:
  created:
    - src/orchestrator/scope-ceiling.ts
    - src/orchestrator/scope-ceiling.test.ts
  modified:
    - src/orchestrator/message-processor.ts
    - src/orchestrator/stream-runner.ts
decisions:
  - "Sub-agent ceiling uses ('general','medium') because sub-agents have no PIL ctx; the caller's maxSteps bound is preserved via logical OR"
  - "Per-sub-agent counter keyed by `subagent:${subCallId}` so each sub-agent invocation starts fresh — prevents one wandering subagent from poisoning the next"
  - "forcedFinalize lazy-imports `ai` and accepts a __testInvoke escape hatch so unit tests never need a real provider runtime"
  - "Composition via async wrapper around createToolLoopCapPredicate, NOT replacement — preserves Fix #1 cap askcard + pattern dup detection unchanged"
metrics:
  duration_min: 8
  completed_date: 2026-05-23
  tasks: 2
  files_modified: 4
requirements:
  - REQ-004
---

# Phase 04 Plan 04: 4B Step Ceiling + Forced-Finalize Summary

Per-session step ceiling resolved from a locked `(task_type × complexity_size)` matrix. Hard halt at ceiling triggers one final LLM call with `toolChoice: "none"` so the cheap model synthesizes a partial answer from accumulated context before the user sees a silent stop. `--budget-rounds N` parsed off the raw prompt BEFORE PIL classifies so the flag never reaches the model and never biases intent. Closes REQ-004 — directly targets the 371/259-tool wandering sessions captured in baseline telemetry.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | scope-ceiling module (matrix + override + counter + forcedFinalize) — TDD | `4e7ad66` (RED) + `96cfd46` (GREEN) | src/orchestrator/scope-ceiling.ts, src/orchestrator/scope-ceiling.test.ts |
| 2 | Wire into top-level (message-processor) + sub-agent (stream-runner) | `3178239` | src/orchestrator/message-processor.ts, src/orchestrator/stream-runner.ts |

## Implementation Notes

### Matrix (locked verbatim — DO NOT alter without baseline re-run)

| task_type | small | medium | large |
|---|---|---|---|
| analyze | 5 | 10 | 15 |
| debug | 6 | 12 | 20 |
| refactor | 8 | 14 | 22 |
| generate | 10 | 18 | 30 |
| plan | 4 | 8 | 12 |
| documentation | 5 | 8 | 12 |
| general | 5 | 10 | 20 |

Unknown taskType falls back to the `general` row.

### Override grammar

Regex: `/(^|\s)--budget-rounds\s+(\d{1,5})(\s|$)/`. Non-numeric values are rejected (returns `override: undefined`, prompt untouched). Stripping the flag re-collapses whitespace and trims.

### Top-level integration flow

1. `parseBudgetOverride(userMessage)` — mutates `userMessage` to cleaned prompt
2. PIL pipeline runs on cleaned prompt → produces `pilCtx.taskType` + `pilCtx.complexitySize.size`
3. `_stepCeiling = override ?? resolveCeiling(taskType, size)`
4. If override differs from natural ceiling: info toast `"override active: ceiling N, default was M (task=X/size=Y)"`
5. `dynamicStopWhen` wraps existing `createToolLoopCapPredicate` with an async outer that also calls `incSessionStep(sessionId)`; ceiling hit sets `_ceilingHit = true` and returns true
6. After fullStream loop, if `_ceilingHit && !signal.aborted`: `forcedFinalize({model, messages, system})` → text appended to `assistantText` + yielded as content chunk
7. Warn toast: `"halted: step ceiling exceeded for task_type=X size=Y at step N/N"`

### Sub-agent integration

Mirror with `resolveCeiling("general", "medium")` (sub-agents have no PIL ctx of their own). Counter keyed by `subagent:${subCallId}` so each sub-agent invocation starts fresh. Composes with `stepCountIs(maxSteps)` via logical OR — whichever fires first halts the sub-agent.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking] TS type mismatch on systemForModel**
- **Found during:** Task 2 — `bunx tsc --noEmit`
- **Issue:** `systemForModel` in message-processor can be either `string` or `Array<{role,content,...}>` depending on the path; forcedFinalize signature accepts `system?: string` only.
- **Fix:** Pass `typeof systemForModel === "string" ? systemForModel : undefined` at the call site. The array branch is for prompt-caching tagged content — graceful degrade to no-system on forced-finalize is acceptable since accumulated `messages` already carry the conversational context.
- **Files modified:** src/orchestrator/message-processor.ts
- **Commit:** `3178239`

**2. [Rule 3 - blocking] AI SDK generateText Prompt-shape generic too narrow**
- **Found during:** Task 1 — `bunx tsc --noEmit`
- **Issue:** AI SDK's `generateText` parameter type uses an XOR over `prompt | messages` with deeply nested generics. Passing `messages: unknown[]` upstream tripped the narrower variant.
- **Fix:** Cast the call args object to `any` at the boundary with a biome-ignore comment, keeping the module surface fully typed. This is justified by the Zero Hardcode Rule — we deliberately accept any model the caller resolved, so we cannot infer the SDK's narrow generic at this layer.
- **Files modified:** src/orchestrator/scope-ceiling.ts
- **Commit:** `96cfd46`

## Deferred Issues

Pre-existing TS errors (`src/ee/transcript-emit.ts`, `src/orchestrator/orchestrator.ts`, `src/product-loop/index.ts`, `src/ee/__tests__/export-transcripts.test.ts`) are NOT caused by Plan 04 — already tracked in Plan 02's `deferred-items.md`. Verified via `bunx tsc --noEmit` filter on `scope-ceiling|message-processor|stream-runner` showing zero matches after fix.

## Verification

- `bunx vitest run src/orchestrator/scope-ceiling.test.ts` → 20/20 pass
- `bunx vitest run src/orchestrator/` → 283/283 pass (no orchestrator-suite regressions)
- `bunx tsc --noEmit` → no new errors in changed files (pre-existing errors unchanged)
- `grep -cE "resolveCeiling|parseBudgetOverride|forcedFinalize|incSessionStep" src/orchestrator/message-processor.ts` → 8 (≥4 required)
- `grep -cE "resolveCeiling|incSessionStep" src/orchestrator/stream-runner.ts` → 3 (≥2 required)
- `grep -cE "halted: step ceiling exceeded|override active: ceiling" src/orchestrator/message-processor.ts` → 2 (toast strings present)
- `grep -cE "\"(claude|gpt|deepseek|anthropic|openai)-" src/orchestrator/scope-ceiling.ts` → 0 (Zero Hardcode Rule)

## Self-Check: PASSED

Verified:
- `src/orchestrator/scope-ceiling.ts` exists
- `src/orchestrator/scope-ceiling.test.ts` exists
- commit `4e7ad66` (RED test) exists
- commit `96cfd46` (GREEN implementation) exists
- commit `3178239` (wiring) exists
- `resolveCeiling` / `parseBudgetOverride` / `forcedFinalize` / `incSessionStep` referenced in src/orchestrator/message-processor.ts
- `resolveCeiling` / `incSessionStep` referenced in src/orchestrator/stream-runner.ts
