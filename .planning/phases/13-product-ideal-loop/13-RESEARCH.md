# Phase 13: Product Ideal Loop — Research (Spec Validation)

**Researched:** 2026-05-07
**Domain:** Self-driving product loop on top of existing council/verify/EE/PIL/flow infrastructure
**Confidence:** HIGH (live codebase inspected, no library knowledge required — pure reuse validation)

## Summary

The spec is **structurally sound** and the GSD/Flow pattern reuse approach (C) is well-supported by the
codebase. Council, verify, ee, pil, flow/artifact-io, run-manager, and ledger all exist and expose
the surfaces the spec assumes — with **two material exceptions** and **several path corrections** that
the planner must absorb before tasks are written.

**Material exceptions (must be addressed in plan):**

1. **`VerifyRecipe` has NO `coverage` field.** R1 in the spec is not just a degraded-mode risk — it is
   a missing primitive. Done-gate Cond #1 (`recipe.coverage > 0`) and CB-3
   (`recipe.coverage === 0`) cannot read what doesn't exist. Either (a) add `coverage` field to
   `VerifyRecipe` (Phase 13 edit, not zero-edit), or (b) redefine the engineering floor in terms of
   what `VerifyRecipe` does expose: `testCommands.length > 0` plus parsing the verify sub-agent's
   `ToolResult` for a coverage signal.
2. **Spec references `src/cli/commands.ts` which does not exist.** Slash commands live at
   `src/ui/slash/<name>.ts` and self-register via `registerSlash(name, handler)` from
   `src/ui/slash/registry.ts`. Plan must target the correct file.

**Material corrections (rename in plan):**

- `recipe.testCommand` (singular) → `recipe.testCommands: string[]` (array)
- `src/council/leader-eval.ts` (does not exist) → `src/council/leader.ts` (the correct filename)
- `PhaseOutcomeKind = "pass" | "fail" | "abandoned"` — spec's `phase-outcome=aborted` and
  `phase-outcome=resumed` are not in the enum. Use `abandoned` for both, or extend the enum
  (preferred — extension is one-line, intent-preserving).

**Primary recommendation:** Plans 13-01 through 13-06 in CONTEXT.md are the right granularity, but
13-04 (done-gate) must include a `VerifyRecipe.coverage` extension task, and 13-06 must target
`src/ui/slash/ideal.ts` not `src/cli/commands.ts`.

---

## Section 1 — Canonical References Verification

