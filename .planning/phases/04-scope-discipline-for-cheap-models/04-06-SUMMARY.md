---
phase: 04-scope-discipline-for-cheap-models
plan: 06-4P-2-bridge-classifier
subsystem: pil/layer1-intent
tags: [pil, classifier, refactor-bias, bridge-classifier, scope-discipline]
requires:
  - "Plan 01 (tree-sitter REASON_TO_TASK_TYPE fix)"
provides:
  - "Neutral bridge classifier system prompt — no longer biases ambiguous prompts toward refactor"
  - "5 baseline prompt regression tests pinned into the suite"
  - "Pass 3 parser accepts 'general' alongside legacy 'none'"
affects:
  - "PIL Layer 1 Pass 3 legacy brain classification path (used when isUnifiedPilEnabled=false)"
tech-stack:
  added: []
  patterns:
    - "Prompt-text assertions via mocked classifyViaBrain.mock.calls to guard prompt content"
    - "Neutral category enumeration + explicit refactor restriction sentence"
key-files:
  created: []
  modified:
    - src/pil/layer1-intent.ts
    - src/pil/layer1-intent.test.ts
decisions:
  - "Listed analyze first (not refactor) in the prompt category enumeration — directly counteracts the LLM's prior refactor bias"
  - "Kept 'none' as legacy alias for chitchat alongside the new 'general' label so older brain caches stay valid"
  - "Did not lower HIGH_CONF_THRESHOLD_PASS2 (0.7) — locked by CONTEXT.md"
metrics:
  duration_min: 8
  completed_date: 2026-05-23
  tasks: 1
  files_modified: 2
requirements:
  - REQ-001 (fully satisfied — tree-sitter side in 04-01, bridge classifier tuning here)
  - REQ-006 (fully satisfied — refactor bias removed)
---

# Phase 4 Plan 06 (4P-2 Bridge Classifier) Summary

Tuned the legacy bridge-classifier system prompt in PIL Layer 1 Pass 3 to remove refactor bias and prefer the catch-all `general` over guessing on ambiguous inputs.

## What changed

`src/pil/layer1-intent.ts` — the legacy multilingual classifier prompt passed to `classifyViaBrain` was rewritten:

1. **Neutral category order** — categories now listed as `analyze, debug, generate, refactor, plan, documentation, general` (analyze first; refactor no longer leads the list).
2. **Explicit refactor restriction** — added the sentence `Only return refactor when the user explicitly asks to restructure, rename, migrate, or reshape EXISTING code without adding new behavior.`
3. **Ambiguity rule** — added `When the request is ambiguous, prefer 'general' over guessing.`
4. **Feature-add clarification** — added `Feature additions ('add flag', 'thêm', 'create endpoint') are 'generate' even when they touch existing files.`
5. **Parser update** — the Pass 3 reply matcher now recognises the new `general` label (in addition to the legacy `none` alias) and short-circuits BEFORE the coding-category substring scan, so a model reply like `general,balanced` doesn't accidentally hit a substring match later in the line.

The 0.7 confidence threshold (`HIGH_CONF_THRESHOLD_PASS2`) used by Pass 2 keyword override is unchanged — confirmed by grep against `0\.7` returning ≥1 match.

`src/pil/layer1-intent.test.ts` — added two new `describe` blocks:

- **`4P-2: bridge classifier system prompt — neutral guidance`** (4 tests) — asserts the prompt text passed to `classifyViaBrain` contains the new neutral order, refactor restriction sentence, ambiguity rule, and feature-add clarification.
- **`4P-2: bridge classifier — 5 baseline prompts produce correct labels`** (5 tests) — pins the five Phase 4 baseline prompts (VN explain, VN edit default, VN debug, VN feature-add, EN ambiguous) as regression cases. Each test mocks `classifyViaBrain` with the expected label and asserts the resulting `taskType` propagates correctly through the pipeline. Baseline 5 ("improve test coverage") accepts either `analyze` or `general` per the plan's ambiguous-prompt allowance.

## Verification

- `bunx vitest run src/pil/layer1-intent.test.ts` — 22/22 passed (13 pre-existing + 9 new).
- `bunx tsc --noEmit` — 0 errors on touched files (`src/pil/layer1-intent.ts`).
- Acceptance criteria from PLAN:
  - `grep -E "prefer 'general'|when uncertain|when ambiguous" src/pil/layer1-intent.ts` → 2 matches ✓
  - `grep -E "Only return refactor when" src/pil/layer1-intent.ts` → 1 match ✓
  - `grep -E "0\.7" src/pil/layer1-intent.ts` → 9 matches (threshold preserved) ✓
  - Test file contains all 5 baseline prompt strings ✓

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pass 3 parser missing 'general' branch**

- **Found during:** Task 1 GREEN phase
- **Issue:** The new prompt instructs the model to reply with `general,<style>` for ambiguous prompts, but `VALID_TASK_TYPES` (line 239) does NOT include `"general"`, and the existing `else if (/\bnone\b/.test(lower))` branch only matched the legacy keyword. A reply like `general,balanced` would fail both checks and leave `taskType=null`, which would then fall through to Pass 4 LLM fallback — wasting the round-trip the brain already burned.
- **Fix:** Added `/\bgeneral\b/` to the chitchat-mapping branch and reordered the matcher so the general/none check runs BEFORE the substring scan over coding categories. Prevents `general` from accidentally matching a category that happens to share a substring.
- **Files modified:** `src/pil/layer1-intent.ts` (Pass 3 parser block, ~lines 492-510)
- **Commit:** `0fa4550`

## Deferred Issues

None. Pre-existing TS errors outside `src/pil/` remain (documented in 04-01 SUMMARY) and are unrelated to this plan.

## Commits

- `d1fafad` — test(04-06): add failing tests for bridge classifier neutral prompt + 5 baselines (RED)
- `0fa4550` — feat(04-06): tune bridge classifier prompt to remove refactor bias (GREEN)

## Self-Check: PASSED

- File `src/pil/layer1-intent.ts` — FOUND (modified)
- File `src/pil/layer1-intent.test.ts` — FOUND (modified)
- Commit `d1fafad` — FOUND in git log
- Commit `0fa4550` — FOUND in git log
- Tests green: 22/22
- Acceptance criteria: all satisfied
- REQ-001 + REQ-006: both satisfied
