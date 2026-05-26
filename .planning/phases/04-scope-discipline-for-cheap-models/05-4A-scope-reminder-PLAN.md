---
phase: 04-scope-discipline-for-cheap-models
plan: 05
type: execute
wave: 2
depends_on: [02]
files_modified:
  - src/orchestrator/scope-reminder.ts
  - src/orchestrator/scope-reminder.test.ts
  - src/orchestrator/subagent-compactor.ts
  - src/orchestrator/message-processor.ts
  - src/orchestrator/stream-runner.ts
autonomous: true
requirements: [REQ-005]
must_haves:
  truths:
    - "Reminder injected every K steps where K=3/5/8 for small/medium/large"
    - "Soft-warn fires once at floor(ceiling × 0.7)"
    - "Reminder text ≤200 chars, contains verbatim first 100 chars of original prompt"
    - "Total reminder overhead <1.5% session tokens"
  artifacts:
    - path: src/orchestrator/scope-reminder.ts
      provides: "buildScopeReminder, shouldInjectReminder, attachReminderToMessages"
    - path: src/orchestrator/scope-reminder.test.ts
      provides: "Cadence + format + length tests"
  key_links:
    - from: src/orchestrator/subagent-compactor.ts
      to: src/orchestrator/scope-reminder.ts
      via: "attachReminderToMessages invoked in tool_result rewriting layer"
      pattern: "attachReminderToMessages|scope-reminder"
    - from: src/orchestrator/message-processor.ts
      to: src/orchestrator/scope-reminder.ts
      via: "prepareStep wires reminder injection at K cadence"
      pattern: "scope-reminder"
---

<objective>
Inject scope reminder into next tool_result every K steps where K=3 (small), 5 (medium), 8 (large). Soft-warn one-shot at floor(ceiling × 0.7). Reminder lives in tool_result/system message — NOT in system prompt (would be stripped under compaction).

Purpose: Closes REQ-005. Re-anchors cheap model to original intent at structural cadence.
Output: New scope-reminder module, wired into existing compactor pass + both orchestrator loops.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md
@src/orchestrator/scope-ceiling.ts
@src/orchestrator/subagent-compactor.ts
@src/orchestrator/message-processor.ts
@src/orchestrator/stream-runner.ts
@src/pil/layer1_5-complexity-size.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement scope-reminder module (cadence + format + length cap)</name>
  <files>src/orchestrator/scope-reminder.ts, src/orchestrator/scope-reminder.test.ts</files>
  <read_first>
    - src/orchestrator/subagent-compactor.ts (injection point pattern)
    - src/orchestrator/scope-ceiling.ts (resolveCeiling, softWarnStep)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (4A locked: cadence table, format, hard floor)
  </read_first>
  <behavior>
    Cadence K table (locked):
    - small → 3
    - medium → 5
    - large → 8
    - Hard floor: K ≥ 3 always
    Reminder template (locked, ≤200 chars):
      [scope-check step N/CEILING — task=TASKTYPE size=SIZE]
      original: "PROMPT_SNIPPET (first 100 chars)"
      still on scope? if no → emit final answer; if yes → continue.
    Tests:
    - shouldInjectReminder(step=3, K=3) → true; step=4, K=3 → false; step=6, K=3 → true (multiples of K)
    - shouldInjectSoftWarn fires ONCE at step === floor(ceiling*0.7); subsequent calls return false
    - buildScopeReminder snapshot test asserts total length ≤200 and contains verbatim prompt[0..100]
    - When original prompt < 100 chars, snippet is whole prompt (no padding)
  </behavior>
  <action>
    Create `src/orchestrator/scope-reminder.ts` exporting:

    ```ts
    export function cadenceForSize(size: "small"|"medium"|"large"): number; // 3/5/8, floor ≥ 3
    export function shouldInjectReminder(step: number, K: number): boolean;
    export function shouldInjectSoftWarn(step: number, ceiling: number, sessionId: string): boolean; // fires once per session
    export function buildScopeReminder(opts: {
      step: number; ceiling: number; taskType: string; size: string; originalPrompt: string;
    }): string; // ≤200 chars
    export function attachReminderToMessages(messages: unknown[], reminder: string): unknown[];
    ```

    `attachReminderToMessages`: if last message is `role:"tool"` (tool_result), append reminder to its content; else push a new `{role:"system", content: reminder}` at end.

    `shouldInjectSoftWarn` uses session-scoped Map for one-shot guard: `globalThis.__muonroiSoftWarnFired: Map<sessionId, Set<step>>`.

    `buildScopeReminder` slices `originalPrompt.slice(0, 100)`, escapes embedded quotes, hard-truncates final string to 200 chars if any field overflow (defensive).

    Create `src/orchestrator/scope-reminder.test.ts` covering all behaviors above plus the ≤200-char invariant on long inputs.
  </action>
  <verify>
    <automated>bunx vitest run src/orchestrator/scope-reminder.test.ts</automated>
  </verify>
  <done>Module + tests green; no model/provider hardcoding.</done>
  <acceptance_criteria>
    - File `src/orchestrator/scope-reminder.ts` exists exporting 5 named functions above
    - `grep -E "\\[scope-check step" src/orchestrator/scope-reminder.ts` returns ≥1 match
    - `grep -E "still on scope\\?" src/orchestrator/scope-reminder.ts` returns ≥1 match
    - `bunx vitest run src/orchestrator/scope-reminder.test.ts` exits 0
  </acceptance_criteria>
