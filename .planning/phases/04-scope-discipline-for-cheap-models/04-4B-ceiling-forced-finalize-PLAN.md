---
phase: 04-scope-discipline-for-cheap-models
plan: 04
type: execute
wave: 2
depends_on: [02]
files_modified:
  - src/orchestrator/scope-ceiling.ts
  - src/orchestrator/scope-ceiling.test.ts
  - src/orchestrator/message-processor.ts
  - src/orchestrator/stream-runner.ts
autonomous: true
requirements: [REQ-004]
must_haves:
  truths:
    - "Step ceiling resolved from (task_type × complexity_size) matrix"
    - "Hard halt at ceiling triggers final tool_choice:none LLM call (forced-finalize)"
    - "Warn toast fires with `halted: step ceiling exceeded for task_type=X size=Y at step N/N`"
    - "--budget-rounds N parses BEFORE PIL, overrides ceiling, emits override-active info toast"
    - "Per-session counter persists across user turns"
  artifacts:
    - path: src/orchestrator/scope-ceiling.ts
      provides: "resolveCeiling(taskType, size), parseBudgetOverride(rawPrompt), session counter, forcedFinalize() helper"
    - path: src/orchestrator/scope-ceiling.test.ts
      provides: "Matrix lookup tests + parseBudgetOverride tests + counter persistence tests"
  key_links:
    - from: src/orchestrator/message-processor.ts
      to: src/orchestrator/scope-ceiling.ts
      via: "stopWhen reads ceiling; on hit, triggers forced-finalize"
      pattern: "resolveCeiling|scope-ceiling"
    - from: src/orchestrator/stream-runner.ts
      to: src/orchestrator/scope-ceiling.ts
      via: "Sub-agent loop mirrors top-level integration"
      pattern: "resolveCeiling|scope-ceiling"
---

<objective>
Implement per-session step ceiling with forced-finalize on halt. Resolves `(task_type × complexity_size)` matrix to a hard step budget. When budget hit, orchestrator makes ONE final LLM call with `tool_choice: "none"` to synthesize partial answer from accumulated context, then emits warn toast.

Purpose: Closes REQ-004. Stops 371/259-tool wandering sessions.
Output: New scope-ceiling module + integration into top-level and sub-agent loops + unit tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md
@src/orchestrator/message-processor.ts
@src/orchestrator/stream-runner.ts
@src/orchestrator/tool-loop-cap.ts
@src/orchestrator/cross-turn-dedup.ts
@src/pil/layer1_5-complexity-size.ts
@src/pil/types.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement scope-ceiling module (matrix + parseBudgetOverride + session counter + forced-finalize helper)</name>
  <files>src/orchestrator/scope-ceiling.ts, src/orchestrator/scope-ceiling.test.ts</files>
  <read_first>
    - src/orchestrator/tool-loop-cap.ts (existing pattern guard — 4B composes around it)
    - src/orchestrator/cross-turn-dedup.ts (session-state pattern reference)
    - src/pil/layer1_5-complexity-size.ts (produced by Plan 02)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (4B locked: matrix, soft warn, override grammar, toast strings)
  </read_first>
  <behavior>
    Ceiling matrix lookup (locked verbatim):
    | task_type | small | medium | large |
    | analyze | 5 | 10 | 15 |
    | debug | 6 | 12 | 20 |
    | refactor | 8 | 14 | 22 |
    | generate | 10 | 18 | 30 |
    | plan | 4 | 8 | 12 |
    | documentation | 5 | 8 | 12 |
    | general | 5 | 10 | 20 |
    Tests:
    - resolveCeiling("analyze","small") === 5; ("generate","large") === 30; unknown taskType falls back to "general" row
    - parseBudgetOverride("--budget-rounds 20 fix bug") → { override: 20, cleanedPrompt: "fix bug" }
    - parseBudgetOverride("no flag here") → { override: undefined, cleanedPrompt: "no flag here" }
    - Session counter: increment+read across two calls with same sessionId preserves count; different sessionId is isolated
    - Soft-warn step computed as Math.floor(ceiling * 0.7)
  </behavior>
  <action>
    Create `src/orchestrator/scope-ceiling.ts` exporting:

    ```ts
    export type TaskType = "analyze"|"debug"|"refactor"|"generate"|"plan"|"documentation"|"general";
    export type ComplexitySize = "small"|"medium"|"large";

    export function resolveCeiling(taskType: string, size: ComplexitySize): number;
    export function softWarnStep(ceiling: number): number; // Math.floor(ceiling*0.7)
    export function parseBudgetOverride(raw: string): { override: number | undefined; cleanedPrompt: string };
    export function getSessionStepCount(sessionId: string): number;
    export function incSessionStep(sessionId: string): number;
    export function resetSessionStep(sessionId: string): void;
    export async function forcedFinalize(opts: {
      model: unknown; messages: unknown[]; system?: string;
    }): Promise<{ text: string }>; // calls streamText/generateText with tool_choice:"none"
    ```

    Matrix encoded as a const Record. `parseBudgetOverride` regex: `/(^|\s)--budget-rounds\s+(\d{1,5})(\s|$)/`. Strip the matched flag from prompt; trim surrounding whitespace.

    Session counter via `globalThis.__muonroiSessionStepCount: Map<string, number>` (mirror 4R pattern).

    `forcedFinalize` invokes the model with `tool_choice: "none"` (Vercel AI SDK syntax: `toolChoice: "none"` on streamText/generateText) and returns the synthesized text. Keep signature minimal so callers in message-processor + stream-runner can adapt.

    Create `src/orchestrator/scope-ceiling.test.ts` covering all behaviors above. Mock the model factory for forcedFinalize test (return canned text).
  </action>
  <verify>
    <automated>bunx vitest run src/orchestrator/scope-ceiling.test.ts</automated>
  </verify>
  <done>Module + tests green; no model hardcoding (uses passed-in `opts.model`).</done>
  <acceptance_criteria>
    - File exists at `src/orchestrator/scope-ceiling.ts` exporting all 7 names listed above
    - `grep -E "resolveCeiling|parseBudgetOverride|forcedFinalize|incSessionStep" src/orchestrator/scope-ceiling.ts` returns ≥4 distinct matches
    - `grep -E "\"(claude|gpt|deepseek|anthropic|openai)-" src/orchestrator/scope-ceiling.ts` returns 0 matches (Zero Hardcode Rule)
    - `bunx vitest run src/orchestrator/scope-ceiling.test.ts` exits 0
    - Test file contains all 7 task_type rows of the matrix (each row referenced by name)
  </acceptance_criteria>
