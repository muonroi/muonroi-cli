# Phase Orchestrator (Subsystem E) — Design Spec

**Status:** Draft for review
**Date:** 2026-05-13
**Depends on:** B+C (Discovery + Project-Context) — already shipped through commits 6f944a4…0e4de32.
**Successor of:** the abandoned "gsd-bridge" idea — we now embed the gsd mindset directly in /ideal rather than export to a sidecar workspace.

---

## 1. Background

After Subsystem B+C, `/ideal` produces a `ProjectContext`, a `ClarifiedSpec`, and a `ProductRunManifest` at end-of-scoping. The current loop-driver then jumps straight into a flat `for sprint in 1..maxSprints` loop with no notion of phases, agile rituals, or context discipline. This loses three things a real agile team has:

1. **Phase decomposition** — successCriteria are tackled in one undifferentiated pile.
2. **Rituals** — no sprint review, retro, or standup. No customer-in-the-loop checkpoint.
3. **Context discipline** — conversationContext accumulates raw history, risking bloat and loss across resume.

Subsystem E adds a layer between scoping and the existing sprint loop that introduces phases, agile rituals, and a tiered context store. It leverages the existing council + leader infrastructure rather than reinventing it.

## 2. Goals

- After scoping, auto-generate a `PhasePlan` (3–5 phases) from `ClarifiedSpec` + `ProjectContext`.
- Iterate phases sequentially; each phase reuses the existing sprint loop scoped to its successCriteria subset.
- Wrap every sprint with: **review** (leader summary + user notification + accept/reject gate), **retro** (leader, lessons learned), and optionally **standup** (council Big-3) at phase boundaries or long resume gaps.
- Tiered context: project (permanent), phase digest (bounded, recency-decayed), sprint conversation (per-sprint, reset on end). Customer decisions stored verbatim, never summarized.
- Resume-safe: every artifact write is atomic + marker-gated; rebuild from disk after process boundary.
- Reuse `runDebate`, `resolveLeaderModel`, `createCouncilLLM`, `withRateLimitBackoff`, `audit-replay`, `cross-run-memory` digest helpers, `flow/artifact-io` section-map.

## 3. Non-Goals

- No Discord channel creation, stakeholder add, or external broadcast (subsystem F).
- No LLM-driven roadmap research (gsd-new-project–style) — phase-plan is a single leader call from existing context.
- No two-way feedback from sprint-runner verify back into phase-plan re-generation.
- No multi-tenant phase plans (one PhasePlan per runId).
- No customer multi-stakeholder voting; review is single-user accept/reject for now.

## 4. Architecture

### 4.1 Layer diagram

```
discovery (B+C, shipped)
   ↓ produces ProjectContext, ClarifiedSpec, manifest
scoping (existing)
   ↓
[E] generatePhasePlan          ← leader call, retry 3, 429 backoff, fallback to 1-phase
   ↓ writes phases.md
[E] runPhases (orchestrator)
   │
   ├─ for each phase ∈ phaseOrder:
   │    ├─ enterPhase (marker phase-N: in-progress; start phase-budget for "review"+"retro")
   │    ├─ for each sprint ∈ 1..maxSprintsPerPhase:
   │    │    ├─ buildSprintContext(projectContext, phaseHistory, phaseDigest, customerDecisions, sprintTail)
   │    │    ├─ sprint-runner (existing; takes phaseScope)
   │    │    ├─ done-gate per phase (criteria-met >= doneThreshold ∩ phase.successCriteria)
   │    │    ├─ generateSprintReview → PushNotification → marker "awaiting-customer-review:phase-N:sprint-K"
   │    │    ├─ block until resume with verdict; persist verdict to phases.md verbatim
   │    │    ├─ if reject: feedback → customerDecisions[]
   │    │    ├─ runRetro (leader) → digestSprintIntoPhase(phaseDigest, lessons)
   │    │    └─ continue or exit sprint loop
   │    ├─ handoffPhaseToNext → leader exit summary (≤300 chars) → phaseHistory[]
   │    └─ marker phase-N: done
   │
   └─ all phases done → product done-gate (existing) → verdict
```

Standup gate: at `runPhases` entry, check `state.last-activity-ts`. If `now - last > 1h` AND any phase in-progress, fire `runStandup` (council Big-3) before resuming the in-progress phase. Output appended once to next sprint conversationContext, not iterated.

### 4.2 Files

