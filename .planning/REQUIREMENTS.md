# Requirements — muonroi-cli Phase 4

**Source:** Locked from baseline analysis 2026-05-23. Goals G1-G5 derived from 5-prompt baseline (`33c09e970d30`, `a4c4bddc5ad9`, `bf1afff343a9`, `77cd2e11c6a5`, `3485a0934def`).

## REQ-001: Eliminate PIL refactor bias

**Status:** Complete (Plan 04-01 tree-sitter side `bc07709`; Plan 04-06 bridge classifier side `d1fafad`, `0fa4550`, 2026-05-23)

**Why:** 4/5 baseline prompts misclassified as `refactor` (1/5 correct). Root cause: `tree-sitter:typescript`/`tree-sitter:python` reasons → `refactor` taskType in `REASON_TO_TASK_TYPE` map (`src/pil/layer1-intent.ts:166-167`). Additionally, the LLM bridge classifier returns `refactor` too often for ambiguous prompts (confidence 0.75 trace observed).

**Acceptance:** Same 5 baseline prompts run after fix produce 5/5 correct `task_type` classifications. Specifically:
- Prompt 1 ("giải thích đoạn code…") → `analyze`
- Prompt 2 ("đổi default --max-tool-rounds…") → `generate`
- Prompt 3 ("tìm xem tại sao bash_output_get…") → `debug`
- Prompt 4 ("thêm flag --budget-tokens…") → `generate`
- Prompt 5 ("improve test coverage") → `analyze` OR ambiguous-with-narrow-ask

## REQ-002: Session-scoped bash canonical-repeat detector

**Why:** Session `77cd2e11c6a5` ran `grep -n "budgetToken" "src/ui/slash/ideal.ts"` **9 times with IDENTICAL args**. Existing detector in `registry.ts` (closure state `lastBashCanonical`) failed to fire across the session. Hypothesis: tool registry rebuilt per user turn (session had 9 askcards → 9 turns), resetting closure state.

**Acceptance:** Identical-canonical bash repeats across one SESSION = 0. Verified by SQL query on `tool_calls` table grouped by `(session_id, args_json)` having count > 1.

## REQ-003: Deterministic complexity-size classifier (Layer 1.5) — COMPLETE

**Status:** Complete (Plan 04-02, commits `f37f45f`, `ec4e4a0`, 2026-05-23)

**Why:** Foundation for REQ-004 (per-task-type step ceiling). No LLM call allowed — must be pure regex/heuristic.

**Acceptance:** New `src/pil/layer1_5-complexity-size.ts` exports `scoreComplexitySize({rawText, taskType}): {size: "small"|"medium"|"large", score, features}`. Wired into pipeline after Layer 1, writes `ctx.complexitySize`. Unit tests cover 5 baseline prompts mapping to expected sizes.

## REQ-004: Per-session step ceiling with forced-finalize — COMPLETE

**Status:** Complete (Plan 04-04, commits `4e7ad66`, `96cfd46`, `3178239`, 2026-05-23)

**Why:** Sessions 4 & 5 wandered to 371 and 259 tool calls. `--max-tool-rounds=100` is per-turn, not per-session (9 turns × 40 tools = 371). Need hard halt at task-appropriate threshold with graceful finalize.

**Acceptance:**
- New `src/orchestrator/scope-ceiling.ts` resolves ceiling from `(task_type × complexity_size)` matrix
- Matrix per Phase 4 design (analyze 5/10/15, debug 6/12/20, refactor 8/14/22, generate 10/18/30, plan 4/8/12, documentation 5/8/12, general 5/10/20)
- When ceiling reached: orchestrator makes one final LLM call with `tool_choice: "none"` to synthesize partial answer
- `--budget-rounds N` override parsed from prompt before PIL
- Emits `toast` event with halt reason
- Override-active toast when user defeats ceiling

## REQ-005: Scope reminder injection

**Why:** Re-anchor cheap models every K steps to original prompt. Surfaces "still on scope?" prompt structurally rather than relying on system-prompt rules that decay under attention.

**Acceptance:**
- New `src/orchestrator/scope-reminder.ts`
- Reminder injected into next tool_result every K steps where K = 3/5/8 for small/medium/large complexity
- Soft-warn one-shot at 70% of ceiling
- Reminder text ≤200 chars, includes verbatim first 100 chars of original prompt
- Total reminder cost <1.5% of session tokens

## REQ-006: Tune LLM bridge classifier prompt

**Status:** Complete (Plan 04-06, commits `d1fafad`, `0fa4550`, 2026-05-23)

**Why:** Beyond the tree-sitter map fix (REQ-001), the bridge classifier itself biases toward `refactor` for ambiguous prompts (observed 0.75 confidence on prompt 4). Need prompt rework so feature-add and trivial-edit prompts classify correctly.

**Acceptance:** Bridge classifier system prompt updated. Re-running the 5 baseline prompts through the classifier in isolation produces 5/5 correct labels.

## REQ-007: Harness E2E verification

**Why:** Every PIL/orchestrator change in Phase 4 needs an automated guard so regressions are caught immediately. Template: `tests/harness/bash-output-get-tui.spec.ts`.

**Acceptance:** New `tests/harness/scope-adherence-tui.spec.ts` asserts:
- Reminder appears at step K=3 with verbatim original-prompt snippet
- Soft-warn fires at 70% of ceiling
- Hard halt + forced-finalize toast at 100%
- `--budget-rounds N` override branch works
- `complexitySize=X` tag observable in trace

## Goals (cross-cutting acceptance — must hold across 5 baseline re-runs)

| ID | Metric | Baseline | Target |
|---|---|---|---|
| G1-Cost | Total cost across 5 prompts | $1.30 | ≤$0.30 (-77%) |
| G1-Tools | Total tool calls across 5 prompts | 676 | ≤120 (-82%) |
| G2-PIL | task_type classification correct | 1/5 | 5/5 |
| G3-Cache | bash_output_get / bash ratio when output ≥4K chars | 0.4-3.8% | ≥15% |
| G4-Repeat | Identical-canonical bash repeats per session | up to 9 | 0 |
| G5-Outcome | Functional output produced (manual review) | TBD | ≥4/5 acceptable |