</task>

<task type="auto">
  <name>Task 2: Wire scope-ceiling into top-level orchestrator (message-processor) + sub-agent (stream-runner)</name>
  <files>src/orchestrator/message-processor.ts, src/orchestrator/stream-runner.ts</files>
  <read_first>
    - src/orchestrator/message-processor.ts (stopWhen ~line 1278, prepareStep ~1281, experimental_onStepStart ~1306, stepNumber ~1010)
    - src/orchestrator/stream-runner.ts (stopWhen ~line 479, prepareStep ~482)
    - src/orchestrator/scope-ceiling.ts (Task 1 output)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (4B locked decisions on toast strings + override)
  </read_first>
  <action>
    1. In `message-processor.ts`, BEFORE PIL classifies, run `parseBudgetOverride(rawPrompt)`. Use `cleanedPrompt` as the PIL input. Stash `override` for later.

    2. After PIL produces `taskType` + `complexitySize`, compute `ceiling = override ?? resolveCeiling(taskType, complexitySize.size)`. If `override` is defined and differs from the natural ceiling, emit info toast: `"override active: ceiling ${override}, default was ${naturalCeiling} (task=${taskType}/size=${complexitySize.size})"`.

    3. Compose into existing `stopWhen` (around line 1278): return true when `incSessionStep(sessionId) >= ceiling`. Persist counter via session-scoped helper (NOT per-turn).

    4. On halt (stopWhen returns true), call `forcedFinalize({ model, messages, system })` and append its text to the assistant output, then emit warn toast: `"halted: step ceiling exceeded for task_type=${taskType} size=${complexitySize.size} at step ${ceiling}/${ceiling}"`.

    5. Mirror the same integration in `stream-runner.ts` for sub-agents (stopWhen ~479).

    6. Do NOT modify existing tool-loop-cap.ts behavior — compose alongside it (logical OR of stopWhen conditions).
  </action>
  <verify>
    <automated>bunx tsc --noEmit && bunx vitest run src/orchestrator/</automated>
  </verify>
  <done>Both loops integrate ceiling + forced-finalize; tsc clean; existing orchestrator tests still green.</done>
  <acceptance_criteria>
    - `grep -n "resolveCeiling\|parseBudgetOverride\|forcedFinalize\|incSessionStep" src/orchestrator/message-processor.ts` returns ≥4 matches
    - `grep -n "resolveCeiling\|incSessionStep" src/orchestrator/stream-runner.ts` returns ≥2 matches
    - `grep -E "halted: step ceiling exceeded" src/orchestrator/message-processor.ts` returns ≥1 match
    - `grep -E "override active: ceiling" src/orchestrator/message-processor.ts` returns ≥1 match
    - `bunx tsc --noEmit` exits 0
    - `bunx vitest run src/orchestrator/` exits 0
  </acceptance_criteria>
</task>

</tasks>

<verification>
- `bunx tsc --noEmit` clean
- Orchestrator unit tests untouched and green
- New scope-ceiling tests green
</verification>

<success_criteria>
- REQ-004 satisfied: matrix lookup, hard halt, forced-finalize, override grammar, per-session counter, toast strings exact
- Sets stage for 4V harness assertions
</success_criteria>

<output>
After completion, create `.planning/phases/04-scope-discipline-for-cheap-models/04-04-SUMMARY.md`
</output>
