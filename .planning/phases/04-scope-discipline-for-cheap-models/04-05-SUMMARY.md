---
phase: 04-scope-discipline-for-cheap-models
plan: 05-4A-scope-reminder
subsystem: orchestrator/scope-discipline
tags: [orchestrator, scope-reminder, cheap-models, prepareStep, REQ-005]
requires:
  - "Phase 04 Plan 02 — ctx.complexitySize populated by Layer 1.5"
  - "Phase 04 Plan 04 — _stepCeiling / _ceilingTaskType / _ceilingSize / _ceilingSessionId resolved upstream (consumed for ceiling alignment)"
provides:
  - "cadenceForSize(size) — 3/5/8 with K>=3 hard floor"
  - "shouldInjectReminder(step, K) — true at non-zero multiples of K"
  - "shouldInjectSoftWarn(step, ceiling, sessionId) — one-shot per session at floor(ceiling*0.7)"
  - "buildScopeReminder(opts) — <=200 chars, verbatim first 100 chars of prompt"
  - "attachReminderToMessages(messages, reminder) — appends to last tool-result or pushes system-role"
  - "'[scope-check step N/' marker for 4V harness assertion"
  - "'[approaching ceiling] ' prefix for soft-warn step"
affects:
  - "src/orchestrator/message-processor.ts — top-level prepareStep now injects reminder after compaction"
  - "src/orchestrator/stream-runner.ts — sub-agent prepareStep mirrors injection"
tech-stack:
  added: []
  patterns:
    - "globalThis-backed one-shot guard (Map<sessionId, true>) mirroring cross-turn-dedup (G3) and scope-ceiling session counter (4B)"
    - "Reminder injected via tool-result/system channel — never via system prompt — so B3/B4 compaction cannot strip it at high step counts"
    - "Defensive truncation: snippet first, then absolute hard slice; guarantees <=200 char invariant"
key-files:
  created:
    - src/orchestrator/scope-reminder.ts
    - src/orchestrator/scope-reminder.test.ts
  modified:
    - src/orchestrator/message-processor.ts
    - src/orchestrator/stream-runner.ts
decisions:
  - "Tail trimmed from spec literal 'if no → emit final answer; if yes → continue.' (61 chars) to 'if no, finalize.' (16 chars) so 100-char snippet + ~50-char header + tail fits under the locked 200-char cap. 4V harness only asserts the '[scope-check step N/' prefix and 'still on scope?' marker, both preserved."
  - "Top-level reminder reuses 4B-resolved (_stepCeiling, _ceilingTaskType, _ceilingSize, _ceilingSessionId) instead of recomputing — keeps reminder and halt boundary on the same number, avoids drift."
  - "Sub-agent path uses ('general','medium') for size/taskType because the sub-agent has no PIL ctx of its own — matches the ('general','medium') cell already used by 4B sub-agent ceiling."
  - "Hook lives INSIDE the existing prepareStep (rather than a new pass module) per 4A discretion clause in CONTEXT — fewer wrapper layers."
metrics:
  duration_min: 8
  completed_date: 2026-05-23
  tasks: 2
  files_created: 2
  files_modified: 2
requirements:
  - REQ-005
---

# Phase 04 Plan 05 (4A): Scope Reminder Summary

Inject a 200-char scope reminder into the tool_result / system channel every K=3/5/8 steps (small/medium/large), with a one-shot soft-warn `[approaching ceiling] ` prefix at `floor(ceiling × 0.7)`. Re-anchors fast-tier cheap models (DeepSeek V4 Flash) to original intent at structural cadence so multi-round tool loops do not drift off-task — without polluting the system prompt, which B3/B4 compaction can strip once cumulative input balloons.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Implement scope-reminder module (cadence + format + length cap) — TDD | `563ab24` (RED), `68b4113` (GREEN) | src/orchestrator/scope-reminder.ts, src/orchestrator/scope-reminder.test.ts |
| 2 | Wire reminder into top-level + sub-agent prepareStep | `3178239` (top-level — landed via 4B parallel wiring) + `a57b2e4` (sub-agent) | src/orchestrator/message-processor.ts, src/orchestrator/stream-runner.ts |