| Path / Symbol | Spec expectation | Live reality | Status |
|---|---|---|---|
| `src/orchestrator/orchestrator.ts:2037` `runCouncilV2` | line 2037, async generator | **EXACT — line 2037, signature `async *runCouncilV2(topic, options?): AsyncGenerator<StreamChunk, void, unknown>`** | ✅ Confirmed |
| `src/council/clarifier.ts` | exists, accepts seed dimensions | **Exists. Accepts `seedQuestions?: GrayAreaQuestion[]` 7th arg. Used in round 0 only.** | ✅ Confirmed (with caveat — see §2) |
| `src/council/debate.ts` | dynamic round system | **Exists. `runDebate` exported, parses `allCriteriaMet` from leader-eval** | ✅ Confirmed |
| `src/council/executor.ts` | runs implementation | **Exists.** | ✅ Confirmed |
| `src/council/leader-eval.ts` | leader evaluator | **DOES NOT EXIST. File is `src/council/leader.ts`.** Leader-eval logic lives inside `runDebate` (sees `parsed.allCriteriaMet`). | ⚠️ Filename wrong in spec |
| `src/council/index.ts` `runCouncil` | entry point | **Exists. Exports `runCouncil` (line 32), `RunCouncilOptions` (line 24) including `skipClarification?: boolean` (line 25).** | ✅ Confirmed — `skipClarification` is real |
| `src/verify/orchestrator.ts` `runVerifyOrchestration` | returns shape with `lastVerify.result` | **Exists. Returns `Promise<ToolResult>` with `verifyRecipe` attached. Does NOT return a structured `{ result: "PASS" \| ... }` field — caller must parse `ToolResult` content for verdict.** | ⚠️ Return shape simpler than spec assumes — see §3 |
| `src/verify/recipes.ts` | exposes `recipe.coverage` and `recipe.testCommand` | **`VerifyRecipe` (defined `src/types/index.ts:98`) has `testCommands: string[]` plural, NO `coverage` field at all.** | ❌ **Missing primitive — R1 is critical** |
| `src/ee/phase-tracker.ts` | boundary detection | **Exists. `setPhase(phaseName)` returns previous PhaseSnapshot when boundary crossed. `classifyOutcome` → `pass\|fail\|abandoned\|null`. Currently driven by `pilCtx.gsdPhase` in orchestrator (line 2894).** | ✅ Confirmed (boundary trigger mechanism is "phase name change", not "iterations.md append") |
| `src/ee/phase-outcome.ts` | post outcome | **Exists. `firePhaseOutcome` + `fireAndForgetPhaseOutcome` at lines 75/114. `PhaseOutcomeKind = "pass" \| "fail" \| "abandoned"` — `aborted` and `resumed` not in enum.** | ⚠️ Enum needs extension OR spec maps `aborted→abandoned`, `resumed→`(suppressed) |
| `src/ee/judge.ts` | FOLLOWED/IGNORED/IRRELEVANT | **Exists. `judge(ctx): Classification` returns one of three. `fireFeedback` + `NOISE_CONFIDENCE_THRESHOLD = 0.3`.** | ✅ Confirmed exactly |
| `src/pil/pipeline.ts` Layer 5 | resume digest consumer | **Exists. `runPipeline` calls `layer5Context` (line 46) which lives at `src/pil/layer5-context.ts:79`. Layer 5 reads digest via `loadFlowResumeDigest(cwd)` from `src/orchestrator/flow-resume.ts:31`. Digest is read from `state.md` "Resume Digest" section.** | ✅ Confirmed — section name "Resume Digest" already canonical |
| `src/flow/run-manager.ts` `RUN_FILES` | 4 files current; needs +2 | **`RUN_FILES = ["roadmap.md", "state.md", "delegations.md", "gray-areas.md"]` (line 22). Adding `iterations.md` + `manifest.md` is mechanical. `RunState` interface (line 14) also needs +2 fields.** | ✅ Confirmed |
| `src/flow/artifact-io.ts` | atomic read/write | **Exports `readArtifact(flowDir, filename)` and `writeArtifact(flowDir, filename, map)` (uses `atomicWriteText` from `storage/atomic-io.ts`).** | ✅ Confirmed |
| `src/usage/ledger.ts` | `Reservation` + commit | **`reserve()` returns `ReservationToken` (`src/usage/types.ts:8`) — token has NO `productRunId` field. `commit(token, actualInput, actualOutput, homeOverride?)` — no productRunId param. Plan must add field to `ReservationToken` and add new `commitToProduct()` wrapper.** | ✅ Confirmed (extension shape clear) |
| `src/cli/commands.ts` | slash command registration | **DOES NOT EXIST. `src/cli/` contains only `keys.ts` + `keys.test.ts` (provider-key flow).** | ❌ **Wrong path in spec** |
| In-app slash command registration | — | **Lives at `src/ui/slash/<name>.ts`. Pattern: each command exports a `SlashHandler` and self-registers via `registerSlash("name", handler)` from `src/ui/slash/registry.ts`. Existing examples: `council.ts`, `discuss.ts`, `plan.ts`, `execute.ts`, `expand.ts`, `optimize.ts`, `cost.ts`, `pin.ts`, `compact.ts`, `clear.ts`, `debug.ts`.** | ✅ Pattern is canonical |
| `src/gsd/types.ts` | location for `WorkflowKind` | **Exists. Currently exports `GSD_PHASES`, `GsdPhase`, `detectGsdPhase`. Adding `WorkflowKind = "task" \| "product"` here is consistent with file purpose.** | ✅ Confirmed |

### Council file inventory (additional context)

```
src/council/
├── clarifier.ts          ✅ accepts seedQuestions
├── context.ts
├── debate.ts             ✅ runDebate, allCriteriaMet
├── debate-planner.ts
├── executor.ts           ✅
├── index.ts              ✅ runCouncil, RunCouncilOptions
├── leader.ts             ✅ (NOT leader-eval.ts)
├── llm.ts                ✅ createCouncilLLM, temperature config
├── phase-events.ts
├── planner.ts
├── preflight.ts          ✅ user gate cards
├── prompts.ts
└── types.ts              ✅ ClarifiedSpec, CouncilLLM, CouncilStats
```

