---
phase: 04-scope-discipline-for-cheap-models
verified: 2026-05-23T23:42:00Z
status: human_needed
score: 7/7 must-haves verified (automated); G1-G5 baseline re-run requires human
re_verification: null
human_verification:
  - test: "Re-run 5 baseline DeepSeek V4 Flash prompts and pull telemetry from ~/.muonroi-cli/muonroi.db"
    expected: "G1-Cost ≤$0.30, G1-Tools ≤120, G2-PIL 5/5 correct task_type, G3-Cache ≥15%, G4-Repeat 0 identical-canonical bash repeats per session, G5-Outcome ≥4/5 acceptable"
    why_human: "Requires live DeepSeek API key, real model behavior, multi-minute sessions, and SQL/telemetry pull from local SQLite — not reproducible programmatically in <10s"
  - test: "Manually trigger /ideal scope-wander scenario with cheap model and observe halt toast + forced-finalize"
    expected: "Toast 'halted: step ceiling exceeded for task_type=X size=Y at step N/N' appears in TUI; final partial-answer text rendered after halt"
    why_human: "Visual TUI verification of toast level/text rendering and synthesized partial answer quality"
---

# Phase 4: Scope Discipline for Cheap Models — Verification Report

**Phase Goal:** Drive DeepSeek V4 Flash (and other fast-tier cheap models) through muonroi-cli so they emit zero tokens on scope-wandering while preserving output quality. Measured against 5 baseline sessions captured 2026-05-23.

**Verified:** 2026-05-23
**Status:** human_needed — All 7 components implemented, wired, tested green; final acceptance (G1-G5 metrics) requires a live 5-baseline DeepSeek re-run.
**Re-verification:** No — initial verification.

## Goal Achievement

### Observable Truths

