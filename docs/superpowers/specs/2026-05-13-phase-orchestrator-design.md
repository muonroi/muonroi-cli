# Phase Orchestrator (Subsystem E) — Design Spec

**Status:** Reviewed, revised after 4-agent cross-review
**Date:** 2026-05-13 (revised)
**Depends on:** B+C (Discovery + Project-Context) — shipped through commits 6f944a4…0e4de32.
**Supersedes:** the abandoned "gsd-bridge" idea. We embed the gsd mindset directly in /ideal rather than export to a sidecar workspace.

---

## 1. Background

After B+C, `/ideal` produces a `ProjectContext`, a `ClarifiedSpec`, and a `ProductRunManifest` at end-of-scoping. The current loop-driver then jumps straight into a flat `for sprint in 1..maxSprints` loop with no notion of phases, agile rituals, or context discipline. This loses three things a real agile team has:

1. **Phase decomposition** — successCriteria are tackled in one undifferentiated pile.
2. **Rituals** — no sprint review, retro, or standup. No customer-in-the-loop checkpoint.
3. **Context discipline** — conversationContext accumulates raw history, risking bloat and loss across resume.

E adds a layer between scoping and the existing sprint loop. It introduces phases, agile rituals, and a tiered context store. It leverages existing council + leader + storage infrastructure rather than reinventing.

## 2. Goals

- Auto-generate a `PhasePlan` (3–5 phases) from `ClarifiedSpec` + `ProjectContext` after scoping.
- Iterate phases; each phase reuses the existing sprint loop scoped to its successCriteria subset.
- Wrap every sprint with: **review** (leader summary + user notification via StreamChunk + accept/reject gate), **retro** (leader, lessons learned), and optionally **standup** (council Big-3) on long resume gaps with at least one in-progress phase.
- Tiered context: project (permanent), phase digest (bounded, oldest-first decay), sprint conversation (per-sprint, reset on end). Customer decisions stored verbatim.
- Resume-safe: every artifact write is atomic + marker-gated; rebuild from disk after process boundary.
- Reuse: `runDebate`, `resolveLeaderModel`, `createCouncilLLM`, `LeaderLike`, `withRateLimitBackoff` from B+C; `appendSystemMessage` for audit; `role-memory`'s oldest-first byte-cap truncation pattern for phase-digest; `flow/artifact-io` section-map; `storage/atomic-io` for atomic writes.

## 3. Non-Goals

- No Discord channel creation, stakeholder add, external broadcast (subsystem F).
- No LLM-driven roadmap research (gsd-new-project-style) — phase-plan is a single leader call from existing context.
- No two-way feedback from sprint-runner verify back into phase-plan re-generation.
- No multi-tenant phase plans (one PhasePlan per runId).
- No multi-stakeholder voting; customer review is single-user accept/reject.

## 4. Architecture

### 4.1 Layer diagram

```
discovery (B+C) → scoping (existing)
   ↓
[E] generatePhasePlan          ← leader call, retry 3, 429 backoff, fallback 1-phase
   ↓ writes phases.md
[E] runPhases (orchestrator)
   │
   ├─ entry: standup-gate
   │    fires only when:
   │      lastActivityUtc != null AND now - last > 1h AND hasAnyPhaseInProgress()
   │
   ├─ on resume: validatePhasePlan(loaded, currentClarifiedSpec)
   │    fail → backup phases.md → fallback 1-phase
   │
   ├─ for each phase ∈ plan.phases (in DAG order):
   │    ├─ skip if phasesStatus[phase.id] === "done"
   │    ├─ deps unresolved → mark "blocked"; continue
   │    ├─ markPhaseStatus(phase, "in-progress")
   │    ├─ for sprintN in 1..phase.maxSprints (sprintN resets per phase):
   │    │    ├─ buildSprintContext(layers, caps)
   │    │    ├─ sprint-runner (existing) with phaseScope
   │    │    ├─ done-gate per-phase (criteria-met ≥ exitCondition.min ∩ phase.successCriteria)
   │    │    ├─ generateSprintReview → write review artifact → release lock →
   │    │    │   yield StreamChunk { type: "push_notification", content: summary } →
   │    │    │   mark "awaiting-customer-review:phase-N:sprint-K"
   │    │    ├─ awaitCustomerVerdict (injected seam; blocks indefinitely; no auto-accept)
   │    │    ├─ re-acquire lock; persist CustomerDecision verbatim
   │    │    ├─ if verdict.verdict === "abort": return { pass: false, reason: "user-aborted" }
   │    │    ├─ mark "retro-pending:phase-N:sprint-K"
   │    │    ├─ runRetro (leader) → LessonsLearned
   │    │    ├─ digestSprintIntoPhase(phaseDigest, lessons)  ← atomic write
   │    │    ├─ clear "retro-pending" marker  ← only after digest atomic-rename succeeds
   │    │    └─ if phase exit condition met → break sprint loop
   │    ├─ handoffPhaseToNext → exitSummary (leader, ≤300 chars; deterministic fallback on fail)
   │    ├─ append phaseHistory[]
   │    └─ markPhaseStatus(phase, "done")
   │
   ├─ post-loop deadlock check:
   │    if any phase ended in "pending" or "blocked"
   │      → return { pass: false, reason: "phases-deadlocked: <ids>" }
   │
   └─ all done → product done-gate (existing) → verdict
```