---

## Section 2 — Reuse-Claims Validation

| Spec claim | Reality | Adjustment needed |
|---|---|---|
| "Council clarifier accepts 6 seed dimensions externally without modification" | **PARTIAL.** `runClarification(...seedQuestions?)` signature accepts `GrayAreaQuestion[]`. BUT seed only used at round 0. AND `MAX_CLARIFICATION_ROUNDS = 3` (line 86) is hardcoded — spec wants 6 rounds. | **Parameterize `MAX_CLARIFICATION_ROUNDS`** OR pass `maxRounds` option. Trivial 1-line edit, but it IS an edit (no longer "zero edits" for council). Also: convert spec's 6 dimension definitions into 6 `GrayAreaQuestion` objects. |
| "`runCouncil` supports `skipClarification=true`" | **CONFIRMED.** `RunCouncilOptions.skipClarification` at `src/council/index.ts:25`, used at line 93 (`if (!options?.skipClarification)`). Already exercised by orchestrator at line 3161 (continuation flow). | None — perfect fit |
| "`runVerifyOrchestration` returns shape needed by done-gate Cond #1" | **PARTIAL.** Returns `ToolResult & { verifyRecipe }`. Cond #1 spec assumes `lastVerify.result === "PASS"`. `ToolResult` shape (per `src/types/index.ts`) does not directly expose a typed `result: "PASS"` field — verdict is buried in agent text/checkpoint output. | **Plan 13-04 needs a `parseVerifyResult(toolResult): "PASS" \| "FAIL" \| ...` helper.** Inspect `src/verify/checkpoint.ts` for how the existing system reads PASS/FAIL — likely a marker scan in result content. |
| "EE phase-tracker auto-detects sprint boundary from `iterations.md` append" | **NO — phase-tracker boundary is driven by `setPhase(name)` calls, not file appends.** Currently fires on `pilCtx.gsdPhase` change inside `orchestrator.ts` line 2894. | **Loop driver must explicitly call `phaseTracker.setPhase("sprint-N")`** at each transition; the `iterations.md` append is the durable record but not the trigger. Spec's mental model is correct in spirit — just wire it explicitly. |
| "EE judge FOLLOWED/IGNORED/IRRELEVANT classifier" | **CONFIRMED EXACTLY.** `judge(ctx)` returns one of those three strings. `fireFeedback` already exists. | None |
| "PIL Layer 5 reads `state.md` Resume Digest" | **CONFIRMED.** `loadFlowResumeDigest` reads section literally named "Resume Digest" from active run's `state.md`. `createRun()` already initializes that section header. | None — spec's resume-digest contract aligns exactly |
| "`flow/artifact-io.ts` atomic read/write" | **CONFIRMED.** `readArtifact`/`writeArtifact` use `atomicWriteText`. Section-map model (`SectionMap`) is what all 6 run files use. | None |
| "Ledger has `Reservation` type" | **CONFIRMED but field is named `ReservationToken`, not `Reservation`.** Located in `src/usage/types.ts:8`. | Rename references in spec/plan to `ReservationToken`. The new `productRunId` field belongs there. |

---

## Section 3 — Newly-Discovered Dependencies (spec missed)

### 3.1 Test framework + style
- **vitest 4.1.5** is the test runner (`package.json:88`).
- Tests live next to source as `*.test.ts` (e.g., `src/usage/ledger.test.ts`) AND inside `__tests__/` subdirectories (e.g., `src/council/__tests__/clarifier-options.test.ts`).
- Mocking: search shows no global mock library — vitest's built-in `vi.fn()` / `vi.mock()` is used.
- **Recommendation for Phase 13:** Use `__tests__/` subdir per spec §2.1, file-per-module convention (`done-gate.test.ts`, `circuit-breakers.test.ts`, etc.).

### 3.2 Logging / telemetry
- No global logger. Codebase uses `console.warn` for soft failures (e.g., `phase-outcome.ts:97`). For UI output, code yields `StreamChunk` events with `type: "content"`.
- **Recommendation:** product-loop emits progress as `StreamChunk` (matching council pattern) — no new logging dependency.