| #   | Truth (from must_haves)                                                                                  | Status     | Evidence                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | PIL `tree-sitter:typescript`/`python` reasons mapped to `undefined`, letting Pass 2 keyword decide       | VERIFIED   | `src/pil/layer1-intent.ts:169-170` — both keys explicitly `undefined` with multi-line phase-4 rationale comment                                   |
| 2   | Deterministic Layer 1.5 complexity-size classifier wired into pipeline                                   | VERIFIED   | `src/pil/layer1_5-complexity-size.ts` exports `scoreComplexitySize`; `pipeline.ts:24,103,109,113-114` wires it after Layer 1, writes `ctx.complexitySize` + trace fields |
| 3   | Session-scoped bash canonical-repeat detector survives `createBuiltinTools()` rebuilds                   | VERIFIED   | `src/tools/registry.ts:32,61-69,166-203` — `globalThis.__muonroiBashRepeatState: Map<sessionId, BashRepeatEntry>` keyed by sessionId             |
| 4   | Scope-ceiling matrix + forced-finalize on ceiling hit                                                    | VERIFIED   | `src/orchestrator/scope-ceiling.ts:44-52` matrix matches locked spec exactly; `forcedFinalize()` uses `toolChoice:"none"` (line 181); halt toast wired at `message-processor.ts:1962` |
| 5   | Scope-reminder cadence K=3/5/8 + one-shot soft-warn at floor(ceiling × 0.7)                              | VERIFIED   | `src/orchestrator/scope-reminder.ts:35-39` cadence table; `shouldInjectSoftWarn` one-shot guard; `message-processor.ts:1380,1389` applies `[approaching ceiling]` prefix |
| 6   | LLM bridge classifier system prompt rewritten with neutral guidance + general fallback preference       | VERIFIED   | `src/pil/layer1-intent.ts:462-489` — new prompt lists categories in neutral order, restricts refactor to explicit restructure verbs, prefers `general` over guessing |
| 7   | Harness E2E spec covers all 5 assertion categories                                                       | VERIFIED   | `tests/harness/scope-adherence-tui.spec.ts` — Assertions 1 (live spawn reminder), 2 (soft-warn), 3 (hard halt wiring), 4 (override), 5 (complexitySize) |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact                                              | Expected                                                  | Status     | Details |
| ----------------------------------------------------- | --------------------------------------------------------- | ---------- | ------- |
| `src/pil/layer1-intent.ts`                            | tree-sitter mappings → undefined; bridge prompt rewrite   | VERIFIED   | Lines 169-170 (mapping), 462-489 (prompt) |
| `src/pil/layer1_5-complexity-size.ts`                 | Pure heuristic `scoreComplexitySize`                      | VERIFIED   | Full module with locked weights; substantive (>200 lines) |
| `src/pil/layer1_5-complexity-size.test.ts`            | Unit tests for 5 baseline prompts → expected sizes        | VERIFIED   | Test file present, runs green |
| `src/pil/pipeline.ts`                                 | Layer 1.5 wired after Layer 1                             | VERIFIED   | Imports + invokes scoreComplexitySize + writes trace |
| `src/pil/types.ts`                                    | `complexitySize` field on PipelineContext + trace         | VERIFIED   | Lines 9, 57, 59, 158, 160 |
| `src/orchestrator/scope-ceiling.ts`                   | Matrix, `resolveCeiling`, `parseBudgetOverride`, `forcedFinalize`, `incSessionStep` | VERIFIED | All exports present; matrix matches locked spec verbatim |
| `src/orchestrator/scope-ceiling.test.ts`              | Unit tests                                                | VERIFIED   | Runs green |
| `src/orchestrator/scope-reminder.ts`                  | `cadenceForSize`, `shouldInjectReminder`, `shouldInjectSoftWarn`, `buildScopeReminder` | VERIFIED | All exports present; ≤200 char invariant enforced |
| `src/orchestrator/scope-reminder.test.ts`             | Unit tests                                                | VERIFIED   | Runs green |
| `src/orchestrator/message-processor.ts`               | Top-level wiring: ceiling, reminder, soft-warn, halt toast, override toast | VERIFIED | Imports lines 147-157; logic at 425, 560, 571, 1379-1389, 1942-1962 |
| `src/orchestrator/stream-runner.ts`                   | Sub-agent loop mirror of 4A/4B integration                | VERIFIED   | Imports lines 73,79-81; logic at 483-530 |
| `src/tools/registry.ts`                               | Session-scoped bash repeat state                          | VERIFIED   | globalThis Map keyed by sessionId |
| `src/tools/registry-session-repeat.test.ts`           | New test: state survives across createBuiltinTools rebuilds | VERIFIED | Present + passing |
| `src/tools/registry-bash-footer.test.ts`              | Existing per-turn test still passes                       | VERIFIED   | Passing under new session-scoped impl |
| `src/pil/layer1-intent.test.ts`                       | 5 baseline classifier tests                               | VERIFIED   | Passing |
| `tests/harness/scope-adherence-tui.spec.ts`           | 5 assertion categories                                    | VERIFIED   | 4 non-spawn assertions PASS, 1 live-spawn skipped pending live LLM (acceptable per plan 07 decision log) |

### Key Link Verification

| From                                  | To                                       | Via                            | Status | Details |
| ------------------------------------- | ---------------------------------------- | ------------------------------ | ------ | ------- |
| `layer1-intent.ts:166-170`            | Pass 2 keyword fallback                  | `undefined` mapping            | WIRED  | Pass 2 KEYWORD_PATTERNS at line 189+ handle the case |
| `pipeline.ts`                         | `layer1_5-complexity-size.ts`            | `scoreComplexitySize` import + call | WIRED | Line 24 import, line 103 call, line 109 ctx write |
| `message-processor.ts`                | `scope-ceiling.ts`                       | `resolveCeiling`, `parseBudgetOverride`, `forcedFinalize` | WIRED | Lines 153-157 imports, lines 425/560/571/1942 calls |
| `message-processor.ts`                | `scope-reminder.ts`                      | `shouldInjectReminder`, `shouldInjectSoftWarn` | WIRED | Lines 147-150 imports, lines 1379-1389 calls |
| `stream-runner.ts`                    | `scope-ceiling.ts` + `scope-reminder.ts` | imports                         | WIRED  | Lines 73,79-81 imports, lines 483-530 sub-agent loop integration |
| `registry.ts`                         | `globalThis.__muonroiBashRepeatState`    | `Map<sessionId, BashRepeatEntry>` | WIRED | Lines 61-64 (state init), 169 (lookup) |
| `scope-ceiling.ts::forcedFinalize`    | LLM call with `toolChoice:"none"`        | streamText/generateText config  | WIRED  | Line 181 `toolChoice: "none"` |
| `scope-reminder.ts::buildScopeReminder` | Reminder string ≤200 chars             | Format template                 | WIRED  | Hard cap enforced via `SCOPE_REMINDER_MAX_CHARS = 200`; tested in harness spec |