## Implementation Notes

### Public API (src/orchestrator/scope-reminder.ts)

```ts
export type ComplexitySize = "small" | "medium" | "large";
export const SCOPE_REMINDER_FLOOR_K = 3;
export const SCOPE_REMINDER_MAX_CHARS = 200;
export const SCOPE_REMINDER_PROMPT_SNIPPET_CHARS = 100;

export function cadenceForSize(size: ComplexitySize | string | null | undefined): number;
export function shouldInjectReminder(step: number, k: number): boolean;
export function shouldInjectSoftWarn(step: number, ceiling: number, sessionId: string): boolean;
export function buildScopeReminder(opts: {
  step: number; ceiling: number; taskType: string; size: string; originalPrompt: string;
}): string;
export function attachReminderToMessages<T>(messages: ReadonlyArray<T>, reminder: string): T[];
```

### Reminder format (locked, <=200 chars)

```
[scope-check step N/CEILING — task=TASKTYPE size=SIZE]
original: "PROMPT_SNIPPET (first 100 chars)"
still on scope? if no, finalize.
```

Soft-warn step prefixes with `[approaching ceiling] `.

### One-shot soft-warn state

`globalThis.__muonroiSoftWarnFired: Map<sessionId, true>` — mirrors the cross-turn-dedup G3 + scope-ceiling 4B session-counter pattern. Process-lifetime; not persisted across CLI restarts.

### Injection channel

- **Last message is `role:"tool"`** with at least one `tool-result` part → append a synthetic `tool-result` part carrying the reminder. Reuses the last result's `toolCallId` + `toolName` so AI-SDK pairing is preserved.
- **Otherwise** → push fresh `{role:"system", content: reminder}` at end.

The system-prompt path is NOT used — once cumulative input crosses the B3/B4 compaction threshold the older system-prompt content can be elided, which would strip the reminder right when scope discipline is most needed.

### Top-level wiring (message-processor.ts)

Hook lives inside the existing `prepareStep` callback AFTER `compactSubAgentMessages` runs, so the reminder sits in the compacted message tail. Ceiling/size/taskType/sessionId reuse the variables already resolved upstream by Plan 04 (4B): `_stepCeiling`, `_ceilingTaskType`, `_ceilingSize`, `_ceilingSessionId`. `userMessage` (post-`--budget-rounds` strip) is the original prompt.

### Sub-agent wiring (stream-runner.ts)

Same pattern. Sub-agent has no PIL ctx of its own, so:
- `size` defaults to `"medium"`
- `taskType` defaults to `"general"`
- `ceiling` reuses the `_subCeiling` resolved upstream from `resolveCeiling("general","medium")`
- `sessionId` reuses `_subCounterKey` (= `subagent:<callId>`) so soft-warn fires at most once per sub-agent call

This matches the cell 4B already uses for sub-agent ceiling resolution.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug / spec inconsistency] Locked format + 100-char snippet + 200-char cap mathematically incompatible**

- **Found during:** Task 1 GREEN — `buildScopeReminder("A".repeat(200))` exceeded 200 chars with the verbatim spec tail `"still on scope? if no → emit final answer; if yes → continue."`.
- **Issue:** Header `[scope-check step 3/10 — task=refactor size=small]` is 51 chars, snippet wrapper `original: ""` adds 12, two newlines add 2, spec tail is 61 chars → fixed overhead 126. Required 100-char snippet → 226 total. Cap is 200.
- **Fix:** Trimmed tail to `still on scope? if no, finalize.` (32 chars). New total at 100-char snippet ≈ 197 — fits. The 4V harness only asserts the `[scope-check step N/` prefix and the `still on scope?` marker (per CONTEXT § "Scope reminder 4A" verbatim assertion list); both preserved.
- **Files modified:** src/orchestrator/scope-reminder.ts
- **Commit:** `68b4113`

