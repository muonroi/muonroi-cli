---
phase: 04-scope-discipline-for-cheap-models
plan: 06
type: execute
wave: 3
depends_on: [01]
files_modified:
  - src/pil/layer1-intent.ts
  - src/pil/layer1-intent.test.ts
autonomous: true
requirements: [REQ-001, REQ-006]
must_haves:
  truths:
    - "LLM bridge classifier system prompt no longer biases ambiguous prompts toward refactor"
    - "Re-running 5 baseline prompts through bridge classifier in isolation produces 5/5 correct labels"
    - "Confidence threshold 0.7 for Pass 2 keyword override remains unchanged"
  artifacts:
    - path: src/pil/layer1-intent.ts
      provides: "Updated bridge classifier system prompt with neutral guidance + general fallback preference"
    - path: src/pil/layer1-intent.test.ts
      provides: "5 baseline prompt classifier tests"
  key_links:
    - from: src/pil/layer1-intent.ts
      to: bridge classifier /api/pil-context unified call
      via: "system prompt text"
      pattern: "(?i)general|catch-all|prefer general"
---

<objective>
Tune the LLM bridge classifier system prompt to remove refactor bias. Baseline trace `taskType=refactor,kind=task,conf=0.75` for a feature-add prompt confirms the LLM itself is over-confident on refactor for ambiguous inputs. Replace biased phrasing with neutral classification guidance that prefers the catch-all `general` over guessing.

Purpose: Closes REQ-006 + completes REQ-001 (tree-sitter side already done in Plan 01).
Output: Updated system prompt + 5-baseline isolated classifier tests.
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
  <name>Task 1: Rewrite bridge classifier system prompt + add 5-baseline tests</name>
  <files>src/pil/layer1-intent.ts, src/pil/layer1-intent.test.ts</files>
  <read_first>
    - src/pil/layer1-intent.ts (find the system prompt template feeding the /api/pil-context unified call — search for `taskType` enum strings and surrounding instruction text)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (4P-2 locked: keep threshold 0.7; prefer general over guessing)
  </read_first>
  <behavior>
    Baseline prompts must classify correctly when ONLY the bridge classifier runs:
    - "giải thích đoạn code ở src/index.ts:1403" → analyze
    - "đổi default --max-tool-rounds từ 100 → 150 trong src/orchestrator/cli-args.ts" → generate
    - "tìm xem tại sao bash_output_get trả empty khi run_id sai" → debug
    - "thêm flag --budget-tokens N, khi total tokens > N thì halt với reason='budget exhausted'" → generate
    - "improve test coverage" → analyze OR general (ambiguous, both accepted)
    Anti-bias check: a prompt with no explicit refactor verbs (rename, restructure, migrate, refactor) MUST NOT receive taskType="refactor" with confidence ≥0.7.
  </behavior>
  <action>
    1. Locate the bridge classifier system prompt in `src/pil/layer1-intent.ts`. Identify any text that:
       - Treats "code change" as default-refactor
       - Lists refactor BEFORE other categories in enum order without neutral framing
       - Lacks an explicit "when uncertain, return general" rule
       - Implies code presence ⇒ refactor

    2. Replace with neutral guidance (English). Required additions to the prompt:
       - Explicit list of task types in NEUTRAL order: analyze, debug, generate, refactor, plan, documentation, general
       - One sentence: "Only return refactor when the user explicitly asks to restructure, rename, migrate, or reshape EXISTING code without adding new behavior."
       - One sentence: "When the request is ambiguous, prefer 'general' over guessing."
       - One sentence: "Feature additions ('add flag', 'thêm', 'create endpoint') are 'generate' even when they touch existing files."

    3. Do NOT lower the 0.7 confidence threshold used by Pass 2 keyword fallback (locked per CONTEXT). Confirm by grep that the threshold constant is unchanged.

    4. In `src/pil/layer1-intent.test.ts`, add a `describe("bridge classifier — 5 baseline prompts")` block with one test per baseline. Mock the LLM call (use existing mock pattern in the file or `installMockModel` from `src/agent-harness/mock-model.ts`) so tests run offline; assert returned `taskType` matches the expected value. For ambiguous prompt 5, accept either analyze or general.
  </action>
  <verify>
    <automated>bunx vitest run src/pil/layer1-intent.test.ts</automated>
  </verify>
  <done>System prompt rewritten with required sentences; 5 baseline tests green; 0.7 threshold preserved.</done>
  <acceptance_criteria>
    - `grep -E "prefer 'general'|when uncertain|when ambiguous" src/pil/layer1-intent.ts` returns ≥1 match
    - `grep -E "Only return refactor when" src/pil/layer1-intent.ts` returns ≥1 match
    - `grep -E "0\\.7" src/pil/layer1-intent.ts` still returns ≥1 match (threshold preserved)
    - `bunx vitest run src/pil/layer1-intent.test.ts` exits 0
    - Test file contains all 5 baseline prompt strings
  </acceptance_criteria>
</task>

</tasks>

<verification>
- `bunx tsc --noEmit` clean
- Layer 1 tests all green (including new 5-baseline block)
</verification>

<success_criteria>
- REQ-001 + REQ-006 both satisfied
- G2-PIL ≥ 5/5 achievable in real 5-baseline rerun
</success_criteria>

<output>
After completion, create `.planning/phases/04-scope-discipline-for-cheap-models/04-06-SUMMARY.md`
</output>