**New (4 files, flat in `src/product-loop/`):**

| File | Responsibility | LOC est. |
|---|---|---|
| `phase-plan.ts` | `generatePhasePlan(ctx) → PhasePlan`. Builds leader prompt from ProjectContext + ClarifiedSpec; calls `LeaderLike`; parses JSON; retries 3x with `withRateLimitBackoff`; fallback to single-phase plan that bundles all successCriteria. | ~120 |
| `phase-runner.ts` | Orchestrator. Reads PhasePlan + PhaseState markers, iterates phases, calls `sprint-runner` per sprint with `phaseScope`, wraps rituals, manages phases.md + state.md markers. | ~250 |
| `phase-rituals.ts` | Three thin adapters: `generateSprintReview` (leader call → review summary string), `runRetro` (leader call → `LessonsLearned`), `runStandup` (council Big-3 via `runDebate`, audit via `audit-replay`). | ~180 |
| `context-policy.ts` | Tiered context functions: `buildSprintContext({projectContext, phaseHistory, phaseDigest, customerDecisions, sprintTail}, caps) → string`; `digestSprintIntoPhase(phaseDigest, lessonEntry, ts) → newDigest`; `handoffPhaseToNext(ctx) → phaseExitSummary` (leader call). Hard caps enforced with `[…truncated N bytes]` markers. | ~150 |

**Modified:**

- `loop-driver.ts` — after scoping commit, replace `for sprint in 1..maxSprints` block with `await runPhases({...})`. Add standup-gate at entry.
- `sprint-runner.ts` — accept optional `phaseScope: { criteria: string[]; scope: string }`. When present, done-gate evaluation filters criteria to that subset; conversationContext is scoped by `context-policy.buildSprintContext` rather than naive concat.
- `types.ts` — add `Phase`, `PhasePlan`, `PhaseState`, `LessonsLearned`, `StandupOutcome`, `CustomerDecision`, `PhaseHistoryEntry`, `PhaseDigestEntry`.
- `phase-budget.ts` — extend `PHASE_HINTS` to `{discover:0.05, gather:0.10, research:0.30, scoping:0.10, sprint:0.30, review:0.05, retro:0.05, planning:0.05}` (sums to 1.0; "planning" is one-shot phase-plan gen, "review"/"retro" aggregate across all sprints).
- `artifact-io.ts` (product-loop barrel) — re-export `readPhasePlan`, `writePhasePlan`, `markPhaseStatus`.

### 4.3 Storage layout

```
.flow/runs/<runId>/
  manifest.md           (existing — adds PhaseModeEnabled: true)
  iterations.md         (existing — Sprint N entries unchanged)
  gray-areas.md         (existing)
  project-context.md    (B+C output)
  discovery.json        (B+C, schema-versioned)
  state.md              (existing; adds sections: "Phase Plan State", "Customer Decisions", "Phase Digest", "Phase History", "Last Activity")
  phases.md             (NEW — section-map; sections: "Plan", "Phase 1 State", "Phase 1 Sprint K Review", "Phase 1 Sprint K Retro", "Standup K", …)
  .audit/               (existing council audit dir; standup writes here via audit-replay)
```

State markers (sections in `state.md`, JSON value per section, section-map abstraction not raw atomicWrite):
- `Phase Plan State` — `{ version: 1, currentPhaseId, phasesStatus: Record<phaseId, "pending"|"in-progress"|"done">, lastActivityUtc }`
- `Customer Decisions` — `{ version: 1, items: CustomerDecision[] }` (versioned envelope)
- `Phase Digest` — `Record<phaseId, { version: 1, entries: PhaseDigestEntry[] }>` (per-phase)
- `Phase History` — `{ version: 1, entries: PhaseHistoryEntry[] }` (all exited phases)

## 5. Schemas

### 5.1 PhasePlan (typed-artifact, versioned envelope per P8 pattern)

```ts
interface PhasePlanArtifact {
  version: 1;
  generatedAt: string;        // ISO 8601 UTC
  phases: Phase[];
}

interface Phase {
  id: string;                 // "phase-1", monotonic
  name: string;               // human-readable, ≤80 chars
  goal: string;               // one line, ≤200 chars
  successCriteria: string[];  // subset of ClarifiedSpec.successCriteria (verbatim strings)
  scope: string;              // in/out scope; ≤300 chars
  exitCondition: {
    type: "criteria-threshold";
    min: number;              // 0.0–1.0; defaults to manifest.doneThreshold
  };
  dependsOn: string[];        // phase IDs; planner must produce a DAG (no cycles)
  maxSprints: number;         // soft cap per phase; default ceil(manifest.maxSprints / phases.length)
}
```