### 3.3 TUI cards
- `StreamChunk.type` enum (`src/types/index.ts:309`) currently includes `council_question | council_preflight | council_status | council_phase`. **`product_status_card` is NOT in this enum** — spec must add it.
- The chunk type union is the wire-format contract between orchestrator and UI. Adding a new chunk type requires:
  1. Extend `StreamChunk.type` union in `src/types/index.ts`
  2. Add UI renderer in `src/ui/` (find where `council_status` renders and mirror)
- **Spec edit count was undercounted.** New card = 1 type + 1 renderer + tests, ~80–100 LoC, NOT zero edits.

### 3.4 Type-export conventions
- Each module has its own `types.ts` (`src/council/types.ts`, `src/usage/types.ts`, `src/gsd/types.ts`). Plan 13-01's `src/product-loop/types.ts` matches convention.
- No barrel files. Imports are file-relative with `.js` extension (ESM TS pattern). Plan must use `import { x } from "./foo.js"` even though source is `.ts`.

### 3.5 Async iterator pattern
- `runCouncilV2` (`async *...AsyncGenerator<StreamChunk, void, unknown>`) is the canonical contract. Consumer drains via `for await (const chunk of gen)`. **Spec's `runProductLoopV1` snippet is correct** — keep it.

### 3.6 Council determinism (R4 reality check)
- `src/council/llm.ts:26` sets `temperature: 0.7` for primary calls, line 71 sets `temperature: 0.3` for some. **No `seed` parameter, no deterministic mode.** R4 is real and unavoidable without an upstream change to `llm.ts`. Spec's mitigation (document divergence + record both crashed and re-run sprint in `iterations.md`) is the correct call.

### 3.7 EE phase-outcome enum gap
- Spec wants `phase-outcome=aborted` and `phase-outcome=resumed`. The enum allows only `pass | fail | abandoned`. Either:
  - **Extend** `PhaseOutcomeKind = "pass" | "fail" | "abandoned" | "aborted" | "resumed"` (one-line edit in `src/ee/phase-outcome.ts:21`, plus matching server contract update)
  - **OR** map `aborted → abandoned` and skip `resumed` (no edit, but loses signal)
- **Recommendation:** extend the enum; the EE server should be updated in lockstep. If server change is out of Phase 13 scope, fall back to `abandoned`.

---

## Section 4 — Library / Framework Decisions

| Decision | Outcome | Reasoning |
|---|---|---|
| FSM library vs hand-roll | **Hand-roll switch in `loop-driver.ts`.** | No FSM library in `package.json`. Spec FSM has ~10 states with linear progression — a `switch (state)` block is clearer than introducing xstate (~80KB) for one consumer. |
| EWMA implementation | **Inline pure-math one-liner per spec §6.5.** | No library needed. Spec already specifies exact formula. |
| Token estimator (`chars/4`) | **Reuse `estimateTokensFromChars` at `src/usage/estimator.ts:15`.** | Already exists. Same fallback used by `src/orchestrator/token-counter.ts`. |
| Atomic file IO | **Reuse `flow/artifact-io.ts` `writeArtifact` (which uses `atomicWriteText` from `storage/atomic-io.ts`).** | No new dep. |
| File locking for ledger | **Reuse `proper-lockfile` (already a dep, used by `usage/ledger.ts`).** | Per-product ledger writes can wrap the same `withLock` helper pattern — single-writer-per-run per CONTEXT.md is sufficient, so a simple lock around the JSONL append is enough. |
| CLI parser for `/ideal` flags | **Use `commander` (already a dep, line 60 of package.json) inside `src/ui/slash/ideal.ts`.** | The slash handler receives `args: string[]` already split — can parse with `commander.Command` for `--max-cost`, `--max-sprints`, etc. Mirror how `council.ts` handles its `[rounds] <topic>` parse. |

---

## Section 5 — Risk Reality Check

### R1 — Recipe coverage detection (CRITICAL, escalated)
**Spec status:** "treat missing coverage as `coverage=0`, force user to declare recipe explicitly."
**Reality:** Coverage is not "sometimes missing" — **the field doesn't exist on `VerifyRecipe` at all.**
The recipe profile (`src/verify/recipes.ts`) infers `testCommands` for bun/vitest/jest/pytest/go/cargo/maven/gradle/django, but parses NO coverage metric. The verify sub-agent runs the test command and emits a `ToolResult` whose content the orchestrator parses for PASS/FAIL.

