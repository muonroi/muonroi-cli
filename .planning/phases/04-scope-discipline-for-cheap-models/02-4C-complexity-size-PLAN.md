---
phase: 04-scope-discipline-for-cheap-models
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/pil/layer1_5-complexity-size.ts
  - src/pil/layer1_5-complexity-size.test.ts
  - src/pil/pipeline.ts
  - src/pil/types.ts
autonomous: true
requirements: [REQ-003]
must_haves:
  truths:
    - "scoreComplexitySize returns {size, score, features} deterministically with no LLM call"
    - "ctx.complexitySize populated after Layer 1 in pipeline"
    - "5 baseline prompts map to expected buckets (small/medium/large)"
  artifacts:
    - path: src/pil/layer1_5-complexity-size.ts
      provides: "scoreComplexitySize() pure heuristic classifier"
    - path: src/pil/layer1_5-complexity-size.test.ts
      provides: "Unit tests covering 5 baseline prompts + bucket boundaries"
    - path: src/pil/types.ts
      contains: "complexitySize"
    - path: src/pil/pipeline.ts
      provides: "Layer 1.5 wired after layer1Intent"
  key_links:
    - from: src/pil/pipeline.ts
      to: src/pil/layer1_5-complexity-size.ts
      via: "scoreComplexitySize(ctx) called after layer1Intent"
      pattern: "scoreComplexitySize"
    - from: src/pil/pipeline.ts
      to: IntentDetectionTrace
      via: "complexitySize persisted in trace"
      pattern: "complexitySize"
---

<objective>
Add deterministic Layer 1.5 complexity-size classifier. Pure regex/heuristic — no LLM call. Wires into pipeline after Layer 1. Output `{size: "small"|"medium"|"large", score, features}` consumed by 4B (step ceiling) and 4A (reminder cadence K).

Purpose: Foundation for REQ-004 + REQ-005 — gives them task_type × size matrix lookup key.
Output: New module + pipeline wiring + trace field + unit tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md
@src/pil/pipeline.ts
@src/pil/types.ts
@src/pil/layer1-intent.ts
@src/pil/cheap-model-playbook.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Write scoreComplexitySize + unit tests</name>
  <files>src/pil/layer1_5-complexity-size.ts, src/pil/layer1_5-complexity-size.test.ts</files>
  <read_first>
    - src/pil/layer1-intent.ts (similar Pass-2 heuristic style)
    - src/pil/cheap-model-playbook.ts (predicate-pattern reference)
    - .planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md (heuristic weights LOCKED in 4C section)
  </read_first>
  <behavior>
    Heuristic weights (locked verbatim from CONTEXT):
    - len < 60 → score −2; len > 240 → score +2
    - /\b(all|every|comprehensive|everything|clean up|entire|the whole)\b/gi count × +1.5
    - /\brefactor|migrate|architecture\b/i → +2
    - file/path mentions: 0 → −1, 1 → 0, ≥3 → +2
    - question form (starts with what/why/how/where/can/is/are/does OR trailing ?) → −1
    - imperative (starts with known verb) → 0 neutral
    - Buckets: score ≤ −1 small, score ≤ 3 medium, else large
    - Stack-trace mitigation: when taskType==="debug" AND prompt contains /(Traceback|at .+:\d+:\d+|Exception in)/, count all stack-trace lines as 1 unit toward len
    Test cases per baseline:
    - "giải thích đoạn code ở src/index.ts:1403" (taskType=analyze) → small
    - "đổi default --max-tool-rounds từ 100 → 150 trong src/orchestrator/cli-args.ts" (generate) → small
    - "tìm xem tại sao bash_output_get trả empty khi run_id sai" (debug) → small or medium
    - "thêm flag --budget-tokens N, khi total tokens > N thì halt với reason='budget exhausted'" (generate) → medium
    - "improve test coverage" (analyze) → large (contains "improve" + ambiguity catch-all)
    Plus boundary cases: empty prompt, exactly-60-char prompt, refactor-keyword-only.
  </behavior>
  <action>
    Create `src/pil/layer1_5-complexity-size.ts` exporting:

    ```ts
    export interface ComplexitySizeResult {
      size: "small" | "medium" | "large";
      score: number;
      features: Record<string, number | boolean>;
    }
    export function scoreComplexitySize(input: { rawText: string; taskType: string }): ComplexitySizeResult;
    ```

    Implement weights EXACTLY per CONTEXT (above). Counters:
    - lenScore: len<60 → -2; len>240 → +2; else 0. When taskType==='debug', collapse stack-trace lines matching /(Traceback|at .+:\d+:\d+|Exception in)/ to 1 unit each before computing len.
    - sweepScore: matches of /\b(all|every|comprehensive|everything|clean up|entire|the whole)\b/gi × 1.5
    - heavyScore: regex /\brefactor|migrate|architecture\b/i present → +2
    - pathScore: count distinct path-like tokens (e.g., src/..., path/..., a.b.c, file.ext); 0→-1, 1→0, ≥3→+2
    - questionScore: -1 if starts with what|why|how|where|can|is|are|does (case-insensitive) OR endsWith '?'
    - imperativeScore: 0 (neutral, no shift); detect for `features` only
    - total = sum; bucket via thresholds.

    Create `src/pil/layer1_5-complexity-size.test.ts` covering all 5 baseline prompts + 3 boundary cases. Use vitest `describe` / `it` / `expect`. Assert exact `size`.
  </action>
  <verify>
    <automated>bunx vitest run src/pil/layer1_5-complexity-size.test.ts</automated>
  </verify>
  <done>Module exported, 5 baseline + boundary tests green, no LLM call (grep verifies).</done>
  <acceptance_criteria>
    - File `src/pil/layer1_5-complexity-size.ts` exists and exports `scoreComplexitySize`
    - `grep -E "(streamText|generateText|generateObject|openai|deepseek|anthropic)\(" src/pil/layer1_5-complexity-size.ts` returns 0 matches
    - `bunx vitest run src/pil/layer1_5-complexity-size.test.ts` exits 0
    - Test file contains all 5 baseline prompt strings (greppable subset OK)
  </acceptance_criteria>