**Validation:**
- `phases.length` in [1, 6]; reject and fallback otherwise.
- All `successCriteria` entries must be substrings of `ClarifiedSpec.successCriteria` (string-exact match after `.trim()`). Reject and fallback if any drifts.
- Union of all `phases[i].successCriteria` must cover ≥90% of `ClarifiedSpec.successCriteria` (count). Coverage gap accepted only if < 10% — reject otherwise.
- `dependsOn` references must resolve; cycle detection via DFS.
- All `successCriteria` from ClarifiedSpec MUST be present in at least one phase (unless explicitly deferred — but deferral requires a "deferred" section in phases.md). For v1, hard-require full coverage.

### 5.2 LessonsLearned, StandupOutcome, CustomerDecision

```ts
interface LessonsLearned {
  wentWell: string[];          // ≤5 entries, each ≤200 chars
  toImprove: string[];         // ≤5 entries, each ≤200 chars
  nextSprintFocus: string;     // ≤300 chars
}

interface StandupOutcome {
  blockers: string[];          // ≤5 entries, each ≤200 chars
  decisions: string[];         // ≤5 entries, each ≤200 chars
  nextStep: string;            // ≤300 chars
}

interface CustomerDecision {
  seq: number;                 // monotonic, max(existing.seq)+1
  timestampUtc: string;
  phaseId: string;
  sprintN: number;
  verdict: "accept" | "reject" | "abort";
  feedback?: string;           // verbatim user text; not summarized
}

interface PhaseHistoryEntry {
  phaseId: string;
  exitedAtUtc: string;
  exitSummary: string;         // ≤300 chars; output of handoffPhaseToNext leader call
  sprintsExecuted: number;
  criteriaMetCount: number;
}

interface PhaseDigestEntry {
  sprintN: number;
  timestampUtc: string;
  lessonText: string;          // ≤500 chars; output of digestSprintIntoPhase
}
```

### 5.3 Context layers + caps

```ts
const CONTEXT_CAPS = {
  SPRINT_CONTEXT_BYTES: 8192,
  PHASE_DIGEST_BYTES: 4096,
  PHASE_HISTORY_BYTES: 2048,
  CUSTOMER_DECISIONS_BYTES: 4096,
} as const;
```

`buildSprintContext` returns a string of the form:

```
## Project (permanent)
<project-context.md formatted, projectContextFmt from B+C>

## Phase History (exited phases, recency-weighted)
- phase-1 (exited 2026-05-13T…): <exitSummary>
- …

## Current Phase
Goal: …
SuccessCriteria: …
Scope: …

## Phase Digest (lessons accrued this phase)
- sprint 1 (2026-05-13T…): <lessonText>
- …

## Customer Decisions (verbatim, never summarized)
- seq 1, sprint 1, ACCEPT
- seq 2, sprint 2, REJECT: <feedback>
- …

## Sprint Tail (last K iterations of current sprint)
<iterations.md tail rendered>
```

Each layer trimmed independently; if final concat exceeds `SPRINT_CONTEXT_BYTES`, trim layers from the bottom in this priority order (least-important first): SprintTail → PhaseDigest (oldest entries first via recency-weighted) → PhaseHistory (oldest first). Project and Customer Decisions are **never trimmed** — if they alone exceed the cap, return them with a `[oversize: ProjectContext alone is N bytes — raise cap]` marker. This is a configuration error, not a runtime decision.

### 5.4 Recency-weighted decay (phase digest)

When `PHASE_DIGEST_BYTES` cap exceeded, drop oldest entries until under cap. Weight is purely positional (oldest first); no LLM call to decide. Marker `[digest pruned: K entries dropped]` appended once.

## 6. Algorithms

### 6.1 generatePhasePlan