**Concrete options for plan 13-04:**

| Option | Cost | Tradeoff |
|---|---|---|
| **A. Add `coverage?: number` field to `VerifyRecipe`, parse from test output** | ~80 LoC across `recipes.ts`, parser per ecosystem (vitest `--coverage`, pytest `--cov`, etc.) | Most faithful to spec. Reusable beyond product-loop. **RECOMMENDED.** |
| B. Redefine engineering floor as `recipe !== null && testCommands.length > 0 && lastVerify.result === "PASS"` (drop coverage check) | ~5 LoC | Loses anti-vacuous-test signal. CB-3 becomes "no recipe" check only. |
| C. Add `coverage` as a sidecar field on `iterations.md` populated by Tester role manually | ~30 LoC | Trust-based, defeats deterministic-floor purpose of L2. |

**Recommendation: Option A** — make Phase 13's `VerifyRecipe` extension explicit in plan 13-04. Implement coverage parsers for at least bun/vitest/jest/pytest (covers >80% of greenfield repos in scope). For unsupported ecosystems, return `coverage: null` and treat as fail-closed in CB-3.

### R4 — Council determinism on resume (CONFIRMED real)
**Spec status:** "Document divergence; record both sprints in `iterations.md` with `crashed` flag on first."
**Reality:** `src/council/llm.ts` uses `temperature: 0.7` (line 26) and `0.3` (line 71). No seed. No deterministic mode flag. Resume re-runs WILL produce different content on identical input.

The mitigation is sufficient for v1 — but plan 13-03 (loop-driver) must:
1. Detect "in-flight sprint" on resume by checking `iterations.md` for an entry without a closing `Verify:` line (or a `crashed` flag set by the abort handler).
2. Append a NEW sprint entry on re-run with `originalSprint: N, retryOf: <prev-id>` metadata.
3. NOT attempt to "continue from where it left off" — restart the sprint from `plan` stage.

No upstream change to `llm.ts` is in scope.

---

## Section 6 — Plan-Breakdown Recommendation (refinement)

CONTEXT.md `<specifics>` proposes 6 plans. Codebase realities suggest minor restructuring:

| Plan | CONTEXT proposal | Refined recommendation | Rationale |
|---|---|---|---|
| **13-01** | Types + run-manager extensions + manifest/iterations IO | **KEEP.** Add: extend `StreamChunk.type` union with `product_status_card` here too, since types.ts is being touched. | Type changes batched in one plan |
| **13-02** | Role registry + cross-tier resolution + per-role memory | **KEEP.** | Self-contained |
| **13-03** | Loop driver FSM + gather/research/scoping | **KEEP. Add: parameterize `MAX_CLARIFICATION_ROUNDS` in clarifier (1-line edit) + define 6 seed `GrayAreaQuestion` objects.** | Clarifier touch is small but real — call it out explicitly so it doesn't get missed |
| **13-04** | Done-gate (5 conditions) + reality-anchor + circuit breakers | **EXPAND. Add explicit subtask: extend `VerifyRecipe` with `coverage` field + per-ecosystem parsers (bun/vitest/jest/pytest minimum). Add: `parseVerifyResult(toolResult)` helper.** | R1 promoted from "risk" to "scoped work" |
| **13-05** | Cost-scoper + ledger integration + EE phase-tracker boundary wiring | **KEEP. Clarify:** ledger work = add `productRunId?` to `ReservationToken` + new `commitToProduct()` + per-product JSONL writer. EE wiring = `phaseTracker.setPhase("sprint-N")` calls inside loop-driver (this overlaps 13-03 — decide which plan owns the call sites). | Ownership boundary needs an explicit decision |
| **13-06** | CLI command + orchestrator wiring + `product_status_card` TUI + integration tests | **CHANGE FILE TARGET: `src/ui/slash/ideal.ts` (NEW), NOT `src/cli/commands.ts` (does not exist).** Add: TUI renderer for `product_status_card` chunk type alongside existing `council_*` renderers. | Path correction is critical to avoid wasted work |

**New cross-cutting concern (consider as 13-00 prerequisite or fold into 13-04):**
- `PhaseOutcomeKind` enum extension (`aborted`, `resumed`) — needs server-side coordination. If the EE server is not in this phase's scope, plan 13-05 should explicitly note the fallback (`aborted → abandoned`, `resumed` suppressed).