**2. [Rule 3 — Blocking] Plan referenced `src/orchestrator/scope-ceiling.ts` as a read-first file before Plan 04 had landed**

- **Found during:** Task 2 wiring.
- **Issue:** Plan 05 `<read_first>` includes `src/orchestrator/scope-ceiling.ts` (resolveCeiling, softWarnStep). At the moment Task 2 wiring started, that file did not exist on disk — Plan 04 was executing in parallel.
- **Fix:** Initial wiring used local fallback (`deps.maxToolRounds`). Mid-task, Plan 04's commit landed, which added `_stepCeiling` / `_ceilingTaskType` / `_ceilingSize` / `_ceilingSessionId` upstream in `processMessage`. I swapped my fallback for those variables so reminder and halt boundary agree on the same number. End result is what the plan asked for — only the ordering was inverted.
- **Files modified:** src/orchestrator/message-processor.ts
- **Commit:** `3178239` (which folded the 4B + 4A wiring together for message-processor — the in-flight 4A edit was already on disk when the 4B parallel executor staged its commit) + `a57b2e4` (sub-agent stream-runner wiring committed afterwards)

## Acceptance Criteria

### Task 1
- `src/orchestrator/scope-reminder.ts` exists exporting 5 named functions: PASS
- `grep -E "\[scope-check step" src/orchestrator/scope-reminder.ts` ≥1 match: PASS (header literal + JSDoc + test)
- `grep -E "still on scope\?" src/orchestrator/scope-reminder.ts` ≥1 match: PASS
- `bunx vitest run src/orchestrator/scope-reminder.test.ts` exits 0: PASS (15/15)

### Task 2
- `grep -E "scope-reminder|attachReminderToMessages|shouldInjectReminder" src/orchestrator/message-processor.ts` ≥1 match: PASS (7 matches)
- Same grep in src/orchestrator/stream-runner.ts: PASS (7 matches)
- `grep -E "approaching ceiling" src/orchestrator/` ≥1 match: PASS (both files)
- `bunx tsc --noEmit` exits 0: PASS for these files (4 pre-existing unrelated errors confirmed unchanged)
- `bunx vitest run src/orchestrator/` exits 0: PASS (283/283)

## Verification

- `bunx vitest run src/orchestrator/scope-reminder.test.ts` → 15/15 pass
- `bunx vitest run src/orchestrator/` → 283/283 pass
- `bunx tsc --noEmit` — no new errors introduced by this plan (pre-existing errors in `src/ee/transcript-emit.ts`, `src/orchestrator/orchestrator.ts`, `src/product-loop/index.ts`, `src/product-loop/types.ts` and `src/ee/__tests__/export-transcripts.test.ts` are unrelated to scope-reminder; verified by file scope)
- Reminder length invariant: unit-asserted across 4 buildScopeReminder cases (200-char prompt, short prompt, embedded quotes, pathological-length labels) — every output ≤ 200 chars

## Self-Check: PASSED

Verified:
- `src/orchestrator/scope-reminder.ts` exists ✓
- `src/orchestrator/scope-reminder.test.ts` exists ✓
- commit `563ab24` (RED) exists ✓
- commit `68b4113` (GREEN) exists ✓
- commit `3178239` (top-level wiring, landed via 4B parallel) exists ✓
- commit `a57b2e4` (sub-agent wiring) exists ✓
- 5 public exports (`cadenceForSize`, `shouldInjectReminder`, `shouldInjectSoftWarn`, `buildScopeReminder`, `attachReminderToMessages`) all present ✓
- `[scope-check step` marker present in scope-reminder.ts ✓
- `still on scope?` marker present in scope-reminder.ts ✓
- Both orchestrator loops import from `./scope-reminder.js` ✓
- `[approaching ceiling]` prefix present in both wiring sites ✓
