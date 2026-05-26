---
phase: 04-scope-discipline-for-cheap-models
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  - src/tools/registry.ts
  - src/tools/registry-bash-footer.test.ts
  - src/tools/registry-session-repeat.test.ts
autonomous: true
requirements: [REQ-002]
must_haves:
  truths:
    - "Identical-canonical bash commands across multiple user turns within one session fire the repeat reminder"
    - "State persists across createBuiltinTools() rebuilds when sessionId is the same"
    - "Existing per-turn behavior still works (registry-bash-footer.test.ts still passes)"
  artifacts:
    - path: src/tools/registry.ts
      provides: "Session-scoped lastBashCanonical/lastBashRunId state"
    - path: src/tools/registry-session-repeat.test.ts
      provides: "New test: same sessionId across 2 createBuiltinTools() calls → 2nd identical command triggers reminder"
  key_links:
    - from: src/tools/registry.ts
      to: globalThis.__muonroiBashRepeatState OR session context
      via: "Map<sessionId, {lastCanonical, lastRunId}>"
      pattern: "(__muonroiBashRepeatState|bashRepeatState)"
---

<objective>
Lift bash canonical-repeat detector state from per-`createBuiltinTools()` closure to session-scoped storage. Baseline session `77cd2e11c6a5` ran identical `grep` 9× across 9 askcard turns because each turn rebuilt the tool registry, resetting closure state. Fix preserves existing reminder string format and existing unit test.

Purpose: Closes REQ-002 — zero identical-canonical bash repeats per session.
Output: Session-scoped state + existing test still green + new session-spanning test.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md
@src/tools/registry.ts
@src/tools/registry-bash-footer.test.ts
@src/orchestrator/tool-args-hash.ts
@src/orchestrator/cross-turn-dedup.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Lift bash repeat state to session scope + preserve existing test</name>
  <files>src/tools/registry.ts, src/tools/registry-session-repeat.test.ts</files>
  <read_first>
    - src/tools/registry.ts (lines 100-200 — locate `lastBashCanonical` / `lastBashRunId` closure vars)
    - src/tools/registry-bash-footer.test.ts (must keep passing)
    - src/orchestrator/cross-turn-dedup.ts (reference for session-state pattern)
    - src/orchestrator/tool-args-hash.ts (canonicalizeBashCommand stays untouched)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (4R locked decisions)
  </read_first>
  <behavior>
    - Given sessionId="S1": call createBuiltinTools({sessionId:"S1"}), run bash "grep foo bar.ts" → no reminder
    - Tear down, call createBuiltinTools({sessionId:"S1"}) AGAIN (simulates new user turn), run bash "grep foo bar.ts" → reminder fires (same canonical)
    - With sessionId="S2", run identical command → no reminder (different session)
    - Existing per-call reminder semantics preserved for same-registry-instance repeats (registry-bash-footer.test.ts behavior)
  </behavior>
  <action>
    In src/tools/registry.ts:

    1. Locate the per-closure state (around lines 118-180): `let lastBashCanonical: string | null = null; let lastBashRunId: string | null = null;` (exact names per code).

    2. Replace with session-scoped state via `globalThis.__muonroiBashRepeatState` (lower ripple than threading RuntimeContext per CONTEXT discretion clause). Type:
       ```ts
       declare global {
         var __muonroiBashRepeatState: Map<string, { lastCanonical: string | null; lastRunId: string | null }> | undefined;
       }
       const repeatState: Map<string, { lastCanonical: string | null; lastRunId: string | null }> =
         (globalThis.__muonroiBashRepeatState ??= new Map());
       ```

    3. Read sessionId from the createBuiltinTools options (add `sessionId?: string` to its options type if not already present). When sessionId is undefined, fall back to a synthetic key (e.g., `"__no_session__"`) so legacy callers still work — same behavior as before refactor.

    4. Inside the bash tool's execute handler, read `repeatState.get(sessionId)` (default `{lastCanonical: null, lastRunId: null}`), compute `canonical = canonicalizeBashCommand(args.command)`, compare to entry.lastCanonical. If match AND entry.lastRunId !== null → emit the EXISTING reminder string verbatim (do NOT change the text).

    5. After the run, write back `repeatState.set(sessionId, { lastCanonical: canonical, lastRunId: <newRunId> })`.

    6. Create `src/tools/registry-session-repeat.test.ts` with three vitest cases per <behavior>. Reset `globalThis.__muonroiBashRepeatState` in `beforeEach`. Mock or stub the actual bash exec so the test runs offline — match the style used by `registry-bash-footer.test.ts`.

    7. Do NOT modify `registry-bash-footer.test.ts`. After the refactor it MUST still pass unchanged.
  </action>
  <verify>
    <automated>bunx vitest run src/tools/registry-bash-footer.test.ts src/tools/registry-session-repeat.test.ts</automated>
  </verify>
  <done>Existing test green; new session-spanning test green; canonicalize helper unchanged.</done>
  <acceptance_criteria>
    - `grep -n "__muonroiBashRepeatState" src/tools/registry.ts` returns ≥1 match
    - `grep -n "canonicalizeBashCommand" src/tools/registry.ts` still returns ≥1 match (reuse intact)
    - `bunx vitest run src/tools/registry-bash-footer.test.ts` exits 0 (UNCHANGED test file)
    - `bunx vitest run src/tools/registry-session-repeat.test.ts` exits 0
    - `git diff src/tools/registry-bash-footer.test.ts` is empty
  </acceptance_criteria>
</task>

</tasks>

<verification>
- `bunx tsc --noEmit` 0 errors
- Both repeat detector tests green
</verification>

<success_criteria>
- REQ-002 satisfied: session-scoped state, both tests green
- Reminder string format unchanged (greppable from existing test assertions)
</success_criteria>

<output>
After completion, create `.planning/phases/04-scope-discipline-for-cheap-models/04-03-SUMMARY.md`
</output>