### Data-Flow Trace (Level 4)

| Artifact                              | Data Variable                    | Source                                | Produces Real Data | Status |
| ------------------------------------- | -------------------------------- | ------------------------------------- | ------------------ | ------ |
| `pipeline.ts` ctx.complexitySize     | `sizeResult`                     | `scoreComplexitySize({rawText, taskType})` — pure heuristic | Yes (deterministic from prompt text) | FLOWING |
| `message-processor.ts` `_scopeStep`  | step counter                     | `incSessionStep(sessionId)` — globalThis Map | Yes (per-session counter persists across turns) | FLOWING |
| `message-processor.ts` halt toast    | toast event                      | emitted on `stopWhen` true via `toast` event kind | Yes (template string with live `_ceilingTaskType`/`_ceilingSize` interp) | FLOWING |
| `registry.ts` bash repeat reminder   | `lastBashCanonical`              | `globalThis.__muonroiBashRepeatState.get(sessionId)` | Yes (survives registry rebuild) | FLOWING |

### Behavioral Spot-Checks

| Behavior                                                | Command                                                                                                 | Result                            | Status |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------- | ------ |
| All Phase-4 unit suites green                           | `bunx vitest run src/pil/layer1_5-complexity-size.test.ts src/orchestrator/scope-ceiling.test.ts src/orchestrator/scope-reminder.test.ts src/tools/registry-session-repeat.test.ts src/tools/registry-bash-footer.test.ts src/pil/layer1-intent.test.ts` | 6 test files / 76 tests passed (5.52s) | PASS |
| Non-spawn harness assertions for scope-adherence pass   | `bunx vitest -c vitest.harness.config.ts run tests/harness/scope-adherence-tui.spec.ts -t "complexitySize\|soft-warn\|override\|hard halt"` | 4 passed / 1 skipped (live spawn) | PASS |
| Forced-finalize uses toolChoice:"none"                  | `grep "toolChoice" src/orchestrator/scope-ceiling.ts`                                                   | Line 181 `toolChoice: "none"`     | PASS |
| Ceiling matrix matches locked spec verbatim             | grep `CEILING_MATRIX` rows in `scope-ceiling.ts`                                                        | Exact match: analyze 5/10/15, debug 6/12/20, refactor 8/14/22, generate 10/18/30, plan 4/8/12, documentation 5/8/12, general 5/10/20 | PASS |
| Live-spawn harness assertion (reminder injection)       | full harness spec with live LLM                                                                          | Skipped (test contains `.skip` or requires real provider) | SKIP — see Plan 07 decision: documented split between unit-level proof and live-spawn smoke |

### Requirements Coverage

| Requirement | Source Plans      | Description                                            | Status                          | Evidence |
| ----------- | ----------------- | ------------------------------------------------------ | ------------------------------- | -------- |
| REQ-001     | 01, 06            | Eliminate PIL refactor bias (tree-sitter + bridge)     | SATISFIED                       | tree-sitter mappings undefined (Plan 01); bridge prompt rewritten neutral (Plan 06) |
| REQ-002     | 03                | Session-scoped bash canonical-repeat detector           | SATISFIED                       | globalThis-Map keyed by sessionId in registry.ts |
| REQ-003     | 02                | Deterministic complexity-size classifier (Layer 1.5)    | SATISFIED                       | scoreComplexitySize + pipeline wiring + tests |
| REQ-004     | 04                | Per-session step ceiling + forced-finalize              | SATISFIED                       | scope-ceiling.ts matrix + forcedFinalize + halt toast wired |
| REQ-005     | 05                | Scope reminder injection K=3/5/8 + soft-warn at 70%    | SATISFIED                       | scope-reminder.ts cadence + one-shot soft-warn + wiring in message-processor |
| REQ-006     | 06                | Tune LLM bridge classifier prompt                       | SATISFIED                       | New neutral prompt (layer1-intent.ts:462-489); 5-baseline test in layer1-intent.test.ts |
| REQ-007     | 07                | Harness E2E verification (5 assertion categories)       | SATISFIED (with documented split) | scope-adherence-tui.spec.ts; 4 non-spawn assertions PASS; 1 live-spawn assertion documented per Plan 07 decision log as "hybrid spec strategy" |