**LoC estimate sanity check:**
Spec claims ~155 LoC of edits. Real edit budget after corrections:

| File | Spec LoC | Refined LoC | Delta |
|---|---|---|---|
| `src/gsd/types.ts` | 15 | 15 | — |
| `src/flow/run-manager.ts` | 40 | 40 | — |
| `src/usage/ledger.ts` | 30 | 35 | +5 (token type field) |
| `src/cli/commands.ts` (→ `src/ui/slash/ideal.ts` NEW) | 20 | 80 | +60 (new file, commander parsing) |
| `src/orchestrator/orchestrator.ts` | 50 | 50 | — |
| `src/council/clarifier.ts` (NEW edit) | 0 | 5 | +5 (parameterize MAX_ROUNDS) |
| `src/types/index.ts` (NEW edit) | 0 | 5 | +5 (StreamChunk.type union) |
| `src/verify/recipes.ts` + `src/types/index.ts:VerifyRecipe` (NEW edit, R1) | 0 | 80 | +80 (coverage field + parsers) |
| `src/ee/phase-outcome.ts` (NEW edit, optional) | 0 | 2 | +2 (enum extension if scoped in) |
| New UI renderer for product_status_card | 0 | 60 | +60 |
| **Total edits** | **155** | **~370** | **+215** |

New code (`src/product-loop/`) ~1200 LoC estimate from spec is plausible and unaffected. **Total Phase 13 LoC: ~1570** (vs spec's 1355).

---

## Sources

### Primary (HIGH confidence — direct codebase inspection)
- `src/orchestrator/orchestrator.ts` lines 2037–2082 (`runCouncilV2` template)
- `src/council/index.ts` lines 24–32 (`RunCouncilOptions.skipClarification`)
- `src/council/clarifier.ts` lines 86–117 (`MAX_CLARIFICATION_ROUNDS=3`, seedQuestions wiring)
- `src/council/llm.ts` lines 26, 71 (temperature 0.7 / 0.3 — R4 evidence)
- `src/types/index.ts` lines 98–113 (`VerifyRecipe` interface — no coverage field)
- `src/types/index.ts` line 309 (`StreamChunk.type` union)
- `src/verify/recipes.ts` (full file — `testCommands: string[]` plural; no coverage parser)
- `src/verify/orchestrator.ts` lines 112–129 (`runVerifyOrchestration` signature)
- `src/ee/phase-tracker.ts` lines 24–155 (boundary detection via `setPhase`)
- `src/ee/phase-outcome.ts` line 21 (`PhaseOutcomeKind` enum)
- `src/ee/judge.ts` lines 28, 39 (`NOISE_CONFIDENCE_THRESHOLD`, `judge()` shape)
- `src/pil/layer5-context.ts` line 79 + `src/orchestrator/flow-resume.ts` lines 31–50 (Resume Digest section consumer)
- `src/flow/run-manager.ts` lines 14–22, 36–129 (`RunState`, `RUN_FILES`, `loadRun`, `createRun`)
- `src/flow/artifact-io.ts` lines 18, 32 (`readArtifact`, `writeArtifact`)
- `src/usage/ledger.ts` lines 103–207 (`reserve`, `commit`, `release`)
- `src/usage/types.ts` lines 8–16 (`ReservationToken`)
- `src/ui/slash/registry.ts` (full file — `registerSlash` pattern)
- `src/ui/slash/council.ts` (canonical slash example)
- `src/cli/` directory listing — only `keys.ts` + `keys.test.ts` exist
- `src/gsd/types.ts` (full file — current shape, no `WorkflowKind`)
- `package.json` lines 48–88 (deps: vitest 4.1.5, commander 12, proper-lockfile, no FSM lib)

## Metadata

**Confidence breakdown:**
- Canonical refs: HIGH — every path opened directly
- Reuse claims: HIGH — every API surface inspected
- Newly-discovered dependencies: HIGH — derived from package.json + actual file contents
- R1/R4 reality check: HIGH — both confirmed by live code, not inferred

**Research date:** 2026-05-07
**Valid until:** 2026-06-07 (30 days; codebase may shift)
**Validation type:** Spec-vs-codebase reality check, not redesign. All architectural decisions per spec remain locked.
