# Phase 4: Scope Discipline for Cheap Models — Context

**Gathered:** 2026-05-23
**Status:** Ready for planning
**Source:** Locked from baseline analysis (5 sessions, 3 research agents A/B/C, root-cause confirms R1-R3)

<domain>
## Phase Boundary

This phase delivers the structural CLI mechanisms that prevent fast-tier cheap models (DeepSeek V4 Flash and equivalents) from wandering scope. The kim chỉ nam (north star): **zero wasted tokens on scope wandering, output quality per emitted token must stay ≥ current**.

In scope:
- PIL Layer 1 fixes (refactor bias)
- PIL Layer 1.5 new (deterministic complexity-size classifier)
- Orchestrator step ceiling + forced-finalize
- Orchestrator scope-reminder injection
- Tool registry: session-scoped bash canonical-repeat detector
- LLM bridge classifier prompt tune
- Harness E2E spec for the above

Out of scope (deferred):
- File-scope quarantine (Aider-style)
- EE `IRRELEVANT` 100% noise reduction
- Capability-scoped subagents per role

</domain>

<decisions>
## Implementation Decisions (locked)

### PIL refactor bias fix (4P-1)
- **Locked**: In `src/pil/layer1-intent.ts:166-167`, change `tree-sitter:typescript` and `tree-sitter:python` mappings from `"refactor"` to `undefined`. Let Pass 2 keyword fallback decide. Pure null/undefined is preferred over a different positive default because tree-sitter parsing alone carries no intent signal — only "this contains code".
- **Locked**: A refactor unit test must verify a real refactor prompt (e.g., "rename helper function X to Y across the file") still classifies as refactor via the keyword pattern at line 217.

### LLM bridge classifier tune (4P-2)
- **Locked**: Read the current bridge system prompt first (in `src/pil/layer1-intent.ts` around the `/api/pil-context` unified call). Identify phrases that bias toward "refactor" for ambiguous prompts. Replace with neutral classification guidance that prefers the catch-all `general` over guessing.
- **Locked**: Bridge classifier confidence threshold for Pass 2 keyword override remains 0.7 (do not lower).

### Layer 1.5 complexity-size (4C)
- **Locked**: New file `src/pil/layer1_5-complexity-size.ts`. Pure function `scoreComplexitySize({rawText, taskType}): {size, score, features}`. No LLM call.
- **Locked**: Heuristic weights:
  - `len < 60` → −2; `len > 240` → +2
  - `/\b(all|every|comprehensive|everything|clean up|entire|the whole)\b/gi` count × +1.5
  - `/\brefactor|migrate|architecture\b/i` → +2
  - file/path mentions: 0 → −1, 1 → 0, ≥3 → +2
  - question form (starts with `what/why/how/where/can/is/are/does` OR trailing `?`) → −1
  - imperative (starts with known verb) → 0 neutral
  - Buckets: ≤−1 small, ≤3 medium, else large
- **Locked**: Stack-trace mitigation — if `taskType==="debug"` AND prompt contains `/(Traceback|at .+:\d+:\d+|Exception in)/`, count all stack-trace lines as 1 unit toward `len`.
- **Locked**: Wire into `src/pil/pipeline.ts` after `layer1Intent`. Add `complexitySize` field to `PipelineContext` in `src/pil/types.ts`. Persist into `IntentDetectionTrace` for forensics.

### Step ceiling + forced-finalize (4B)
- **Locked**: Ceiling matrix per `(task_type × size)`:
  | task_type | small | medium | large |
  |---|---|---|---|
  | analyze | 5 | 10 | 15 |
  | debug | 6 | 12 | 20 |
  | refactor | 8 | 14 | 22 |
  | generate | 10 | 18 | 30 |
  | plan | 4 | 8 | 12 |
  | documentation | 5 | 8 | 12 |
  | general | 5 | 10 | 20 |
- **Locked**: Soft warning at `Math.floor(ceiling × 0.7)` injected once as reminder preamble (handoff to 4A).
- **Locked**: Hard halt at ceiling — `stopWhen` returns true.
- **Locked**: Override via `--budget-rounds N` parsed off the raw prompt by `parseBudgetOverride()` BEFORE PIL classifies. Override emits info-level toast `"override active: ceiling N, default was M (task=X/size=Y)"`.
- **Locked**: On halt, orchestrator makes ONE final LLM call with `tool_choice: "none"` to synthesize a partial answer from accumulated context. Emit `toast` event `{level: "warn", text: "halted: step ceiling exceeded for task_type=X size=Y at step N/N"}`.
- **Locked**: Per-SESSION counter (not per-turn). Persists across multiple user turns within the same session.