Resume protocol details in §6.4. Lock semantics in §6.6.

### 4.2 Files

**New (4 files, flat in `src/product-loop/`):**

| File | Responsibility | LOC est. |
|---|---|---|
| `phase-plan.ts` | `generatePhasePlan(args) → PhasePlanArtifact`. Builds leader prompt; calls `LeaderLike.generate({system,prompt,maxTokens})` returning `{content,costUsd}`; parses content; retries 3x via `withRateLimitBackoff`; fallback to single-phase. | ~140 |
| `phase-runner.ts` | Orchestrator. Reads PhasePlan + PhaseState markers, iterates phases, calls `sprint-runner` per sprint with `phaseScope`, wraps rituals, manages phases.md + state.md markers. Injects `awaitCustomerVerdict` as a seam for tests. | ~280 |
| `phase-rituals.ts` | Three thin adapters: `generateSprintReview` (leader call → summary), `runRetro` (leader call → `LessonsLearned`), `runStandup` (council Big-3 via `runDebate`, audit via `appendSystemMessage`). | ~200 |
| `context-policy.ts` | `buildSprintContext`, `digestSprintIntoPhase` (oldest-first decay à la `role-memory`), `handoffPhaseToNext`. Hard caps with `[…truncated N bytes]` markers; project+customer-decisions are a single never-trim block. | ~170 |

**Modified:**

- `loop-driver.ts` — after scoping commit, replace flat sprint loop with `await runPhases({...})`. Add standup-gate at entry.
- `sprint-runner.ts` — accept optional `phaseScope: { criteria: string[]; scope: string }`. When present, done-gate filters criteria to phase subset; conversationContext is built by `context-policy.buildSprintContext` rather than naive concat.
- `types.ts` — add `Phase`, `PhasePlanArtifact`, `PhaseState`, `LessonsLearned`, `StandupOutcome`, `CustomerDecision`, `PhaseHistoryEntry`, `PhaseDigestEntry`. Add `StreamChunk` variant `{ type: "push_notification"; content: string }`.
- `phase-budget.ts` — extend `Phase` discriminated union from `"discover"|"gather"|"research"|"scoping"|"sprint"` to also include `"planning"|"review"|"retro"|"standup"`. Rebalance `PHASE_HINTS` (see §5.5). Add `SCHEMA_VERSION: 2` to `BudgetState`; on read, skip persisted records with `schemaVersion < 2` (or absent) and log one warning per resume.
- `artifact-io.ts` (product-loop barrel) — re-export `readPhasePlan`, `writePhasePlan`, `markPhaseStatus`.

### 4.3 Storage layout

```
.flow/runs/<runId>/
  manifest.md           (adds PhaseModeEnabled: true)
  iterations.md         (existing, unchanged shape)
  gray-areas.md         (existing)
  project-context.md    (B+C output)
  discovery.json        (B+C, schema-versioned)
  state.md              (existing; adds sections "Phase Plan State", "Customer Decisions",
                         "Phase Digest", "Phase History", "Last Activity")
  phases.md             (NEW — section-map: "Plan", "Phase N State",
                         "Phase N Sprint K Review", "Phase N Sprint K Retro",
                         "Standup K")
  .phases.lock          (NEW lockfile; same pattern as .discovery.lock)
  .audit/<sessionId>.md (existing council audit; standup writes appendSystemMessage entries)
```

State markers (each section in `state.md` is JSON content per section-map convention; no raw `atomicWriteText` on state.md — go through `readArtifact`/`writeArtifact`):

- `Phase Plan State` — `{ version: 1, currentPhaseId, phasesStatus: Record<phaseId, "pending"|"in-progress"|"done"|"blocked">, lastActivityUtc }`
- `Customer Decisions` — `{ version: 1, items: CustomerDecision[] }` (P8 versioned envelope)
- `Phase Digest` — `Record<phaseId, { version: 1, entries: PhaseDigestEntry[] }>`
- `Phase History` — `{ version: 1, entries: PhaseHistoryEntry[] }`
- `Plan Fallback` / `Plan Corrupt: <path>` / `Review Fallback: sprint-K` / `Retro Skipped: sprint-K` / `Standup Skipped: <reason>` — diagnostic flags

Sprint-K markers (transient, written atomically, cleared at end of sprint):
- `awaiting-customer-review:phase-N:sprint-K` — set after review artifact write, cleared after verdict captured
- `retro-pending:phase-N:sprint-K` — set after verdict captured, cleared after digest atomic-rename succeeds

## 5. Schemas

### 5.1 PhasePlanArtifact