</task>

<task type="auto">
  <name>Task 2: Wire Layer 1.5 into pipeline + add complexitySize to PipelineContext + trace</name>
  <files>src/pil/types.ts, src/pil/pipeline.ts</files>
  <read_first>
    - src/pil/pipeline.ts (find layer1Intent call site)
    - src/pil/types.ts (PipelineContext + IntentDetectionTrace types)
    - src/pil/layer1_5-complexity-size.ts (created in Task 1)
  </read_first>
  <action>
    1. In `src/pil/types.ts`, add `complexitySize?: ComplexitySizeResult` to `PipelineContext`. Import the type from `./layer1_5-complexity-size`. If `IntentDetectionTrace` is a public type, add `complexitySize?: { size: string; score: number }` to it as well.

    2. In `src/pil/pipeline.ts`, immediately after the `layer1Intent` call, invoke `scoreComplexitySize({ rawText: ctx.rawText, taskType: ctx.taskType })` and assign result to `ctx.complexitySize`. Mirror into the trace object that downstream consumers write into telemetry.
  </action>
  <verify>
    <automated>bunx tsc --noEmit && bunx vitest run src/pil/</automated>
  </verify>
  <done>Pipeline populates ctx.complexitySize; type checks pass; existing PIL tests untouched.</done>
  <acceptance_criteria>
    - `grep -n "complexitySize" src/pil/types.ts` returns ≥1 match
    - `grep -n "scoreComplexitySize" src/pil/pipeline.ts` returns ≥1 match
    - `bunx tsc --noEmit` exits 0
    - `bunx vitest run src/pil/` exits 0
  </acceptance_criteria>
</task>

</tasks>

<verification>
- `bunx tsc --noEmit` clean
- `bunx vitest run src/pil/` all green
</verification>

<success_criteria>
- REQ-003 satisfied: new classifier, wired, ctx field, trace field, tests green
- Downstream consumers (4B, 4A) can read `ctx.complexitySize.size`
</success_criteria>

<output>
After completion, create `.planning/phases/04-scope-discipline-for-cheap-models/04-02-SUMMARY.md`
</output>