```ts
async function generatePhasePlan(args: {
  projectContext: ProjectContext;
  clarifiedSpec: ClarifiedSpec;
  manifest: ProductRunManifest;
  leader: LeaderLike;
  capUsd: number;
}): Promise<PhasePlanArtifact> {
  const prompt = buildPhasePlannerPrompt(args);
  const costFloor = Math.max(1.50, 0.10 * args.capUsd);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await withRateLimitBackoff(() =>
        args.leader({ system: PHASE_PLANNER_SYSTEM, prompt, maxTokens: 1500 })
      );
      const parsed = parsePhasePlanJson(raw);          // strip code fences, JSON.parse
      validatePhasePlan(parsed, args.clarifiedSpec);   // throws on validation failure
      return parsed;
    } catch (e) {
      if (attempt === 2) break;
    }
  }
  return fallbackSinglePhase(args.clarifiedSpec, args.manifest);
}

function fallbackSinglePhase(spec: ClarifiedSpec, m: ProductRunManifest): PhasePlanArtifact {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    phases: [{
      id: "phase-1",
      name: "Full Scope",
      goal: spec.problemStatement.slice(0, 200),
      successCriteria: spec.successCriteria,
      scope: spec.scope.slice(0, 300),
      exitCondition: { type: "criteria-threshold", min: m.doneThreshold },
      dependsOn: [],
      maxSprints: m.maxSprints,
    }],
  };
}
```

### 6.2 runPhases (orchestrator skeleton)

```ts
async function* runPhases(args: RunPhasesOptions): AsyncGenerator<StreamChunk, ProductVerdict> {
  // Standup gate on entry
  const lastActivity = await readLastActivity(args.flowDir, args.runId);
  if (await shouldRunStandup(lastActivity)) {
    const standup = yield* runStandup({ ...args });
    appendStandupToContext(args.flowDir, args.runId, standup);
  }

  let plan = await readPhasePlan(args.flowDir, args.runId);
  if (!plan) {
    plan = await generatePhasePlan({ ...args });
    await writePhasePlan(args.flowDir, args.runId, plan);
  }

  for (const phase of plan.phases) {
    const status = await readPhaseStatus(args.flowDir, args.runId, phase.id);
    if (status === "done") continue;
    if (!await dependsResolved(plan, phase, args)) {
      yield warning(`Phase ${phase.id} blocked by unresolved deps`);
      continue;
    }
    await markPhaseStatus(args.flowDir, args.runId, phase.id, "in-progress");

    for (let sprintN = 1; sprintN <= phase.maxSprints; sprintN++) {
      const phaseScope = { criteria: phase.successCriteria, scope: phase.scope };
      const ctxStr = await buildSprintContext({ ...args, phase, sprintN });
      yield* sprintRunner({ ...args, sprintN, phaseScope, conversationContext: ctxStr });

      const review = await generateSprintReview({ ...args, phase, sprintN });
      await writeReviewArtifact(args.flowDir, args.runId, phase.id, sprintN, review);
      await emitPushNotification(review.summary);
      await markAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);

      const verdict = await awaitCustomerVerdict(args.flowDir, args.runId);
      await appendCustomerDecision(args.flowDir, args.runId, { phaseId: phase.id, sprintN, ...verdict });
      if (verdict.verdict === "abort") return { pass: false, reason: "user-aborted" };

      const lessons = await runRetro({ ...args, phase, sprintN, verdict });
      await digestSprintIntoPhase(args.flowDir, args.runId, phase.id, lessons, sprintN);

      if (await phaseExitConditionMet(args.flowDir, args.runId, phase)) break;
    }

    const exitSummary = await handoffPhaseToNext({ ...args, phase });
    await appendPhaseHistory(args.flowDir, args.runId, { phaseId: phase.id, exitSummary, ... });
    await markPhaseStatus(args.flowDir, args.runId, phase.id, "done");
  }

  return await runProductDoneGate({ ...args });
}
```

### 6.3 Cost guards & circuit breakers

- **Per call:** `withRateLimitBackoff` (1s/4s/16s) wraps every LLM call inside phase-plan / review / retro / standup.
- **Per phase:** soft budget = phase-budget hint × 1.5 (warning only; CB-1 still owns hard stop).
- **Plan-gen floor:** `max($1.50, 0.10 × capUsd)` — refuse to call planner if remaining budget below floor; fallback to single-phase plan immediately.
- **Review/retro:** combined floor `max($0.50, 0.04 × capUsd)` per phase, not per sprint (allows skipping later-sprint rituals if budget tight).
- **Standup:** floor `max($1.00, 0.05 × capUsd)`. If below, skip standup and log warning.
- **Customer wait timeout:** no auto-accept. `awaitCustomerVerdict` blocks indefinitely; resume re-checks marker on next /ideal invocation. Users explicitly opted out of "auto-accept after X minutes" earlier.

