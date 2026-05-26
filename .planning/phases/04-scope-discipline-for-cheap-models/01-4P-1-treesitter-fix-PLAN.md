---
phase: 04-scope-discipline-for-cheap-models
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/pil/layer1-intent.ts
  - src/pil/layer1-intent.test.ts
autonomous: true
requirements: [REQ-001]
must_haves:
  truths:
    - "tree-sitter:typescript reason no longer forces taskType=refactor"
    - "tree-sitter:python reason no longer forces taskType=refactor"
    - "Real refactor prompts (e.g., 'rename helper X to Y') still classify as refactor via Pass 2 keyword fallback"
  artifacts:
    - path: src/pil/layer1-intent.ts
      provides: "REASON_TO_TASK_TYPE map with tree-sitter:* → undefined"
    - path: src/pil/layer1-intent.test.ts
      provides: "Regression test asserting tree-sitter alone no longer biases refactor"
  key_links:
    - from: src/pil/layer1-intent.ts (lines 166-167)
      to: Pass 2 keyword fallback (line ~217)
      via: "undefined mapping lets Pass 2 keyword decide"
      pattern: "tree-sitter:(typescript|python).*undefined"
---

<objective>
Fix PIL refactor bias root cause: `tree-sitter:typescript` and `tree-sitter:python` reasons currently map to `"refactor"` taskType in `REASON_TO_TASK_TYPE` (src/pil/layer1-intent.ts:166-167). Tree-sitter parsing alone carries no intent signal — only "this contains code". Change both mappings to `undefined` so Pass 2 keyword fallback (line ~217) decides.

Purpose: Eliminates 4/5 baseline misclassifications driven solely by code presence detection.
Output: Updated map + regression test proving refactor keyword path still works.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md
@src/pil/layer1-intent.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Flip tree-sitter:* mappings to undefined + add regression test</name>
  <files>src/pil/layer1-intent.ts, src/pil/layer1-intent.test.ts</files>
  <read_first>
    - src/pil/layer1-intent.ts (esp. lines 160-225 — REASON_TO_TASK_TYPE map + Pass 2 keyword fallback)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (4P-1 locked decisions)
  </read_first>
  <behavior>
    - Test A: A prompt with only tree-sitter:typescript reason and NO refactor keywords does NOT classify as refactor
    - Test B: A prompt like "rename helper function buildContext to buildContextV2 across the file" with tree-sitter:typescript reason STILL classifies as refactor via Pass 2 keyword match
    - Test C: The REASON_TO_TASK_TYPE map entries for tree-sitter:typescript and tree-sitter:python are undefined (or absent)
  </behavior>
  <action>
    In src/pil/layer1-intent.ts at the REASON_TO_TASK_TYPE map (lines 166-167), change:
      "tree-sitter:typescript": "refactor",
      "tree-sitter:python": "refactor",
    to either:
      "tree-sitter:typescript": undefined,
      "tree-sitter:python": undefined,
    OR remove the two keys entirely (whichever matches the existing type signature — read the type definition first).

    In src/pil/layer1-intent.test.ts, append three vitest cases per the <behavior> block. Use existing test scaffolding patterns in the file. Do NOT modify other tests.
  </action>
  <verify>
    <automated>bunx vitest run src/pil/layer1-intent.test.ts</automated>
  </verify>
  <done>Map entries flipped; new tests green; existing tests untouched and still green.</done>
  <acceptance_criteria>
    - `grep -E "tree-sitter:(typescript|python).*refactor" src/pil/layer1-intent.ts` returns NO matches
    - `grep -E "tree-sitter:(typescript|python)" src/pil/layer1-intent.ts` either returns 0 matches OR matches lines containing `undefined`
    - `bunx vitest run src/pil/layer1-intent.test.ts` exits 0
    - New test names contain "tree-sitter" and "refactor keyword"
  </acceptance_criteria>
</task>

</tasks>

<verification>
- `bunx tsc --noEmit` — 0 errors
- `bunx vitest run src/pil/layer1-intent.test.ts` — all green
</verification>

<success_criteria>
- REQ-001 partially satisfied (tree-sitter side; bridge classifier tuning handled by 4P-2)
- Regression test guards against future re-introduction
</success_criteria>

<output>
After completion, create `.planning/phases/04-scope-discipline-for-cheap-models/04-01-SUMMARY.md`
</output>
