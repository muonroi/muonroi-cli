# Council intent gate + planner phase + plan-driven execution

**Date:** 2026-08-04
**Status:** approved design, ready for implementation planning
**Evidence session:** `3a8378db4adf` (council run 2026-08-04 01:15:34Z → 01:24:02Z)

## Problem

A council debate is expensive (this run: 4m45s of debate + 80s synthesis, 22 `call_accounting`
rows at `stage=council`) and produces a sharp conclusion. What happens on either side of it
wastes that sharpness:

- Nothing asks the user **what they want** before the debate starts, so the debate topic is
  whatever raw text they typed.
- Nothing turns the conclusion into a **reviewed plan**, so the implementation that follows is
  scoped to a single next step.
- The handoff into implementation is prose, and the prose gets re-classified as a report.

Net effect the user reported: "council xong thì lại hỏi implement luôn và implement rất nông so
với debate — chỉ implement P0, còn muốn P1 thì lại khởi động 1 council khác."

## Measured evidence

All rows from `~/.muonroi-cli/muonroi.db`, `interaction_logs WHERE session_id='3a8378db4adf'`.

| id | time (UTC) | event | payload |
|---|---|---|---|
| 2378 | 01:15:34 | `ui_interaction/askcard_open` | `phase: "council-setup"`, options `Start debate / Cheap run / Refine the topic first / Cancel` |
| — | — | topic | `"vậy làm tiếp p1 nhỉ? đã có context và plan đầy đủ chứ ?"` — a yes/no question, verbatim |
| 2472 | 01:18:33 | `council/stance_recall` | `seededRoles: ["verify","implement"]` — 2 panelists, no planner |
| 2490 | 01:20:36 | `council/debate_complete` | `roundCount: 2`, `duration_ms: 284635` |
| 2492 | 01:21:57 | `council/synthesis` | `duration_ms: 80347`, `participantCount: 2` |
| 2495 | 01:24:02 | `council/council_summary` | `type: "evaluation"`, `confidenceLevel: "medium"`, `evidenceDensity: 0.5`, `agreedCount: 0` |
| 2493 | 01:21:57 | `askcard_open` | `phase: "post-debate"`, options `Thêm E2E sentinel transition / Thảo luận thêm / Lưu review và dừng` |
| 2494 | 01:24:02 | `askcard_answered` | `answerText: "implement"` |
| 2498 | 01:24:15 | `pil/analyze` | `taskType=analyze, deliverable=report, depth=standard`; layer4 `route=none blocking=false` |
| 2509 | 01:25:11 | `tool_result/gsd_status` | `phase: "plan", depth: "standard", planVerified: false` |

Corroborating, from `~/.muonroi-cli/debug.log` at `01:24:05Z` — the orchestrator sub-session
router on the same continuation text:

> `action: DIRECT_ANSWER, confidence 0.93 — "The user is only providing the council's approved
> conclusion and review context; no explicit new implementation or multi-step task is requested."`

Note this router (`orchestrator.ts:3288`) only chooses **parent session vs. forked sub-session**.
It is not an implement-vs-answer gate; its reason text is corroborating evidence for how the
prose reads, not a third blocking gate. The two real gates are PIL classify and layer4 GSD.

## Root causes

### RC1 — no intent gate; `outputKind` is inferred after the fact

`buildLaunchCard` (`src/council/launch-card.ts:108-156`) configures only the **shape of the
spend**: panel, round budget, research, cost-aware, language, plus `Start / Cheap / Refine /
Cancel`. It never asks what the user wants out of the run.

Consequently `outputKind` is recovered *after* synthesis by regexing the synthesis JSON —
`synthesisOutputKind` (`src/council/index.ts:318-323`) matches `"type"\s*:\s*"([^"]+)"` and
coerces unknowns to `"evaluation"`. In this session that produced `evaluation`, which then drove
`pickPostDebateRecommendation` and `postDebateContinuation`. An after-the-fact inference decides
the run's whole downstream shape.

### RC2 — no planner role, no plan artifact

The council has no planner. `src/council/index.ts:366-368` records the current deliberate
position:

> "Works for ANY output kind: an analysis/decision synthesis is itself a sufficient spec, so this
> no longer needs a separate plan artifact."