```ts
interface PhasePlanArtifact {
  version: 1;
  generatedAt: string;        // ISO 8601 UTC
  phases: Phase[];
}

interface Phase {
  id: string;                 // "phase-1", monotonic 1-based
  name: string;               // ≤80 chars
  goal: string;               // ≤200 chars
  successCriteria: string[];  // subset of ClarifiedSpec.successCriteria; exact trimmed match required
  scope: string;              // in/out scope; ≤300 chars
  exitCondition: { type: "criteria-threshold"; min: number };  // 0.0–1.0
  dependsOn: string[];        // phase IDs forming a DAG; cycle detection by DFS
  maxSprints: number;         // soft cap per phase; default ceil(manifest.maxSprints / phases.length)
}
```

**Validation (executed at write AND on every resume):**

- `phases.length` ∈ [1, 6]; else fallback.
- Every `successCriteria` string MUST exact-match (after `.trim()`) a string in `ClarifiedSpec.successCriteria`. Drift → fallback.
- Union of all `phases[i].successCriteria` MUST cover 100% of `ClarifiedSpec.successCriteria` (count); coverage < 100% → fallback. (Tightened from 90% — partial coverage is too risky; partial deferral can be done explicitly in a future revision.)
- `dependsOn` references must resolve; cycle detection via DFS. Cycle → fallback.

### 5.2 LessonsLearned, StandupOutcome, CustomerDecision, PhaseHistoryEntry, PhaseDigestEntry

```ts
interface LessonsLearned {
  wentWell: string[];          // ≤5 entries, each ≤200 chars
  toImprove: string[];         // ≤5 entries, each ≤200 chars
  nextSprintFocus: string;     // ≤300 chars
}

interface StandupOutcome {
  blockers: string[];          // ≤5, each ≤200 chars
  decisions: string[];         // ≤5, each ≤200 chars
  nextStep: string;            // ≤300 chars
}

interface CustomerDecision {
  seq: number;                 // monotonic, max(existing.seq)+1
  timestampUtc: string;
  phaseId: string;
  sprintN: number;
  verdict: "accept" | "reject" | "abort";
  feedback?: string;           // verbatim user text; truncated only at INGRESS to ≤2000 chars with marker
}

interface PhaseHistoryEntry {
  phaseId: string;
  exitedAtUtc: string;
  exitSummary: string;         // ≤300 chars; leader output OR deterministic fallback
  sprintsExecuted: number;
  criteriaMetCount: number;
}

interface PhaseDigestEntry {
  sprintN: number;
  timestampUtc: string;
  lessonText: string;          // ≤500 chars
}
```

Customer-feedback verbatim is enforced AT INGRESS in the TUI prompt: if user enters > 2000 chars, truncate to 2000 with a `[…feedback truncated; full text in iterations.md]` marker AND mirror the full text to `iterations.md` Sprint N free-form block. This means downstream code can rely on ≤2000-char feedback and no separate cap is needed in state.md.

### 5.3 Context layers + caps

```ts
const CONTEXT_CAPS = {
  SPRINT_CONTEXT_BYTES: 8192,
  PHASE_DIGEST_BYTES: 4096,
  PHASE_HISTORY_BYTES: 2048,
} as const;
```

`buildSprintContext(layers, caps)` returns a string composed of the following blocks, in this order:

```
## Project (permanent)
<project-context.md formatted>

## Customer Decisions (verbatim, never summarized)
- seq 1, sprint 1: ACCEPT
- seq 2, sprint 2: REJECT — <feedback ≤2000 chars>
...

## Phase History
- phase-1 (exited <ts>): <exitSummary>
...

## Current Phase
Goal: ...
SuccessCriteria: ...
Scope: ...

## Phase Digest
- sprint 1 (<ts>): <lessonText>
...

## Sprint Tail
<iterations.md tail rendered>
```

**Cap enforcement (deterministic, no LLM):**

1. Compute `essentialSize = bytes(Project block + Customer Decisions block)`.
2. If `essentialSize > SPRINT_CONTEXT_BYTES`: return only Project + Customer Decisions + `[oversize: essential blocks alone = N bytes; raise SPRINT_CONTEXT_BYTES or trim project-context]` marker. No other blocks. This is a configuration error and surfaces visibly.
3. Otherwise: budget remaining = `SPRINT_CONTEXT_BYTES - essentialSize`. Fill from highest priority to lowest: Current Phase → Phase History → Phase Digest → Sprint Tail. Each block claims at most its proportional remaining-budget share; when a block exceeds its share, truncate from the end (oldest first for History/Digest, newest-tail for Sprint Tail keep recent) with `[…truncated N bytes]` marker.

Determinism guarantee: `buildSprintContext` is pure — same inputs → byte-for-byte identical output. Tested explicitly.

### 5.4 Phase digest oldest-first decay