### Scope reminder (4A)
- **Locked**: New file `src/orchestrator/scope-reminder.ts`. Cadence K: 3 for small, 5 for medium, 8 for large.
- **Locked**: Hard floor K ≥ 3.
- **Locked**: Format ≤200 chars:
  ```
  [scope-check step N/CEILING — task=TASKTYPE size=SIZE]
  original: "PROMPT_SNIPPET (first 100 chars)"
  still on scope? if no → emit final answer; if yes → continue.
  ```
- **Locked**: Inject into the tool_result rewriting layer alongside existing B3/B4 compactor + cross-turn dedup. Prefer attachment to the latest tool message; fallback to a `system`-role injection at the end of the messages array if the latest step is text-only.
- **Locked**: Reminder must NOT live in system prompt (would be stripped by compaction at high step counts).

### Session-scoped bash repeat detector (4R)
- **Locked**: Existing closure state `lastBashCanonical` / `lastBashRunId` in `src/tools/registry.ts` (lines ~118-119) is per-`createBuiltinTools()` call. Lift to **session-scoped state** keyed by `runId` / session id.
- **Locked**: Store in `globalThis.__muonroiBashRepeatState: Map<sessionId, {lastCanonical, lastRunId}>` OR pass via session context. Choose whichever has fewer cross-module ripples — decide while reading the actual registry construction code path.
- **Locked**: Existing reminder string format preserved. Reminder fires when `canonical === lastCanonical && lastRunId != null` for the same session, regardless of how many user turns / askcards have passed.
- **Locked**: Existing unit test in `src/tools/registry-bash-footer.test.ts` must still pass after refactor.

### Harness E2E spec (4V)
- **Locked**: New file `tests/harness/scope-adherence-tui.spec.ts`. Template: copy `tests/harness/bash-output-get-tui.spec.ts` verbatim (PIL Layer 1 absorber round, multi-round mock stream, `exitTuiAndWaitForDump`, `loadDumpedRecordings`).
- **Locked**: Assertions:
  1. Reminder injection — after K=3 steps, prompt contains `"[scope-check step 3/"` AND verbatim original-prompt snippet
  2. Soft-warn — at `floor(ceiling × 0.7)`, prompt contains `"approaching ceiling"` or soft-warn marker
  3. Hard halt — `agentCalls.length` ≤ ceiling+1 (final close round); `last_event("toast")` matches `/halted: step ceiling exceeded/`
  4. Override — `--budget-rounds 20 <prompt>` cleans the flag before PIL sees prompt, ceiling rises to 20, info toast `"override active"` fires
  5. complexitySize tag observable via `MUONROI_DEBUG_SUBAGENT=1` stderr OR via a dedicated unit test on `scoreComplexitySize`

### Test discipline
- **Locked**: Each component lands with unit/integration tests in the SAME PR. No "tests later" PRs.
- **Locked**: Final acceptance = real 5-baseline re-run on DeepSeek V4 Flash with telemetry pulled from `~/.muonroi-cli/muonroi.db`.

### Claude's Discretion (within locked boundaries)

- Exact function signatures (only the public exports listed in REQ-XXX are mandatory)
- Whether `globalThis.__muonroiBashRepeatState` vs threading through `RuntimeContext` for 4R — pick the lower-ripple option after reading the code
- Exact format of harness mock LLM rounds for the spec — copy `bash-output-get-tui.spec.ts` structure
- Whether to bundle the cross-cutting reminder feature inside `subagent-compactor.ts` or add a new pass — choose whatever produces fewer wrapper layers

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### PIL architecture
- `src/pil/layer1-intent.ts` — Source of refactor bias bug (lines 166-167 + bridge classifier)
- `src/pil/pipeline.ts` — Where Layer 1.5 hooks in (after `layer1Intent`)
- `src/pil/types.ts` — Add `complexitySize` field to `PipelineContext`
- `src/pil/cheap-model-playbook.ts` — Reference for `shouldInjectCheapModelPlaybook` predicate pattern (similar tier-gated logic for 4A/4B)