`index.ts:369` then makes `generate_plan` and `implement` return the **same continuation string**,
so `generate_plan` is dead code. `ActionPlan` (`src/council/types.ts:269`) is
`{ steps: [{description, agent?, priority}], estimatedComplexity, prerequisites }` — flat, no
phases, no acceptance criteria, no verify command.

Because there is no plan, the post-debate options are generated from the synthesis' single
`recommendation` field. In this session that was *"thêm E2E sentinel test, rồi mới…"* — exactly
one next step. P1 therefore requires a fresh council.

### RC3 — the implement handoff is prose, and prose gets re-classified

`postDebateContinuation` returns a prose block ("Council debate completed. Approved conclusion:
… Implement this now …", `index.ts:369-379`). At 13,966 chars it re-enters the PIL pipeline and
is classified `taskType=analyze, deliverable=report` (row 2498), with layer4 emitting
`route=none, blocking=false`. The turn runs as a report turn against `planVerified: false`.

The fix already exists elsewhere in the codebase. `src/pil/pipeline.ts:167-177`:

```ts
const sprintPlanExecution = isSprintPlanExecution(ctx.raw);
if (sprintPlanExecution) {
  ctx = { ...ctx, directAnswer: false, deliverableKind: "code",
          modelDepthTier: ctx.modelDepthTier ?? "standard" };
}
```

`/ideal`'s sprint-runner earns this by embedding `SPRINT_EXECUTION_MARKER` in
`IMPL_EXECUTION_DIRECTIVE` (`src/product-loop/sprint-runner.ts:205-214`). The council
continuation carries no marker, so it gets none of this.

### What already exists and is not wired in

`src/gsd/plan-council.ts` already runs N reviewers over `.planning/PLAN.md`, merges structured
verdicts (`approve | revise | block` via `src/gsd/verdict-schema.ts`), writes `PLAN-REVIEW.md`,
and sets `planVerified` in `STATE.md`. `resolvePlanCouncilLeader` (`src/council/leader.ts`)
resolves its leader. Retry budget: `getPlanReviewDebateRetries` (`src/gsd/flags.ts`).

The plan-review machinery is not missing. It is simply not reachable from a `/council` debate,
and its reviewers have no debate context.

## Design

### D1 — intent gate merged into the launch card

`buildLaunchCard` gains an **Intent** block rendered above the existing Panel/Rounds/Cost rows.
One screen, one extra choice, no second modal.

- Options are **leader-authored per topic**: the leader proposes the 2–3 `IntentKind` values that
  actually fit, each with a topic-specific label and description; the remaining kinds are offered
  as secondary choices. No hardcoded label table in production code — the option set derives from
  the `IntentKind` union (`src/council/types.ts:294-300`) and the leader's proposal.
- The user's informal vocabulary maps onto the existing union — no kind is added: "implement" →
  `implementation_plan` or `action_items`, "debug" → `investigation`, "chốt phương án" →
  `decision`, "đánh giá" → `evaluation`, "hỏi cho rõ" → `resolve_question`. A topic that is not a
  council topic at all (chitchat) resolves through the existing `Cancel` option.
- `Cheap run / Refine the topic first / Cancel` are unchanged.

The answer **locks `spec.intentKind` for the whole run**.

> **Correction (2026-08-06, whole-branch review).** This paragraph originally claimed the lock
> drives "`outputShape`, panel composition, whether the planner phase runs, and the post-debate
> transition". Only the last is true as built, and it is not worth building the rest: the launch
> card fires **after** `debatePlan` is computed (`src/council/index.ts`, S1 gate), so both
> `outputShape` and the panel are already decided by the time the user answers. The lock's real
> and only consumers are in the post-debate block — `resolveRunKind`, which feeds
> `pickPostDebateRecommendation`, and through it whether the planner / plan-review / post-plan-card
> path runs. `src/council/types.ts` carries the same correction at the field. If a future change
> wants the lock to shape the debate itself, the card has to move before `planDebate`.

`synthesisOutputKind` (`index.ts:318-323`) stops being the source of truth. It remains only as a
fallback for runs that bypass the card (headless answers, `sprintPlanningMode`, resumed runs
whose spec predates this change).

### D2 — planner phase inside the council

Runs only when `isImplementationKind(spec.intentKind)` is true — i.e. `implementation_plan` or
`action_items` (`types.ts:311`). Analysis-shape runs skip it entirely and behave exactly as today.

New council phase after synthesis, emitting the usual `phaseStart / phaseDone` events:

1. **Planner writes the plan.** A planner stance — authored by the same `debate-planner` that
   authors the other stances — converts the synthesis plus the debate exchanges into
   `.planning/PLAN.md`. Structure: phases `P0..Pn`; each phase carries steps, the files it
   touches, acceptance criteria, and its verify command.
2. **The debate panelists cross-review it.** Reuses `plan-council.ts`'s perspective runner, but
   the reviewer set is the debate participants rather than the generic GSD perspectives — they
   already hold the debate context, which is what makes the review deep rather than a shape check.
   Each emits a structured verdict (`verdict-schema.ts`): `approve | revise | block` + concerns +
   evidence.
3. **The leader merges and decides.** `revise` → planner revises against the concerns, bounded by
   `getPlanReviewDebateRetries`. `block` → stop and surface the blocking concerns; no plan is
   locked. `approve` → write `.planning/PLAN-REVIEW.md` and `setStateField(planVerified: yes)`.

`ActionPlan` (`types.ts:269`) grows to match the artifact: phases, per-phase acceptance
criteria, per-phase verify command. It is currently too flat to represent a reviewed plan.

### D3 — post-plan card

Replaces the current post-debate card for implementation-shape runs. Shows:

- the plan path (`.planning/PLAN.md`)
- the phase list with each phase's acceptance criteria
- the leader's verdict and which reviewer concerns were resolved

Options: **Implement toàn bộ plan** / **Sửa plan** (the user's comments go back to the planner and
the review loop re-runs) / **Lưu và dừng**.

Analysis-shape runs keep today's post-debate card unchanged.

### D4 — plan-driven execution

The handoff stops being prose. The continuation carries an explicit execution envelope
— `{ mode: "execute-plan", planPath, phases[], depth }` — plus a marker recognised in
`src/pil/pipeline.ts` the same way `SPRINT_EXECUTION_MARKER` is, so PIL forces
`directAnswer: false, deliverableKind: "code"` regardless of how the classifier reads the plan
text. The council path gets its own marker rather than reusing the sprint one, so sprint
telemetry and council telemetry stay distinguishable.

Executor loop, per phase in order:

1. run the phase
2. verify against **that phase's** acceptance criteria and verify command
3. on pass — tick the phase in `PLAN.md`, continue to the next phase
4. on fail — **halt** with the failing criterion and the verifier output; do not continue

The loop ends when the plan is exhausted. P1/P2 live in the same plan as P0, so continuing past
P0 never requires a second council.

### D5 — remove the dead path

`generate_plan` currently returns the identical string to `implement` (`index.ts:369`), making it
a no-op alias. It becomes the real trigger for D2, or is removed if D3's card supersedes it.

The intent comment at `index.ts:366-368` is reversed, and the reversal is documented in place
with a pointer to this spec — the old position was deliberate and a future reader must see why it
changed.

## Out of scope

- **The stall observed at 01:28:15Z.** A `main` stream opened after a
  `stall_rescue {outcome:"no_text", toolResultCount:8, chars:0}` and emitted nothing for 6+
  minutes while both `bun` processes sat at ~1.8s cumulative CPU (idle — waiting on the network,
  not a blocked event loop). The 120s stall watchdog is petted by `reasoning-delta` chunks
  (`src/utils/settings.ts:1096-1103`) and the 300s progress watchdog
  (`settings.ts:1110-1117`) did not surface an abort. This is an independent provider/watchdog
  bug, not a council-flow bug. Track separately.
- **Panel sizing.** This run used 2 panelists. Not changed here.

## Testing

Unit:

- intent lock — a locked `intentKind` survives synthesis and is not overridden by
  `synthesisOutputKind`
- planner phase gating — skipped for every analysis-shape kind, runs for both implementation kinds
- verdict merge — `block` stops, `revise` re-enters the planner within the retry budget, `approve`
  sets `planVerified`
- `PLAN.md` phase parsing — phases, acceptance criteria, verify command round-trip
- marker recognition — the council execution envelope forces `directAnswer:false,
  deliverableKind:"code"` in `pipeline.ts`, mirroring the existing sprint-marker test
- executor halt — a failing phase verify halts and does not advance

Harness E2E (`tests/harness/`), spawned in a fresh temp cwd per the council-spec convention:

- launch card renders the intent block and the choice reaches the spec
- an implementation-intent run reaches the post-plan card with a real plan path
- an analysis-intent run never shows the plan phase