Pattern from `src/product-loop/role-memory.ts` (positional, NOT `cross-run-memory.ts`'s Jaccard-weighted decay).

```ts
function digestSprintIntoPhase(digest: PhaseDigestEntry[], newEntry: PhaseDigestEntry): PhaseDigestEntry[] {
  const next = [...digest, newEntry];
  let bytes = jsonBytes(next);
  let dropped = 0;
  while (bytes > CONTEXT_CAPS.PHASE_DIGEST_BYTES && next.length > 1) {
    next.shift();
    dropped += 1;
    bytes = jsonBytes(next);
  }
  if (dropped > 0) next.unshift({ sprintN: -1, timestampUtc: new Date().toISOString(), lessonText: `[digest pruned: ${dropped} entries dropped, oldest-first]` });
  return next;
}
```

### 5.5 PHASE_HINTS (rebalanced)

```ts
const PHASE_HINTS: Record<Phase, number> = {
  discover:  0.05,
  gather:    0.10,
  research:  0.30,
  scoping:   0.10,
  sprint:    0.30,
  planning:  0.03,
  review:    0.03,
  retro:     0.04,
  standup:   0.05,
};
// sums to 1.00
```

Reasoning for new shares:
- planning: 0.03 (~$0.15 at cap=$5; one leader call ~$0.08–$0.15) — matches real call cost without forcing always-over-budget warning.
- review: 0.03 (per sprint at 0.005, but aggregated across phase budget at 0.03 covers ~6 sprints).
- retro: 0.04 (slightly larger output than review).
- standup: 0.05 (per occurrence ~$0.25–$0.55; budget allows ~3 standups for cap=$10).
- research dropped from 0.35→0.30, scoping from 0.15→0.10 to free 10% for the new categories.

The `BudgetState.SCHEMA_VERSION = 2`; persisted v1 records on read are skipped + one warning logged ("Phase Budget records from older schema discarded on resume").

## 6. Algorithms

### 6.1 generatePhasePlan

```ts
async function generatePhasePlan(args: {
  projectContext: ProjectContext;
  clarifiedSpec: ClarifiedSpec;
  manifest: ProductRunManifest;
  leader: LeaderLike;          // .generate({system,prompt,maxTokens}) → Promise<{content,costUsd}>
  capUsd: number;
  remainingUsd: number;
}): Promise<PhasePlanArtifact> {
  const floor = Math.max(0.20, 0.02 * args.capUsd);
  if (args.remainingUsd < floor) {
    return fallbackSinglePhase(args.clarifiedSpec, args.manifest);
  }
  const prompt = buildPhasePlannerPrompt(args);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await withRateLimitBackoff(() =>
        args.leader.generate({ system: PHASE_PLANNER_SYSTEM, prompt, maxTokens: 1500 })
      );
      const parsed = parsePhasePlanJson(res.content);
      validatePhasePlan(parsed, args.clarifiedSpec);
      return parsed;
    } catch (_e) {
      if (attempt === 2) break;
    }
  }
  return fallbackSinglePhase(args.clarifiedSpec, args.manifest);
}
```

Note correction (vs initial draft): `args.leader.generate(...)` returns `{ content, costUsd }`, not a bare string. Spec line code reflects the real `LeaderLike` interface in `src/product-loop/discovery-prompt-parser.ts:6-11`.

### 6.2 runPhases skeleton

```ts
async function* runPhases(args: RunPhasesOptions): AsyncGenerator<StreamChunk, ProductVerdict> {
  // Standup gate on entry (combined: time + in-progress)
  const last = await readLastActivity(args.flowDir, args.runId);
  if (await shouldRunStandup(last, args.flowDir, args.runId)) {
    const standup = yield* runStandup({ ...args });
    await persistStandupOutcome(args.flowDir, args.runId, standup);
  }

  let plan = await readPhasePlan(args.flowDir, args.runId);
  if (plan) {
    try {
      validatePhasePlan(plan, args.clarifiedSpec);
    } catch (_e) {
      // Spec drift or corruption on resume: backup + regenerate
      await backupCorruptPhases(args.flowDir, args.runId);
      plan = null;
    }
  }
  if (!plan) {
    plan = await generatePhasePlan({ ...args });
    await writePhasePlan(args.flowDir, args.runId, plan);
  }

  for (const phase of orderByDeps(plan.phases)) {
    const status = await readPhaseStatus(args.flowDir, args.runId, phase.id);
    if (status === "done") continue;
    if (!(await dependsResolved(args.flowDir, args.runId, plan, phase))) {
      await markPhaseStatus(args.flowDir, args.runId, phase.id, "blocked");
      continue;
    }
    await markPhaseStatus(args.flowDir, args.runId, phase.id, "in-progress");

    for (let sprintN = 1; sprintN <= phase.maxSprints; sprintN++) {  // sprintN resets per phase
      const phaseScope = { criteria: phase.successCriteria, scope: phase.scope };
      const ctxStr = await buildSprintContext({ ...args, phase, sprintN });
      yield* sprintRunner({ ...args, sprintN, phaseScope, conversationContext: ctxStr });

      // Review
      const review = await generateSprintReview({ ...args, phase, sprintN });
      await writeReviewArtifact(args.flowDir, args.runId, phase.id, sprintN, review);
      await releaseRunLock(args.flowDir, args.runId);              // F1: release before blocking
      yield { type: "push_notification", content: review.summary };
      await markAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);

      const verdict = await args.awaitCustomerVerdict(args.flowDir, args.runId);
      await acquireRunLock(args.flowDir, args.runId);              // F1: re-acquire after verdict
      await clearAwaitingCustomerReview(args.flowDir, args.runId);
      await appendCustomerDecision(args.flowDir, args.runId, { phaseId: phase.id, sprintN, ...verdict });
      if (verdict.verdict === "abort") return { pass: false, reason: "user-aborted" };

      // Retro — gated by retro-pending marker so resume can replay
      await markRetroPending(args.flowDir, args.runId, phase.id, sprintN);
      const lessons = await runRetro({ ...args, phase, sprintN, verdict });
      await digestSprintIntoPhase(args.flowDir, args.runId, phase.id, lessons, sprintN);
      await clearRetroPending(args.flowDir, args.runId, phase.id, sprintN);  // only after digest atomic-rename

      if (await phaseExitConditionMet(args.flowDir, args.runId, phase)) break;
    }

    const exitSummary = await handoffPhaseToNext({ ...args, phase });
    await appendPhaseHistory(args.flowDir, args.runId, { phaseId: phase.id, exitSummary, /*...*/ });
    await markPhaseStatus(args.flowDir, args.runId, phase.id, "done");
  }

  // F3 post-loop deadlock check
  const stuck = await collectStuckPhases(args.flowDir, args.runId);
  if (stuck.length > 0) {
    return { pass: false, reason: `phases-deadlocked: ${stuck.join(",")}` };
  }

  return await runProductDoneGate({ ...args });
}
```

PushNotification: spec emits a `StreamChunk { type: "push_notification", content }` for the top-level driver to surface. The actual side-effect is handled by the agent runtime, not the application code. The tool is not callable from inside `src/product-loop/*` modules.

### 6.3 Cost guards (revised)

| Operation | Floor formula | Rationale |
|---|---|---|
| `generatePhasePlan` | `max($0.20, 0.02 × capUsd)` | One leader call ~$0.08–$0.15; floor allows 1 retry headroom |
| `generateSprintReview` + `runRetro` combined | `max($0.12, 0.01 × capUsd)` **per sprint** | $0.04–$0.18 actual; floor allows one retry |
| `runStandup` | `max($0.60, 0.04 × capUsd)` | $0.25–$0.55 real; floor covers worst case |
| `handoffPhaseToNext` | `max($0.05, 0.005 × capUsd)` | ~$0.04–$0.08; deterministic fallback if below |

Standup hard cap: at most **3 standups per run**. Counted across resumes. Persisted as `Standup Count: N` section in state.md.

Per-call backoff: `withRateLimitBackoff` (1s, 4s, 16s; matches `discovery-recommender.ts:244-262`). After 3 exhausted attempts → caller's deterministic fallback.

Soft warnings: CB-1 fires when actual phase spend > hint × 1.5 (same as B+C); never hard-stops.

### 6.4 Resume protocol

On `/ideal --resume <runId>`:

1. Acquire `.phases.lock` (non-blocking). If held → refuse with "another run holds the lock; release with `/ideal --abort <runId>` if known-stale".
2. Read `state.md` → `Phase Plan State`. If absent → not yet in phase mode → release lock; resume legacy flat-sprint path.
3. Read `Phase Plan State.lastActivityUtc`. If gap > 1h AND any phase status === "in-progress" → fire standup; persist outcome; continue.
4. Read `phases.md` plan; run `validatePhasePlan(plan, currentClarifiedSpec)`. Fail (spec drift, corruption) → backup corrupt file + regenerate plan via §6.1.
5. Iterate phases in DAG order. Skip "done". For first non-done phase:
   - If `retro-pending:phase-N:sprint-K` marker present → replay retro from saved verdict (`Customer Decisions` last entry for that sprint) → digest → clear marker → advance to next sprint.
   - Else if `awaiting-customer-review:phase-N:sprint-K` marker present → release lock → prompt user verdict in TUI → re-acquire lock → write decision → proceed to retro.
   - Else → resume sprint loop at next sprint (`sprintN = max(completed) + 1`).
6. Rebuild `conversationContext` fresh from disk only. In-memory state never trusted across process boundary.

Sprint-N indexing resets per phase: phase-2's first sprint is `sprintN=1`, NOT a continuation of phase-1's counter. (Tested explicitly.)

### 6.5 Standup gate

```ts
async function shouldRunStandup(
  lastActivityUtc: string | null,
  flowDir: string,
  runId: string,
): Promise<boolean> {
  if (!lastActivityUtc) return false;
  const elapsedMs = Date.now() - new Date(lastActivityUtc).getTime();
  if (elapsedMs <= 60 * 60 * 1000) return false;  // strict > 1h
  return await hasAnyPhaseInProgress(flowDir, runId);
}
```

Boundary: `elapsedMs === 3_600_000` → false; `elapsedMs === 3_600_001` → still false (strict greater-than against 1h check is `<=`, so >1h means `elapsedMs > 3600000`). Tested.

Standup uses council Big-3 stances from `discovery-council-runner.ts:16-18` (`pragmatist`, `scaler`, `cost-optimizer`). Audit written via `appendSystemMessage` from `src/storage/index.ts` — NOT a nonexistent `audit-replay.ts`. Output `StandupOutcome` digested to ≤500 chars and appended to next sprint context.

### 6.6 Lock semantics (F1 fix)

The lock is **not** held during `awaitCustomerVerdict`. Lifecycle per sprint:

```
acquire lock at sprint start
  → sprint work, review write
  → release lock
  → emit push_notification
  → mark awaiting-customer-review
  → block on awaitCustomerVerdict (lock NOT held)
  → user runs `/ideal --resume <runId>` to enter verdict
    (resume acquires lock, writes verdict, releases lock, returns from awaitCustomerVerdict in original process via filesystem signal)
  → original process re-acquires lock
  → continue to retro
```

For single-process testing, `awaitCustomerVerdict` is an injected seam; tests resolve it immediately with a fake `CustomerDecision` so no actual filesystem polling is needed.

For multi-process production: the resume process drops a `verdict.json` adjacent to the awaiting marker; original process polls (1s interval) for it, reads, removes, re-acquires lock. If original process is killed during wait, the verdict.json sits on disk; next `/ideal --resume` picks it up via marker check in §6.4 step 5.

## 7. Error handling

| Failure | Behavior | Marker / log |
|---|---|---|
| Phase-plan JSON parse fail 3× | Fallback 1-phase; warn | `state.md → Plan Fallback: true` |
| Phase-plan validation fail (coverage <100%, cycle, drift) | Fallback 1-phase | Same |
| Phase-plan corrupt on resume (validation against current spec fails) | Backup `phases.md.corrupt-<ts>` + regenerate | `state.md → Plan Corrupt: <path>` |
| HTTP 429 on any LLM call | `withRateLimitBackoff` (1s/4s/16s); after 3 attempts → caller's deterministic fallback | n/a (logged) |
| Sprint review leader fail (or 429 exhaust) | Deterministic fallback summary: `Sprint N: score X→Y, met K/L criteria` (no LLM) | `Review Fallback: phase-N:sprint-K` |
| Retro leader fail (or 429 exhaust) | Skip retro for this sprint; phase digest unchanged; `retro-pending` marker cleared without entry | `Retro Skipped: phase-N:sprint-K` |
| Standup leader/council fail (or 429 exhaust) | Skip standup; warn; proceed; do not retry until next gap | `Standup Skipped: <reason>` |
| Handoff exitSummary leader fail | Deterministic fallback: `Phase N exited after K sprints, M/L criteria met` | n/a (silent fallback ok) |
| Customer verdict wait | Block indefinitely (no auto-accept); resume re-checks marker. Original process may be killed | `Awaiting Customer Review` marker stays |
| Crash mid-sprint | Resume re-reads iterations.md; sprint tail intact; retro replayed if `retro-pending` marker present | Idempotent |
| Crash mid-digest write | Atomic rename either applied or not; if not, `retro-pending` still set, resume replays retro | Idempotent |
| Phases.md corrupt JSON | Fallback 1-phase + backup file `phases.md.corrupt-<ts>` | `Plan Corrupt` |
| Concurrent /ideal on same runId | `.phases.lock` "wx" create; second start refuses | Lock file exists |
| Phase DAG deadlock (all remaining phases blocked) | Return `{ pass: false, reason: "phases-deadlocked: <ids>" }` | `state.md → Phasesstatus: phase-N: blocked` |
| Persisted `BudgetState` schema mismatch on resume | Skip old records; log one warning | "Phase Budget records from older schema discarded on resume" |

## 8. Testing strategy

Target: ≥92% line coverage on new files; 100% on `phase-runner.ts` and `context-policy.ts`.

**Test seams (injected, not module-mocked except for sprint-runner and rituals):**

- `awaitCustomerVerdict: (flowDir, runId) => Promise<CustomerDecision>` — pass directly in `RunPhasesOptions`; tests resolve immediately.
- `suppressPush: boolean` — when true, `runPhases` skips the `yield { type: "push_notification", ... }`.
- `leader: LeaderLike` — typed stub passed in; do NOT mock the entire council infrastructure.
- `backoffDelays?: number[]` — override `withRateLimitBackoff` delays for fast tests (default 1000/4000/16000ms).

**Module mocks (vi.mock):**
- `../sprint-runner.js` — `sprintRunner: vi.fn()` returning an empty async generator with stubbed final score.
- `../phase-rituals.js` — for `phase-runner.test.ts` only; in `phase-rituals.test.ts` the real implementation is exercised.
- `../context-policy.js` — for `phase-runner.test.ts` only.

**File I/O:** real temp dirs (`mkdtemp` + `afterEach` cleanup); the marker-read/write path is the system under test for resume, idempotency, and lockfile tests.

Test categories (78 cases total):

**`phase-plan.test.ts` (~14 cases):**
- Happy path: leader returns valid JSON → 3 phases, full criteria coverage.
- Validation fail rows: phases.length=0, =7, drifted successCriteria string, cycle in dependsOn, coverage <100% → each falls back.
- Retry: 2 malformed → 1 valid → success.
- 429: one 429 → backoff → success. Three 429s → fallback.
- Cost floor: capUsd=$5 + remainingUsd=$0.15 (< $0.20 floor) → no leader call, immediate fallback. Assert: leader call count === 0.
- Cost floor boundary: capUsd=$100 + remainingUsd=$1.99 (< $2.00 floor) → fallback.
- Fallback shape: single-phase contains all successCriteria verbatim; exitCondition.min === manifest.doneThreshold; dependsOn=[].
- Migration v0→v1: raw v0 artifact (missing `generatedAt`) → migrator adds current ISO timestamp.

**`phase-runner.test.ts` (~22 cases):**
- Iterates phases in DAG order.
- Skips done phases on resume.
- Resume with `retro-pending` marker → replays retro → digests → clears marker → advances.
- Resume with `awaiting-customer-review` marker → invokes injected `awaitCustomerVerdict` → continues to retro.
- Resume with no Phase Plan State section → returns sentinel signaling legacy path; assert no plan generated.
- Phase deadlock: all remaining phases depend on aborted phase → returns `{ pass: false, reason: "phases-deadlocked:..." }`.
- Phase aborted mid-sprint by customer "abort" verdict → returns immediately.
- Customer reject → feedback persisted verbatim to CustomerDecisions; assert exact string match.
- Re-validation on resume: load plan + edited ClarifiedSpec with drifted criterion → validation fails → backup created + plan regenerated.
- Marker idempotency: write `in-progress` over `in-progress` → underlying atomic-write spy called 0 times.
- Lockfile prevents concurrent start; second start rejects with sentinel error string `phase-lock-held`.
- `sprintN` reset across phases: assert phase-2 sprint 1 conversationContext refers to "Sprint 1", not continuation of phase-1's counter.
- All phases done → product done-gate invoked with `phaseHistory.length === plan.phases.length`.

**`phase-rituals.test.ts` (~16 cases):**
- generateSprintReview happy → leader called once → summary string returned.
- generateSprintReview leader fails 3× → deterministic fallback (`Sprint N: score X→Y, met K/L criteria`) returned.
- generateSprintReview 429 exhaust → deterministic fallback.
- generateSprintReview push-notification: yielded chunk type === "push_notification", content === summary.
- runRetro happy → returns LessonsLearned with ≤5 entries per array, each ≤200 chars.
- runRetro leader fails 3× → throws sentinel `RetroFailed`; caller catches, marks Retro Skipped.
- runRetro 429 exhaust → same path.
- runStandup happy → audit entry written via `appendSystemMessage` spy; assert one call with shape `{role:"system",content:/standup/i}`.
- runStandup council fails → no audit entry; warning logged.
- runStandup 429 exhaust → caller marks Standup Skipped.
- shouldRunStandup boundary: `lastActivityUtc=null` → false. `elapsedMs===3_600_000` → false. `elapsedMs===3_600_001` → false (require strict > 1h, so must be > 3_600_000). `elapsedMs=3_601_000` (~1.0003h) AND `hasAnyPhaseInProgress=true` → true.
- shouldRunStandup phase state: 2h gap + zero in-progress phases → false. 2h gap + 1 in-progress → true.
- Standup hard cap: 3 prior standups in `Standup Count` → fourth call returns "Standup Skipped: hard-cap-reached".

**`context-policy.test.ts` (~16 cases):**
- buildSprintContext happy: all layers present, well under cap → block ordering matches §5.3.
- Determinism: two calls with same args produce byte-for-byte identical strings.
- Over cap, essentials fit: trim Sprint Tail first; truncation marker visible at end.
- Over cap, essentials fit: after Sprint Tail emptied, trim Phase Digest oldest entries (positional decay).
- Over cap, essentials fit: after Digest emptied, trim Phase History oldest.
- Project block alone > cap → return Project + oversize marker.
- Project + Customer Decisions together > cap → return both + oversize marker (no truncation of either).
- digestSprintIntoPhase under cap → append entry; bytes still under.
- digestSprintIntoPhase over cap → drop oldest, add marker entry `[digest pruned: N entries dropped...]`.
- digestSprintIntoPhase preserves order (oldest first dropped, newest stays last).
- digestSprintIntoPhase with single entry over cap → keep that one entry, marker absent (cannot prune to zero).
- handoffPhaseToNext happy: leader returns ≤300 char summary → appended to phaseHistory.
- handoffPhaseToNext leader fails 3× → deterministic fallback: `Phase N exited after K sprints, M/L criteria met`.
- handoffPhaseToNext 429 exhaust → same fallback.
- Customer decision feedback ingress: > 2000 chars → truncated to 2000 + marker; mirrored to iterations.md (assert both files).

**`phase-orchestrator-integration.test.ts` (~10 cases):**
- End-to-end 2-phase × 2-sprint: assert markers at each checkpoint (`phase-1:in-progress`, `awaiting-customer-review:phase-1:sprint-1`, `retro-pending:phase-1:sprint-1`, then cleared, then `phase-1:done`, then `phase-2:in-progress`, ..., then product verdict).
- Crash + resume mid-sprint: kill after retro write but before phase done marker → resume reads markers → resumes at next sprint.
- Crash + resume mid-customer-review: marker present → resume invokes verdict prompt → continues.
- Crash + resume mid-retro write: `retro-pending` present + no digest entry for sprintK → resume replays retro → digests → clears marker.
- Crash + resume mid-digest write: simulate atomic rename either applied or not by partial state → resume re-derives lesson from retro on next attempt; assert lesson present in final digest.
- Stale resume + in-progress phase: lastActivity 2h ago + phase-1 in-progress → standup fires once before next sprint.
- Stale resume + no in-progress phase: lastActivity 2h ago + all phases done → standup does NOT fire.
- Cost cap exhausted mid-phase-2: CB-1 hard-stops; phaseState reflects `blocked`; deadlock check produces phase-deadlocked verdict.
- Concurrent /ideal on same runId: second start rejects with `phase-lock-held` sentinel.
- 3-standup hard cap: 3 stale resumes triggered standup; 4th stale resume → Standup Skipped: hard-cap-reached.

## 9. Downstream integration

- **Sprint-runner:** unchanged core; accepts optional `phaseScope`. Done-gate filters criteria to subset when present.
- **Loop-driver:** after scoping, calls `runPhases(...)` instead of legacy flat sprint loop. Legacy path retained behind `MUONROI_PHASE_MODE=0` env override for one minor version.
- **Audit:** standup council debates write `[Standup]`-tagged system messages via `appendSystemMessage` (NOT a nonexistent `audit-replay.ts`).
- **Push notification:** emitted as `StreamChunk { type: "push_notification", content }`; top-level CLI driver handles the actual side-effect (or suppresses when `suppressPush: true` or non-TTY).

## 10. Open questions

None at spec-revise time. All ambiguities surfaced by 4-agent cross-review have been resolved inline.

## 11. Acceptance criteria

- /ideal "build X" with no further user input progresses: discovery → scoping → phase plan → phase 1 sprint 1 → push_notification yielded → user verdict captured → retro → … → phase done → next phase → … → product done — without re-prompting for context.
- Crash kill -9 at any point → `/ideal --resume <runId>` continues from last committed marker; no duplicate sprint, no lost lesson, no lost customer feedback.
- Sprint context never exceeds 8 KB; phase digest never exceeds 4 KB; project + customer-decisions are a single never-trim block (oversize marker if exceeded).
- Total LLM cost adds **$0.75–$1.50 base** on top of B+C for a typical 3-phase × 2-sprint run, plus **$0.25–$0.55 per standup** (capped at 3 standups per run = $0.75–$1.65 extra in worst case). Total E add-on worst-case range: **$1.00–$3.15**.
- All existing tests pass; new test suite (78 cases) green; coverage ≥92% line on new files, 100% on `phase-runner.ts` and `context-policy.ts`.

## 12. Schema migration registry

```ts
const PHASE_PLAN_MIGRATORS: Record<number, Migrator> = {
  0: (raw) => ({ ...raw, version: 1, generatedAt: raw.generatedAt ?? new Date().toISOString() }),
  1: (raw) => raw,
};
```

Bump version on any breaking change to PhasePlanArtifact, CustomerDecision, PhaseDigestEntry, PhaseHistoryEntry, BudgetState. Unknown future version → log warning + return null + treat as missing (will regenerate). Matches `discovery-migrations.ts` pattern.

---

## Appendix A — Pattern references (verified against codebase commit 0e4de32)

| Spec reference | Actual source | Verified |
|---|---|---|
| `runDebate(spec, config, llm)` async generator | `src/council/debate.ts:232` | ✓ |
| `DebatePlan` fields `intentSummary/stances[{name,lens}]/outputShape/plannedRounds` | `src/council/types.ts:154-167` | ✓ |
| `costAware` on `CouncilConfig` (not DebatePlan) | `src/council/types.ts:203` | ✓ |
| Big-3 stance names | `src/product-loop/discovery-council-runner.ts:16-18` | ✓ |
| `LeaderLike` interface | `src/product-loop/discovery-prompt-parser.ts:5-11` | ✓ |
| `LeaderLike.generate` returns `{content, costUsd}` | Same file | ✓ |
| `withRateLimitBackoff` | `src/product-loop/discovery-recommender.ts:244-262` | ✓ |
| Section-map I/O | `src/flow/artifact-io.ts:18,31` | ✓ |
| Atomic write | `src/storage/atomic-io.ts:55` | ✓ |
| Audit via `appendSystemMessage` | `src/storage/index.ts` (NOT a nonexistent `audit-replay.ts`) | ✓ |
| Oldest-first byte-cap decay pattern | `src/product-loop/role-memory.ts:50-66` (NOT `cross-run-memory.ts`'s Jaccard) | ✓ |
| `Migrator` type | `src/product-loop/discovery-migrations.ts:7` | ✓ |
| `Phase` discriminated union (to be extended) | `src/product-loop/phase-budget.ts:28` | ✓ (extension required) |

**End of spec (revised).**
