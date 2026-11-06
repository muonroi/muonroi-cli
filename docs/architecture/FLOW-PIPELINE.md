# FLOW pipeline & BB-aware `/ideal` — architecture notes

> Moved out of `CLAUDE.md` (2026-11-06).

## BB-aware `/ideal`

When the scaffold target resolves to `muonroi-building-block` (BB) — i.e., presence of `Directory.Build.props` + `*.sln` + any `src/Muonroi.*` directory — `/ideal` injects BB-specific context into the council system prompt at CB-1. Key files:

- `src/ee/bb-retrieval.ts` — `fetchBBContext(prompt, opts)` queries EE collections `bb-recipes`, `bb-behavioral`, `experience-principles` in parallel with retry-once + graceful degrade. Token budget 1500. Marker-stamped output for Layer 3 dedup.
- `src/product-loop/loop-driver.ts` — CB-1 entry point that injects the retrieved BB context BEFORE council debate fires.
- `src/pil/layer3-ee-injection.ts` — scans `ctx.enriched` for `<!-- bb-context-injected:<sha> -->` markers and skips already-injected hits.
- `src/pil/layer3-ee-injection.ts` (ee-anti-mu) — also extracts `<!-- ee-checkpoint-injected:<sha> -->`, injects formatTaskCheckpoints from behavioral search for "Context checkpoint summary", enriches layer1 raw for long sessions, and supports ee.query (MCP) for explicit "recent task checkpoint Progress DONE".
- `src/scaffold/init-new.ts` — detects BB target heuristically, sets `IntentDetectionTrace.targetFramework = "muonroi-building-block"`.
- `src/scaffold/bb-ecosystem-apply.ts` — applies senior-bar code-gen (Program.cs wiring, sample rule + test, props minimalism, modular-boundaries gate).
- `src/scaffold/bb-quality-gate.ts` — runs `dotnet restore` + `dotnet build` + `check-modular-boundaries.ps1` + sentinel regex check after scaffold.
- `src/scaffold/resume-from-gate-failures.ts` — `/ideal --resume <path>` re-enters CB-1 with `EE-GATE-FAILURES.md` context.

Ingestion + collection layout: `docs/agent-harness/EE-INGESTION.md`.

EE failure-mode reference (what every call site does when EE is down):
`docs/ee/EE-DOWN-BEHAVIOR.md`.

Feature flag: `userSettings.eeBBContext: false` to disable BB retrieval.

## Native FLOW depth pipeline & the hard mutation gate

FLOW is **native to the runtime**, not the external superpowers skill. Depth is
agent-decided and variable — `quick` | `standard` | `heavy` | (none) — and every
stage consumes the prior stage's artifact, so the flow is one continuous pipeline
built on the native Muonroi Flow engine (`src/workflow/`), never a workaround around it.

**The one depth slot everything reads.** layer1 model-first classify emits
`pilCtx.modelDepthTier` + `pilCtx.confidence` (`src/pil/layer1-intent.ts`) →
`syncWorkflowContext(cwd, model, depth)` in `src/orchestrator/message-processor.ts`
→ SDK `setStateField` writes `Depth` into `.planning/STATE.md`. Downstream code
reads depth via `readState(cwd).depth`, never off a propagated pilCtx field.

**Pipeline stages (each feeds the next):**

1. **Complexity assessor** (`src/workflow/complexity-assessor.ts`) — a leader-tier
   single-shot call (`createCouncilLLM(...).generate`, billed `source=council`,
   no cost leak) that *enriches the same* `modelDepthTier` slot. `shouldAssess`
   pre-filters: standard/heavy always assess, low-confidence (<0.7) quick
   assesses, high-confidence quick skips. NEVER throws (parse/leader failure →
   `parse-failed-fallback`). Writes `.planning/ASSESSMENT.md`.
2. **Council context** (`src/workflow/council-context.ts`) folds `ASSESSMENT.md`
   into `buildCouncilContextBundle`, so plan-review AND verify councils both see
   the assessment rationale — pipeline coherence.