### 6.4 Resume protocol

On `/ideal --resume <runId>`:

1. Read `state.md` → `Phase Plan State`. If absent → not yet entered phase mode → resume legacy path.
2. Read `Last Activity`. If `> 1h` and any phase `in-progress` → run standup; persist outcome to `phases.md`; append to context for next sprint.
3. Locate `Phase Plan State.currentPhaseId`. Find first phase with status `in-progress` or `pending` (deps resolved).
4. In that phase, check `awaiting-customer-review` marker. If present → prompt user for verdict via TUI; persist; continue to retro.
5. Otherwise → resume sprint loop at next sprint (current sprintN = last completed + 1).
6. Rebuild conversationContext from disk only (no in-memory state trusted).

### 6.5 Standup gate semantics

```ts
async function shouldRunStandup(lastActivityUtc: string | null): Promise<boolean> {
  if (!lastActivityUtc) return false;
  const elapsedMs = Date.now() - new Date(lastActivityUtc).getTime();
  return elapsedMs > 60 * 60 * 1000; // 1h
}
```

Standup uses council Big-3 stances (`pragmatist`, `scaler`, `cost-optimizer` — already defined in council). Seed `conversationContext` for the debate = `projectContext + phaseHistory + currentPhaseDigest + lastSprintTail`. Output single `StandupOutcome` digested to ≤500 chars and appended to next sprint context.

## 7. Error handling

| Failure | Behavior | Marker / log |
|---|---|---|
| Phase-plan JSON parse fail 3x | Fallback to 1-phase plan; warn | `state.md` → `Plan Fallback: true` |
| Phase-plan validation fail (coverage <90%, cycle, etc.) | Fallback to 1-phase | Same |
| HTTP 429 on any LLM call | `withRateLimitBackoff` (1s/4s/16s); after 3 attempts → caller's fallback or skip ritual | n/a (logged) |
| Sprint review leader fail | Use fallback summary: scoreBefore→scoreAfter + criteria deltas (no LLM) | `Review Fallback: true` per sprint |
| Retro fail | Skip retro for this sprint; next sprint context still includes phase digest | `Retro Skipped: sprint-K` |
| Standup fail | Skip standup; warn user; proceed | `Standup Skipped` |
| Customer verdict timeout | Block indefinitely (no auto-accept) | `Awaiting Customer Review` marker stays |
| Crash mid-sprint | Resume re-reads iterations.md; sprint tail intact; lessons not yet digested → retry on resume | n/a (state.md atomic) |
| Crash mid-digest write | atomic rename either applied or not; lesson re-derivable from retro on next attempt | Idempotent |
| Phase plan corrupted JSON in phases.md | Fallback to 1-phase; preserve corrupt file as `phases.md.corrupt-<ts>` | `Plan Corrupt: <path>` |
| Concurrent /ideal on same runId | Acquire `.phases.lock` (same pattern as `.discovery.lock` in B+C); refuse second start | Lock file exists |

## 8. Testing strategy

Target: ≥92% line coverage on new files; 100% on `phase-runner.ts` and `context-policy.ts` (most error-prone).

Test categories (74 cases total, grouped):

**Phase-plan (`phase-plan.test.ts`, ~12 cases):**
- Happy path: 3-phase plan from real ClarifiedSpec → all criteria covered.
- Validation: phases.length=0 → fallback. phases.length=7 → fallback. Drifted successCriteria string → fallback. Cycle in dependsOn → fallback. Coverage <90% → fallback.
- Retry: leader returns malformed JSON twice, valid JSON 3rd → success after 2 retries.
- 429: leader throws 429 once → backoff 1s → success. Three 429s → fallback.
- Cost-floor: capUsd=$5 (floor=$1.50) and remaining=$1.00 → skip planner, immediate fallback. No leader call counted.
- Fallback single-phase: contains all successCriteria verbatim; exitCondition.min === manifest.doneThreshold.

**Phase-runner (`phase-runner.test.ts`, ~20 cases):**
- Iterates phases in order; depends-on respected.
- Skips already-done phases on resume.
- awaiting-customer-review marker blocks until verdict written.
- Customer reject → feedback appended to customerDecisions[]; not summarized.
- Customer abort → returns verdict pass:false; no further phases attempted.
- Phase exit condition: criteria-met >= min → break sprint loop; otherwise continue up to maxSprints.
- All phases done → product done-gate runs.
- Marker idempotency: re-write `in-progress` over existing `in-progress` is no-op.
- Lockfile prevents concurrent run.

