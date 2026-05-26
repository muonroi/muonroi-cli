---
phase: 04-scope-discipline-for-cheap-models
plan: 07
type: execute
wave: 3
depends_on: [01, 02, 03, 04, 05, 06]
files_modified:
  - tests/harness/scope-adherence-tui.spec.ts
  - tests/harness/fixtures/llm/scope-adherence.json
autonomous: true
requirements: [REQ-007]
must_haves:
  truths:
    - "Reminder injection assertion passes: '[scope-check step 3/' + verbatim prompt snippet in recorded prompt"
    - "Soft-warn assertion passes at floor(ceiling × 0.7) step"
    - "Hard halt assertion: agentCalls.length ≤ ceiling+1 AND last_event toast matches /halted: step ceiling exceeded/"
    - "--budget-rounds N override branch: flag stripped before PIL, ceiling raised, override-active toast fired"
    - "complexitySize tag observable (via stderr OR via unit test on scoreComplexitySize)"
  artifacts:
    - path: tests/harness/scope-adherence-tui.spec.ts
      provides: "5 assertion categories per REQ-007"
    - path: tests/harness/fixtures/llm/scope-adherence.json
      provides: "Multi-round mock stream driving the orchestrator through K steps + ceiling"
  key_links:
    - from: tests/harness/scope-adherence-tui.spec.ts
      to: tests/harness/bash-output-get-tui.spec.ts
      via: "Copied template: PIL absorber round + exitTuiAndWaitForDump + loadDumpedRecordings"
      pattern: "exitTuiAndWaitForDump|loadDumpedRecordings"
---

<objective>
Harness E2E spec verifying all Phase 4 components end-to-end through real TUI process: reminder injection cadence, soft-warn, hard halt + forced-finalize toast, --budget-rounds override, complexitySize visibility. Template: `tests/harness/bash-output-get-tui.spec.ts`.

Purpose: Closes REQ-007. Automated regression guard for entire Phase 4.
Output: New spec file + mock fixture; all 5 assertion categories green.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md
@tests/harness/bash-output-get-tui.spec.ts
@tests/harness/cost-leak-tui-helpers.ts
@tests/harness/recording.ts
@vitest.harness.config.ts
@src/orchestrator/scope-ceiling.ts
@src/orchestrator/scope-reminder.ts
@src/pil/layer1_5-complexity-size.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Author mock fixture driving multi-step run to ceiling</name>
  <files>tests/harness/fixtures/llm/scope-adherence.json</files>
  <read_first>
    - tests/harness/bash-output-get-tui.spec.ts (existing fixture pattern reference)
    - tests/harness/fixtures/llm/ (look at other fixtures for sequence-mode structure)
    - src/orchestrator/scope-ceiling.ts (matrix — pick a known task_type×size pair for predictable ceiling)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (4V locked: 5 assertion categories)
  </read_first>
  <action>
    Create `tests/harness/fixtures/llm/scope-adherence.json`. Use a test prompt that classifies as `(taskType=debug, size=small)` → ceiling 6. This yields:
    - K (small) = 3 → reminder at step 3, 6
    - soft-warn at floor(6 × 0.7) = 4
    - hard halt at step 6 → forced-finalize round 7
    Plus a second scenario with `--budget-rounds 20 <prompt>` to drive override branch.

    Use sequence-mode (array of responses keyed by round). Each round returns either a tool_call (e.g., `bash_run` with a benign command) to advance steps, or final text. Round 7 is the forced-finalize response (text only).

    Mirror structure of `tests/harness/fixtures/llm/bash-output-get-tui.json` (or whichever fixture the template spec consumes).
  </action>
  <verify>
    <automated>node -e "JSON.parse(require('fs').readFileSync('tests/harness/fixtures/llm/scope-adherence.json','utf8'))"</automated>
  </verify>
  <done>Fixture parses as valid JSON; covers ≥7 mock rounds + override scenario.</done>
  <acceptance_criteria>
    - File exists at `tests/harness/fixtures/llm/scope-adherence.json`
    - `node -e "JSON.parse(require('fs').readFileSync('tests/harness/fixtures/llm/scope-adherence.json','utf8'))"` exits 0
    - File size > 500 bytes (non-trivial)
  </acceptance_criteria>
</task>

