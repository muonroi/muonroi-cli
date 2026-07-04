# GSD Native Hardening — Council Context + Perf + Read Path

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Harden the native GSD integration (shipped via PRs 1–5, commits `ab220524`→`bd34f1b2`) so the
plan-council debate carries **full prior GSD context** (the user's primary ask), subprocess overhead is
cached away, and `gsd_status` is a true read. This makes the council's verdict grounded enough that the
downstream `verify` step can trust the plan that landed.

**Non-goals:** Re-architecture of the Loop Host; changing the depth-gating matrix; Phase 4 `/ideal`
convergence.

---

## Evidence (current gaps)

| Gap | File:line | Symptom |
|-----|-----------|---------|
| Subprocess per dispatch — `LOOP_HOST_CONTRACT` re-read every `firePoint` | `src/gsd/gsd-runtime.ts:24-27`, `src/gsd/loop-host.ts:103` | ~80–150ms × N spawns/turn on Windows |
| `init.progress` re-spawned on every `gsd_status` + turn sync | `src/gsd/workflow-engine.ts:204-214`, `src/gsd/workflow-tools.ts:60-62` | 200–500ms/turn latency tax |
| Council debate topic only sees PLAN.md + CONTEXT.md | `src/gsd/plan-council.ts:175-186` | Debate loses STATE/RESEARCH/prior-review concerns → off-topic rehash |
| Perspective prompts only see PLAN.md (no STATE/depth/context) | `src/gsd/plan-council-prompts.ts:45-56` | Same grounding gap for non-debate path |
| `gsd_status` writes STATE.md via `syncWorkflowContext` | `src/gsd/workflow-tools.ts:60-62` | Read tool has side effects |
| No E2E spec drives plan→review→execute→verify→ship | `tests/harness/gsd-native.spec.ts` (smoke only) | Verification criteria from original plan uncovered |

**Already covered (no work):** malformed-JSON tool-args repair — `repairToolCallHook` lives at
`src/orchestrator/repair-tool-call.js`, wired at `src/orchestrator/tool-engine.ts:1540`. The Phase 0
empty-args BLOCKED path (`registry.ts:503`) complements it for well-formed-but-empty input.

---

## Task 1 — Subprocess caching layer

**File:** `src/gsd/gsd-runtime.ts`, `src/gsd/gsd-dispatch.ts`

- [ ] Cache `loadLoopHostContract()` result in a module-level `let _contractCache: LoopHostContractEntry[] | null`.
  Contract is static for the installed `@opengsd/gsd-core` version — safe for process lifetime.
- [ ] Cache `dispatchInitProgress(cwd)` + `dispatchStateJson(cwd)` results in a `Map<cwd, { value, stateMtimeMs }>` keyed
  on `STATE.md` mtime. Invalidate when mtime changes OR after any `dispatchStateUpdate` / `setStateField` write to that cwd
  (call `invalidateGsdCache(cwd)` from `setStateField`).
- [ ] Export `invalidateGsdCache(cwd: string): void` from `gsd-dispatch.ts`; wire into
  `workflow-engine.ts:setStateField` after `writeStateFile`.
- [ ] Unit test: repeated `dispatchInitProgress(cwd)` calls spawn the subprocess at most once when STATE.md unchanged;
  second call after `writeStateFile` spawns again.

**Acceptance:** `bunx vitest run src/gsd/__tests__` green; the turn-sync path in `message-processor.ts:636-648`
performs zero `init.progress` spawns when STATE.md is stable across turns.

---

## Task 2 — Council context enrichment (PRIMARY ASK)

**Files:** `src/gsd/plan-council.ts`, `src/gsd/plan-council-prompts.ts`, `src/gsd/__tests__/plan-council.test.ts`

Introduce a `buildCouncilContextBundle(cwd)` that gathers:

| Artifact | Source | Why |
|----------|--------|-----|
| Current phase / depth / workflow kind | `STATE.md` via `readState` + `readWorkflowKind` | Anchor debate in where we are |
| Discuss notes / gray areas | `CONTEXT.md` if present | User-stated ambiguities — debate must resolve them |
| Research findings | `RESEARCH.md` if present | Ground claims with prior evidence |
| Prior round concerns | `PLAN-REVIEW.md` concerns section if `revisionCycle > 0` | Stop rehashing; force each perspective to address prior concerns |
| Acceptance criteria snapshot | extracted from `PLAN.md` `## Acceptance` / `## Criteria` | Verify-step contract — debate must agree these are testable |

- [ ] New `buildCouncilContextBundle(cwd): { state, workflowKind, contextMd, researchMd, priorConcerns, acceptanceCriteria, depth }`.
  Reads are tolerant (missing file → empty string). Cap each section to keep the debate prompt bounded
  (STATE 600 chars, CONTEXT/RESEARCH 2000 each, prior concerns 1500, acceptance criteria 800).
- [ ] In `runPlanCouncil`, pass the bundle into BOTH paths:
  - **Debate path** (`opts.runDebate`): prepend a `## GSD Context` block to the topic BEFORE `### Proposed PLAN.md`,
    plus a `### Prior council concerns (revision N)` block when `revisionCycle > 0`. End with the directive:
    "Debate whether this plan resolves every prior concern and satisfies the acceptance criteria — do not relitigate settled points."
  - **Perspective path**: extend `buildPerspectivePrompt(perspective, planBody, bundle)` to include the same
    context block so each sub-agent sees STATE/depth/workflow-kind/prior concerns. Research perspective additionally
    gets the RESEARCH.md digest to avoid re-grounding.
- [ ] Telemetry: add `contextBundleChars` + `hadPriorConcerns` to `logGsdNativeEvent` at `loop-host.ts:193`.
- [ ] Unit tests:
  - revision cycle > 0 → prior concerns appear in both debate topic and perspective prompt
  - missing artifacts → bundle still builds (no throw)
  - acceptance criteria extracted from PLAN.md appear in verify-track context

**Acceptance:** a `heavy` depth plan-council run with a seeded prior `PLAN-REVIEW.md` produces a topic
string that contains the prior concerns verbatim; the `research` perspective prompt contains the RESEARCH.md
digest. Council can no longer "start from scratch" on revision cycles — this is what makes verify trust the verdict.

---

## Task 3 — `gsd_status` read-only

**File:** `src/gsd/workflow-tools.ts`

- [ ] Replace `syncWorkflowContext(cwd, sessionModelId, depth)` inside `gsd_status.execute` with a pure read:
  call `ensurePlanningWorkspace` only if `.planning/` is absent (idempotent guard), never write STATE.
- [ ] Description updated to reflect pure-read semantics (no implicit phase advance).

**Acceptance:** calling `gsd_status` 3× in a row does not change `STATE.md` mtime.

---

## Task 4 — E2E full-flow harness spec

**File:** `tests/harness/gsd-native-flow.spec.ts` (new)

Drive the lifecycle via the harness in a greenfield cwd (pattern: `council-flow.spec.ts`, `events.spec.ts`):

1. Spawn with `MUONROI_GSD_NATIVE=1`, mock-llm fixture, greenfield temp cwd.
2. `/gsd_plan` with a 3-step plan body → assert `PLAN.md` written, STATE phase = `plan`.
3. `/gsd_plan_review` → assert `PLAN-VERIFY.md` written with `verdict:` line.
4. `/gsd_execute` BEFORE review pass (force a fail scenario) → assert `{ blocked: true }` shape.
5. After pass verdict → `/gsd_execute` → phase = `execute`.
6. `/gsd_verify` with `passed:true, evidence:"..."` → `VERIFY.md` written.
7. `/gsd_ship` → `SHIP.md` written, phase = `review`.

- [ ] Subscribe to `council-step` events before dispatching `/gsd_plan_review` to confirm council fires.
- [ ] Assert the council context bundle enriches the debate (set a prior `PLAN-REVIEW.md`, run again, assert
  prior concerns surfaced — this is the user's primary acceptance).

**Acceptance:** spec passes on Windows (named-pipe transport) deterministically within 60s.

---

## Task 5 — Verification gate

- [ ] `bunx tsc --noEmit` → 0 errors
- [ ] `bunx vitest run src/gsd` → 0 failures
- [ ] `bun run lint:semantic` → clean
- [ ] Harness: `bunx vitest -c vitest.harness.config.ts run tests/harness/gsd-native-flow.spec.ts`

---

## Risk Register

| Risk | Mitigation |
|------|------------|
| Cache stale after external STATE.md edit | mtime-based invalidation + explicit invalidate-on-write |
| Context bundle blows prompt budget | per-section char caps; total bounded ≤ ~6K chars |
| E2E spec flake (council latency) | greenfield cwd (instant scan) + 60s timeout + mock-llm |
| Perspective sub-agents ignore added context | prompt directive line: "Address prior concerns explicitly in your verdict" |

## Out of scope

- Default-off flip (keeping default-on; E2E spec covers confidence instead).
- Phase 0 JSON-parse repair (already handled by `repairToolCallHook`).
- Catalog roles expansion (separate concern, last commit `8d8924bf`).