</task>

<task type="auto">
  <name>Task 2: Wire reminder into compactor + both orchestrator loops</name>
  <files>src/orchestrator/subagent-compactor.ts, src/orchestrator/message-processor.ts, src/orchestrator/stream-runner.ts</files>
  <read_first>
    - src/orchestrator/subagent-compactor.ts (existing B3/B4 rewriting pass)
    - src/orchestrator/message-processor.ts (prepareStep ~1281, stepNumber ~1010)
    - src/orchestrator/stream-runner.ts (prepareStep ~482)
    - src/orchestrator/scope-reminder.ts (from Task 1)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (4A discretion: bundle into compactor vs new pass — pick fewer wrapper layers)
  </read_first>
  <action>
    1. In the compactor module (or via new pass adjacent), expose a hook that, given (step, ceiling, K, taskType, size, originalPrompt, messages, sessionId), conditionally calls `attachReminderToMessages` when `shouldInjectReminder(step, K)` is true. Wire soft-warn similarly: when `shouldInjectSoftWarn(step, ceiling, sessionId)` is true, prepend "[approaching ceiling] " to the reminder for that step.

    2. In `message-processor.ts` `prepareStep` callback: compute K via `cadenceForSize(ctx.complexitySize.size)`, then call the wiring from step 1. Use the session step counter from scope-ceiling.

    3. Mirror in `stream-runner.ts` `prepareStep`.

    4. Confirm reminders go through tool_result/system path — never via the system prompt argument to streamText.

    Discretion (per CONTEXT): if a clean adjacent pass produces fewer wrappers than modifying subagent-compactor.ts, add a new pass module. Otherwise extend subagent-compactor.ts.
  </action>
  <verify>
    <automated>bunx tsc --noEmit && bunx vitest run src/orchestrator/</automated>
  </verify>
  <done>Reminder injected at K cadence in both loops; soft-warn prefix appears at floor(ceiling*0.7); existing tests green.</done>
  <acceptance_criteria>
    - `grep -E "scope-reminder|attachReminderToMessages|shouldInjectReminder" src/orchestrator/message-processor.ts` returns ≥1 match
    - `grep -E "scope-reminder|attachReminderToMessages|shouldInjectReminder" src/orchestrator/stream-runner.ts` returns ≥1 match
    - `grep -E "approaching ceiling" src/orchestrator/` returns ≥1 match in either compactor or scope-reminder usage
    - `bunx tsc --noEmit` exits 0
    - `bunx vitest run src/orchestrator/` exits 0
  </acceptance_criteria>
</task>

</tasks>

<verification>
- `bunx tsc --noEmit` clean
- All orchestrator tests green
- Reminder ≤200 chars (unit-asserted)
</verification>

<success_criteria>
- REQ-005 satisfied: cadence, format, soft-warn, tool_result/system injection point (not system prompt)
- 4V can assert verbatim "[scope-check step 3/" marker
</success_criteria>

<output>
After completion, create `.planning/phases/04-scope-discipline-for-cheap-models/04-05-SUMMARY.md`
</output>