3. **Directive** (`src/pil/layer4-flow.ts`) is emitted during PIL prep — i.e.
   *before* the assessor runs — so it is keyed on the layer1 classify depth,
   NOT the assessed depth (the assessor override reaches the gate + `flow_verify`
   via STATE.md / `pilCtx.modelDepthTier`, not this directive). heavy →
   MANDATORY `flow_status → flow_discuss → flow_plan → flow_plan_review`, mutation
   tools BLOCKED until plan-review passes; standard → advisory
   ("recommend flow_plan_review", no BLOCKED); quick → no gate. The mutation
   gate is coherent with this: it hard-blocks on **heavy only** (`quick` /
   `standard` / null all fail open). standard stays advisory — hard-blocking
   every default-tier bash/edit until a plan-review pass over-reaches; only
   genuinely non-trivial work (heavy, including tasks the assessor UPGRADES to
   heavy) earns the hard gate.
4. **Mutation gate** (`src/workflow/mutation-gate.ts`) — `evaluateMutationGate` runs
   inside the tool-engine write-mutex wrapper (`src/orchestrator/tool-engine.ts`)
   before every non-read-only, non-`respond_`, non-`flow_*` tool. It reads depth
   from `readState(cwd).depth` and **delegates to the SDK's `canExecute(cwd,
   depth)`** — no reimplemented gate. Fail-open: only an explicit `heavy` depth
   arms it; `standard` logs an advisory line and passes, `null`/`quick` pass
   through (`mutation-gate.ts:86-101`). Blocked → `{success:false, output, error}`
   BEFORE the mutation runs. Also called from `stream-runner.ts:696` and
   `tool-engine.ts:1499`.
5. **Verify layer** (`flow_verify` in `src/workflow/workflow-tools.ts`) — deterministic
   floor first (tests/lint evidence); if the floor passes at standard/heavy,
   `runVerifyCouncil` (`src/workflow/verify-council.ts`) adjudicates goal-achievement
   and its verdict **overrides** the model's self-reported `passed`. Parse
   failure → `revise`, never a silent approve. Writes `.planning/VERIFY-COUNCIL.md`.

**Env flags** (all default ON with native FLOW; opt out with `=0`), defined in
`src/workflow/flags.ts`:

| Flag | Effect |
|---|---|
| `MUONROI_FLOW_NATIVE=0` | Disable native FLOW entirely → legacy playbook rubric, no `flow_*` tools. |
| `MUONROI_FLOW_ASSESSOR=0` | Skip the leader-tier assessor; depth comes only from layer1 classify. |
| `MUONROI_FLOW_HARD_GATE=0` | Disable the mutation gate; directives become advisory-only. |

**Plan-review convergence** (`src/workflow/plan-review-convergence.ts`, knobs in
`src/workflow/review-budget.ts`). Every recorded review appends a round to
`.planning/PLAN-REVIEW-ROUNDS.json`. The loop is settled by the HOST when the round
allowance is spent without a pass, when the same blocking objection stays open across
`allowance` consecutive reviews, or when the same objections are re-raised on an
unchanged plan. Default settlement = admit the plan with the unresolved findings kept
OPEN in `PLAN-FINDINGS.json` (the verify council reads them); `PLAN-VERIFY.md` records
`admissionMethod: convergence-settlement` and a `toast` LiveEvent announces it. Never
asks the user (no blocking card). Allowance: env `MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS`
→ `.planning/config.json` `workflow.plan_review_max_rounds` → 3. Policy: env
`MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION` → `workflow.plan_review_on_exhaustion` →
`proceed` (`stop` = old refuse-and-report). E2E: `tests/harness/plan-review-convergence.spec.ts`.

E2E coverage of the deterministic gate: `tests/harness/flow-hard-gate.spec.ts`
(seeds `.planning/STATE.md` in a throwaway temp cwd; assessor OFF for
determinism). Gate/assessor/verify logic is unit-covered under `src/workflow/__tests__/`.