**Rituals (`phase-rituals.test.ts`, ~15 cases):**
- generateSprintReview: leader returns summary; PushNotification called once; marker set.
- generateSprintReview leader fails → fallback summary used; marker still set.
- runRetro: returns LessonsLearned shape; counts enforced (≤5 entries, ≤200 chars each).
- runRetro leader fails → skip; phase digest unchanged.
- runStandup: council debate with Big-3 stances; audit written via audit-replay.
- runStandup council fails → skip; warn; no marker.
- Standup gate: lastActivity 30min ago → no fire. 2h ago + in-progress → fire. 2h ago + no in-progress phase → no fire.

**Context policy (`context-policy.test.ts`, ~15 cases):**
- buildSprintContext: all layers present, under cap → exact format match.
- Over cap → trim SprintTail first; truncation marker visible.
- Over cap after dropping SprintTail → trim oldest PhaseDigest entries.
- Project alone over cap → return with oversize marker (config error).
- Customer decisions never trimmed even if forced to truncate.
- digestSprintIntoPhase: append entry; bytes-cap → drop oldest 25%, marker added.
- handoffPhaseToNext: leader call generates exitSummary ≤300 chars; appended to phaseHistory.
- handoffPhaseToNext leader fails → use deterministic fallback: "phase X exited after N sprints, M/K criteria met".

**Integration (`phase-orchestrator-integration.test.ts`, ~8 cases):**
- End-to-end: 2-phase plan → sprint 1 → review → retro → sprint 2 → phase done → handoff → phase 2 sprint 1 → … → product done.
- Crash + resume: kill after retro write but before phase done marker → resume re-reads markers → continues from next sprint.
- Crash + resume mid-customer-review: marker `awaiting-customer-review` present → resume prompts user → continues.
- Stale resume: lastActivity 2h ago → standup fires before sprint resumes.
- Cost-cap: total budget exhausted mid-phase-2 → CB-1 hard-stops; phaseState reflects "blocked-budget".

**Edge cases (`phase-edge-cases.test.ts`, ~4 cases):**
- phases.md corrupt JSON → fallback + backup file written.
- Customer decisions section contains 500 entries → no panic, render bounded.
- All criteria deferred (none in any phase) → validation rejects → fallback.
- Schema v0 → v1 migration: future-proof for one schema bump.

## 9. Downstream integration

- **Sprint-runner:** unchanged core; accepts `phaseScope` optional. Done-gate filters criteria to phase subset when present.
- **Loop-driver:** after scoping, calls `runPhases(...)` instead of the existing flat sprint loop. Legacy flat-loop path retained behind feature flag `MUONROI_PHASE_MODE=0` for one minor version; default-on.
- **Audit:** standup council debates write to `.audit/<runId>/` via existing `audit-replay.ts` infra.
- **PushNotification:** review fires single notification per sprint; suppressed when stdin not a TTY (CI safe).

## 10. Open questions

None at spec-write time. All architectural decisions auto-picked per user directive; ambiguity to be surfaced by review agents.

## 11. Acceptance criteria

- /ideal "build X" with no further user input progresses through discovery → scoping → phase plan (3–5 phases) → phase 1 sprint 1 → review notification fires → user verdict captured → retro → sprint 2 … → phase done → next phase → … → product done — without re-prompting for context.
- Crash kill -9 at any point → /ideal --resume continues from last committed marker; no duplicate sprint, no lost lesson, no lost customer feedback.
- Sprint context never exceeds 8KB; phase digest never exceeds 4KB; project/customer-decisions never trimmed (or oversize marker visible).
- Total LLM cost adds $1.50–$3.50 on top of B+C for a typical 3-phase × 2-sprint run.
- All existing tests pass; new test suite green; coverage ≥92%.

## 12. Schema migration registry

```ts
const PHASE_PLAN_MIGRATORS: Record<number, Migrator> = {
  0: (raw) => ({ ...raw, version: 1, generatedAt: raw.generatedAt ?? new Date().toISOString() }),
  1: (raw) => raw,
};
```

Bump version on any breaking change to PhasePlan, CustomerDecision, PhaseDigestEntry, PhaseHistoryEntry. Unknown future version → log warning + return null + treat as missing (will regenerate).

---

**End of spec.**