No orphaned requirements — REQ-001..REQ-007 each map cleanly to one or more plans, every plan declared its requirements in frontmatter.

### Anti-Patterns Found

| File                                          | Line   | Pattern                            | Severity | Impact |
| --------------------------------------------- | ------ | ---------------------------------- | -------- | ------ |
| `message-processor.ts`                        | 425, 560 | `_budgetOverride`, `_naturalCeiling` (underscore-prefixed locals) | Info | Convention used to mark phase-4 additions; no functional issue |
| `tests/harness/scope-adherence-tui.spec.ts`  | live-spawn block | Live-spawn assertion gated behind real-provider availability | Info | Documented in Plan 07 SUMMARY as hybrid strategy; non-spawn assertions provide deterministic regression guard |

No blocker patterns. No empty stubs detected. No hardcoded model/provider IDs in scope-ceiling.ts / scope-reminder.ts (Zero Hardcode Rule honored — forcedFinalize receives model from caller).

### Human Verification Required

#### 1. Final acceptance — 5-baseline DeepSeek re-run

**Test:** Re-run the 5 baseline prompts (from REQUIREMENTS.md "Baseline session evidence" table) against DeepSeek V4 Flash with Phase 4 ON, pull telemetry from `~/.muonroi-cli/muonroi.db`:

```sql
SELECT session_id, COUNT(*) AS tool_calls, SUM(cost_usd) AS cost FROM tool_calls GROUP BY session_id;
SELECT session_id, args_json, COUNT(*) FROM tool_calls WHERE tool_name = 'bash' GROUP BY session_id, args_json HAVING COUNT(*) > 1;
SELECT session_id, metadata FROM interaction_logs WHERE metadata LIKE '%taskType%';
```

**Expected:**
- G1-Cost: total ≤ $0.30 (baseline $1.30 → -77% target)
- G1-Tools: total ≤ 120 (baseline 676 → -82% target)
- G2-PIL: 5/5 correct `task_type` per REQ-001 acceptance
- G3-Cache: `bash_output_get / bash` ratio ≥ 15% when output ≥ 4K chars
- G4-Repeat: 0 rows in the duplicate-args_json query above
- G5-Outcome: ≥ 4/5 prompts produce manually-acceptable functional output

**Why human:** Live API key, multi-minute sessions, and qualitative outcome review are not automatable within phase-verification budget.

#### 2. Visual TUI halt + forced-finalize observation

**Test:** Trigger a `/ideal` session with `--budget-rounds 3` (artificially low) and prompt the model to do something tool-heavy. Watch the TUI.

**Expected:** After step 3, the agent loop halts; toast `"halted: step ceiling exceeded for task_type=X size=Y at step 3/3"` renders; a final partial-answer message appears (forced-finalize output).

**Why human:** Visual TUI rendering, toast level/style, and partial-answer text quality require human observation.

### Gaps Summary

No automated gaps. The phase delivers all 7 must-haves with substantive code, wired into both orchestrator loops (top-level + sub-agent), guarded by 76 passing unit tests and a 5-assertion harness spec (4 deterministic + 1 live-spawn). The locked Phase-4 CONTEXT.md acceptance criterion "Final acceptance = real 5-baseline re-run on DeepSeek V4 Flash with telemetry pulled from `~/.muonroi-cli/muonroi.db`" is the only remaining bar and it is explicitly a human-driven check (live provider, multi-minute wall, manual G5 outcome scoring).

The single live-spawn harness assertion (Assertion 1, reminder marker visible in recorded LLM prompt) is documented in Plan 07 SUMMARY as a deliberate hybrid strategy — the deterministic 4 assertions PLUS unit tests for `buildScopeReminder` / `shouldInjectReminder` provide stronger regression coverage than a flaky spawn-based reminder grep.

---

_Verified: 2026-05-23T23:42:00Z_
_Verifier: Claude (gsd-verifier)_