### Orchestrator hooks
- `src/orchestrator/message-processor.ts` — Top-level streamText loop. `stopWhen` at line ~1278, `prepareStep` at ~1281, `experimental_onStepStart` at ~1306. Per-turn `stepNumber` declared at ~1010.
- `src/orchestrator/stream-runner.ts` — Sub-agent loop. `stopWhen` at line ~479, `prepareStep` at ~482. Mirror integration of 4A/4B here.
- `src/orchestrator/subagent-compactor.ts` — Existing tool_result rewriting layer (B3/B4). Injection point for 4A reminder.
- `src/orchestrator/cross-turn-dedup.ts` — Session-scoped dedup machinery (C3). Pattern reference for 4R session state lifting.
- `src/orchestrator/tool-args-hash.ts` — `canonicalizeBashCommand` + `hashToolArgs`. 4R reuses these unchanged.
- `src/orchestrator/tool-loop-cap.ts` — Existing pattern guard (Fix #1). 4B composes its `stopWhen` around this.

### Tool registry
- `src/tools/registry.ts` — Bash repeat detector currently per-turn closure (lines ~118-180). 4R refactors to session-scoped.
- `src/tools/registry-bash-footer.test.ts` — Unit test that must still pass after 4R.

### Harness
- `tests/harness/bash-output-get-tui.spec.ts` — Template for `scope-adherence-tui.spec.ts`
- `tests/harness/cost-leak-tui-helpers.ts` — `spawnCostLeakHarness` + `exitTuiAndWaitForDump`
- `tests/harness/recording.ts` — `loadDumpedRecordings`
- `vitest.harness.config.ts` — Test runner config (fileParallelism:false)

### Documentation
- `CLAUDE.md` (project root) — Harness workflow, Zero Hardcode Rule, Self-QA workflow
- `D:\Personal\Core\CLAUDE.md` — Agent working standard
- `C:\Users\phila\.claude\CLAUDE.md` — Experience engine hooks

</canonical_refs>

<specifics>
## Specific Ideas

### Baseline session evidence (DO NOT discard)

Telemetry source: `~/.muonroi-cli/muonroi.db`

| Session | Prompt | Tools | Tokens (in/out) | Cost | Wall |
|---|---|---|---|---|---|
| `33c09e970d30` | "giải thích đoạn code ở src/index.ts:1403" | 2 | 64K / 681 | $0.008 | 36s |
| `a4c4bddc5ad9` | "đổi default --max-tool-rounds từ 100 → 150 trong src/orchestrator/cli-args.ts" | 6 | 150K / 635 | $0.005 | 210s |
| `bf1afff343a9` | "tìm xem tại sao bash_output_get trả empty khi run_id sai" | 38 | 977K / 6.5K | $0.060 | 157s |
| `77cd2e11c6a5` | "thêm flag --budget-tokens N, khi total tokens > N thì halt với reason=\"budget exhausted\"" | **371** | **18.9M** / 37K | $0.69 | 17.7 min |
| `3485a0934def` | "improve test coverage" | **259** | **12.4M** / 60K | $0.54 | 16.7 min |

Smoking gun for 4R: session 77cd2e11c6a5 ran `{"command":"grep -n \"budgetToken\" \"src/ui/slash/ideal.ts\"}"` **9 times** with identical `args_json`.

### PIL trace confirming RC1

Session `77cd2e11c6a5` PIL trace (from `interaction_logs` metadata):
```
taskType=refactor,kind=task,conf=0.75,domain=none,style=concise,unified=skip,llm=ok
```
`unified=skip` + `llm=ok` confirms bridge classifier returned refactor for a feature-add prompt with confidence above the 0.7 fallback threshold.

</specifics>

<deferred>
## Deferred Ideas

- **File-scope quarantine** (Aider-style edit gating) — biggest single-feature impact on prompt-5-style bait, but adds ~200 LOC and needs orchestrator-level changes that conflict with current B3/B4 compactor wiring. Deferred to Phase 4.2 or Phase 5.
- **EE `IRRELEVANT` 100% noise** — `ee_intercept` fires on every tool call and judges IRRELEVANT in 100% of cases in baseline sessions. Flag for EE team to tune; not in Phase 4 scope.
- **Capability-scoped subagents per role** — research/executor split. Worthwhile but invasive. Phase 5+.
- **Per-task-type askcard option templates** — `"Code cleaner / Better performance / Easier to test"` askcard fires for feature-add and bug-fix prompts (wrong options). Should be conditional on `task_type`. Quick win but cross-cuts UI layer; defer for now.

</deferred>

---

*Phase: 04-scope-discipline-for-cheap-models*
*Context gathered: 2026-05-23 from baseline analysis + 3 research agents + RC1-RC4 root-cause confirmation*