<task type="auto">
  <name>Task 2: Author scope-adherence-tui.spec.ts with all 5 assertion categories</name>
  <files>tests/harness/scope-adherence-tui.spec.ts</files>
  <read_first>
    - tests/harness/bash-output-get-tui.spec.ts (COPY VERBATIM as starting point per CONTEXT 4V lock)
    - tests/harness/cost-leak-tui-helpers.ts (spawnCostLeakHarness, exitTuiAndWaitForDump)
    - tests/harness/recording.ts (loadDumpedRecordings)
    - tests/harness/fixtures/llm/scope-adherence.json (Task 1 output)
  </read_first>
  <action>
    Create `tests/harness/scope-adherence-tui.spec.ts`. Structure:

    ```ts
    import { afterAll, beforeAll, describe, expect, it } from "vitest";
    import { spawnCostLeakHarness, exitTuiAndWaitForDump } from "./cost-leak-tui-helpers";
    import { loadDumpedRecordings } from "./recording";
    import { resolve } from "node:path";

    describe("scope-adherence: REQ-007 E2E", () => {
      // Use sessionId-bearing harness so 4R + 4B session state observable
      // Use fixture above so ceiling is deterministic (debug/small → 6)
      // Drive prompt through TUI, exit, load recordings.
      // Assert 5 categories below.
    });
    ```

    Assertion 1 (reminder injection):
      - Find a recorded LLM call at step >= 3
      - Last message content contains `"[scope-check step 3/"`
      - Last message content contains the first ~100 chars of the test prompt verbatim

    Assertion 2 (soft-warn):
      - At step === 4 (floor(6×0.7)), prompt contains `"approaching ceiling"` OR equivalent soft-warn marker

    Assertion 3 (hard halt + forced-finalize):
      - `agentCalls.length` ≤ 7 (ceiling 6 + final forced-finalize round)
      - `driver.last_event("toast")` matches `/halted: step ceiling exceeded for task_type=debug size=small at step 6\/6/`

    Assertion 4 (--budget-rounds override):
      - Second `it()` block runs prompt prefixed with `--budget-rounds 20 `
      - The prompt fed to PIL has the `--budget-rounds 20 ` segment stripped (assert via recorded PIL trace or system message inspection)
      - `last_event("toast")` includes `"override active: ceiling 20"` info-level

    Assertion 5 (complexitySize visible):
      - EITHER assert `MUONROI_DEBUG_SUBAGENT=1` stderr contains `complexitySize=` token,
      - OR fall back to an inline import-and-call unit assertion: `expect(scoreComplexitySize({rawText, taskType:"debug"}).size).toBe("small")`. Both paths are acceptable per CONTEXT.

    Use `describe.skipIf(process.platform === "win32")` only if existing template uses it; otherwise leave un-skipped (the harness supports Windows via named pipes).
  </action>
  <verify>
    <automated>bunx vitest -c vitest.harness.config.ts run tests/harness/scope-adherence-tui.spec.ts</automated>
  </verify>
  <done>All 5 assertion categories pass; spec runs natively on Windows (named pipes) and POSIX (fd 3/4).</done>
  <acceptance_criteria>
    - File `tests/harness/scope-adherence-tui.spec.ts` exists
    - `grep -E "\\[scope-check step 3/" tests/harness/scope-adherence-tui.spec.ts` returns ≥1 match
    - `grep -E "halted: step ceiling exceeded" tests/harness/scope-adherence-tui.spec.ts` returns ≥1 match
    - `grep -E "override active: ceiling 20" tests/harness/scope-adherence-tui.spec.ts` returns ≥1 match
    - `grep -E "approaching ceiling" tests/harness/scope-adherence-tui.spec.ts` returns ≥1 match
    - `grep -E "complexitySize|scoreComplexitySize" tests/harness/scope-adherence-tui.spec.ts` returns ≥1 match
    - `bunx vitest -c vitest.harness.config.ts run tests/harness/scope-adherence-tui.spec.ts` exits 0
  </acceptance_criteria>
</task>

<task type="auto">
  <name>Task 3: Final phase-level regression sweep + must_haves checklist</name>
  <files>(no edits — verification only)</files>
  <read_first>
    - All 7 plan SUMMARY files from this phase
    - .planning/ROADMAP.md (success criteria block)
  </read_first>
  <action>
    Run the full regression matrix and confirm Phase 4 goal-backward must_haves:

    1. `bunx tsc --noEmit` — 0 errors
    2. `bunx vitest run` — entire unit suite green (or no new regressions vs pre-Phase-4 baseline; document any pre-existing unrelated failures)
    3. `bunx vitest -c vitest.harness.config.ts run tests/harness/` — full harness suite green including new scope-adherence-tui.spec.ts
    4. Manual checklist against must_haves:
       - [ ] PIL 5-baseline classifier tests green (plans 01 + 06)
       - [ ] Session-scoped bash repeat test green (plan 03)
       - [ ] Ceiling matrix lookup tests green (plan 04)
       - [ ] Forced-finalize halt toast string verified (plan 04 + 07)
       - [ ] Reminder cadence + verbatim snippet verified (plan 05 + 07)
       - [ ] complexitySize observable via stderr or unit (plan 02 + 07)
       - [ ] No regression on registry-bash-footer.test.ts (plan 03 acceptance)
    5. User runs real 5-baseline re-run on DeepSeek V4 Flash. Pull telemetry: `sqlite3 ~/.muonroi-cli/muonroi.db` queries to confirm G1-G5 thresholds (cost ≤$0.30, tools ≤120, PIL 5/5, cache ≥15%, repeats=0).

    If step 5 fails any threshold, open a Phase 4 gap-closure task — do NOT amend plans retroactively.
  </action>
  <verify>
    <automated>bunx tsc --noEmit && bunx vitest -c vitest.harness.config.ts run tests/harness/</automated>
  </verify>
  <done>tsc clean; full harness suite green; user has telemetry numbers; G1-G5 thresholds met OR gap-closure task opened.</done>
  <acceptance_criteria>
    - `bunx tsc --noEmit` exits 0
    - `bunx vitest -c vitest.harness.config.ts run tests/harness/` exits 0
    - All 7 must_haves in this plan's frontmatter checked
  </acceptance_criteria>
</task>

</tasks>

<verification>
- Full unit suite + harness suite green
- 5 assertion categories of REQ-007 verified
- Manual real-baseline rerun confirms G1-G5
</verification>

<success_criteria>
- REQ-007 satisfied with grep-verifiable assertion markers
- Phase 4 done: all 7 REQs and goal-backward must_haves green
</success_criteria>

<output>
After completion, create `.planning/phases/04-scope-discipline-for-cheap-models/04-07-SUMMARY.md`

Also append phase-level retro stub to `.planning/RETROSPECTIVE.md` (or create) summarizing:
- 5-baseline re-run telemetry (G1-G5 numbers)
- Which plans landed cleanly vs needed iteration
- Patterns to carry into Phase 5
</output>
