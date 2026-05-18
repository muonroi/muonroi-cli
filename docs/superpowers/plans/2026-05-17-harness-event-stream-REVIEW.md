# Cross-verification review — Harness Event Stream
> Plan: `2026-05-17-harness-event-stream.md`
> Reviewer: independent cross-check agent, 2026-05-17

---

## Verdict

**APPROVED-WITH-FIXES**

Three blockers must be resolved before implementation starts. All are spec/plan gaps, not architecture problems. No phase needs to be discarded.

---

## Findings

### BLOCKERS

**[B1] `council_status` stream is a MISSING emit point — not covered by any task**

Plan Task 2.2 routes `council-step` through the `case "council_phase":` branch in `app.tsx` (line 2689). But the codebase has a parallel `case "council_status":` branch (lines 2657–2686, and again at 3085–3113, 3241–3269) for per-role speaker placeholders and status badges. These carry the role-by-role progress signals specs will need (e.g. "has `architect` speaker started / finished?"). There is no planned event or task covering `council_status` → harness event. If a spec wants to know when a specific council role completes its turn (vs. when a whole phase ends), this is the only hook.

→ **Recommendation:** Add Task 2.8 — emit a `council-role-step` (or extend `council-step` with an optional `roleLabel` field) from the `case "council_status":` branch in `app.tsx`. The `CouncilStatusData` fields map cleanly: `statusId`, `state`, `label`. Alternatively, explicitly document in the plan that role-level granularity is out of scope for this iteration and that `council-step` (phase-level) is sufficient.

**[B2] `driver.events()` semantics are underspecified in three critical dimensions (Task 3.4)**

The plan says the iterator replays "all events currently in eventBuffer that pass filter, then streams new ones" and that cleanup happens "on `.return()` or when the test calls cleanup()". These gaps must be resolved before implementation:

a. **Error/stop behavior:** The plan says nothing about what happens when the TUI process exits and no more events arrive. Does `driver.events()` hang forever, or does the iterator complete (return `{ done: true }`)? Specs in a `for await` loop will deadlock if the iterator never terminates after the TUI stops.

b. **Cleanup contract:** The plan mentions `.return()` but `Driver` type is currently defined with no `cleanup()` method and the plan does not say whether `events()` returns an `AsyncIterator` (has `.return()`) or an `AsyncIterable` (has `[Symbol.asyncIterator]()`). The spec example in Task 5.2 uses `for await (const e of events)` which requires an `AsyncIterable`, not an `AsyncIterator`. The type signature in Task 3.4 declares `AsyncIterator<...>` — this is a mismatch with the usage pattern. Pick one and commit.

c. **Back-pressure / subscriber leak:** The plan says "maintain a set of subscriber callbacks" but does not specify what happens to a subscriber queue that is never consumed (e.g. a leaked iterator from a spec that throws mid-loop). With 80–120 `llm-token` events/sec enabled, an unconsumed queue is an unbounded allocation.

→ **Recommendation:** Add a `maxQueueDepth` per-subscriber (suggest 2000, matching 2× ring cap), drop oldest on overflow, complete the iterator with a terminal marker when the TUI `_ingest` receives no more events after the process exits (or add an explicit `driver.closeEvents()` tear-down call). Commit `AsyncIterable<LiveEvent>` as the return type to match the `for await` usage.

**[B3] `ideal-e2e-live.spec.ts` CI promotion (Task 5.3) does not commit to removing `describe.skipIf` or adding the flag to a real CI job definition**

Task 5.3 says: "Update the spec header comment to change STATUS from 'reference/manual-only' to 'gated CI gate'." and "Add to CI pipeline docs that this flag is set in the nightly/full suite." There is no CI pipeline file in the repo (no `.github/workflows/`, no `ci.yml` found). The plan therefore has no concrete deliverable here — updating a comment does not make this spec a gate. If `MUONROI_E2E_LIVE=1` is never set in any automated pipeline, Stage 2's rewrite (Task 5.2) is unverifiable in CI and regressions will go undetected.

→ **Recommendation:** Either (a) add a concrete CI artifact (a workflow stub, a makefile target, a CI config snippet) as a deliverable of Task 5.3, or (b) re-classify 5.3 as a CONCERN and document that the spec remains manual-only until a nightly pipeline exists. As written, calling it a "CI gate" in a comment without the gate is misleading.

---

### CONCERNS

**[C1] `correlationId` source in Task 2.6 is ambiguous at call site**

Plan says `correlationId: this._currentCallId ?? this.sessionId`. Grep confirms `_currentCallId` does not exist in `orchestrator.ts` today. The plan instructs implementers to "generate a UUID at each `streamText` call site" (OQ-1 resolution) but the payload spec at Task 2.6 references `this._currentCallId` as if it already exists. Implementers will need to add the field and set it immediately before each `streamText` call — this should be stated explicitly in Task 2.6 rather than left implicit.

**[C2] `sprint-begin` stage granularity is confirmed as one-per-stage (OQ-2 resolution), but Task 2.5 only emits ONE event — at Planning entry**

Task 2.5 payload says `stage: "planning"` and describes "emit once per sprint at entry." The OQ-2 resolution says one event per stage transition (planning/implementation/verification/judgment). These are contradictory. The sprint runner at lines 146, 214, 228, 255 has four distinct stage-entry yield points. Task 2.5 as written will only instrument the first one. Implementers following the task literally will miss the other three.

**[C3] `council_phase` emit point has THREE separate code paths in `app.tsx`**

The plan (Task 2.2) references only `case "council_phase":` at line ~2690 (the main TUI stream). Grep shows identical `council_phase` handling at lines 3115 (second stream branch) and 3271 (third branch). All three branches call `setCouncilPhases(...)`. If the emit is only wired at one location, council steps during resume or alternative flows will silently drop events.

**[C4] Redaction allowlist for `askcard-open` includes `question` (raw text) — risk of sensitive data leak**

The `question` field in `askcard-open` is the verbatim question string yielded by the council. Council clarification questions can contain project context extracted from the user's prompt (API keys, credentials, paths). The plan allows `question` through with no truncation or pattern check, only the API-key regex on `answerText`. The allowlist should either apply the same API-key pattern check to `question` or cap it to 300 chars like `toast.text`.

**[C5] `WaitArgs` export (Task 3.5) is listed as a task but has no acceptance criteria or test**

This is a one-liner export change with zero risk but the plan lists it as a standalone task with no verification step. Merge into Task 3.3 or add an explicit "compiles without error" acceptance check to avoid a hanging task in the tracker.

---

### NITS

**[N1] Task 1.3 `council-step` keeps `phaseKind` as `string` to avoid cross-package dep — this is correct, but the comment should note that `CouncilPhaseKind` is the source enum in `src/types/index.ts` so future reviewers don't re-invent it.**

**[N2] Task 2.7 is a research-only task ("no code changes") but is numbered in the Phase 2 emit sequence, implying dependency ordering. It should explicitly precede Tasks 2.3 and 2.4 in the dependency graph, which it currently does not (the graph only shows Phase 1 → Phase 2 as a block).**

**[N3] Task 1.9 (`PROTOCOL_VERSION` bump) mentions to "verify `LiveFrame.version` type inference still resolves" — the type is `typeof PROTOCOL_VERSION` which is a const string literal. After a bump, all existing `LiveFrame` deserializers that assert `frame.version === "0.1.0"` will silently fail. The plan should grep for `"0.1.0"` usages before bumping. Confirmed site: `packages/agent-harness-core/src/mcp-server.ts:125`.**

**[N4] Phase 4.2 filter wire-in: the code snippet shows `if (e.t === "event" && !filter(e.kind)) return;` but `LiveEvent` includes `{ t: "idle" }` which has no `kind`. The guard `e.t === "event"` is correct and sufficient — but the plan should note that `{ t: "idle" }` is not a `LiveEvent` member with `kind`, so the type narrowing works cleanly. This avoids confusion for implementers.**

**[N5] Task 6.3 says "run `runSprint` with a minimal `SprintContext`" — `runSprint` requires a `RunSprintArgs` which includes `ctx.flags.maxCost`, `ctx.flowDir`, `ctx.runId`, `ctx.cwd`, `productSpec.idea`, `productSpec.costEstimate`, `roleAssignments`, `history`, `carryOver`, and `phaseScope`. A "minimal" stub is nontrivial. The task should either point to the existing `sprint-runner.test.ts` mock setup (lines 129, 265) as a template, or acknowledge the test will require mocking `runCouncil` and `buildVerifyAgent`.**

---

## OQ resolutions check

| OQ | Applied to plan body? | Where |
|---|---|---|
| **OQ-1** (`correlationId` = per-`streamText`-call UUID) | **Partial** — Architecture Notes and Risk R-OQ-1 section reference the resolution, but Task 2.6 payload uses `this._currentCallId ?? this.sessionId` without specifying that `_currentCallId` must be added as a new field. The implementation guidance is incomplete. | Task 2.6 payload spec |
| **OQ-2** (`sprint-begin` = one event per stage transition) | **No** — Task 2.5 payload explicitly says `stage: "planning"` and "emit once per sprint at entry." The OQ-2 resolution (four events per sprint, one per stage) is stated in the Open Questions section but contradicts the task body. Task 2.5 body was NOT updated to reflect the resolution. | Task 2.5 vs. Open Questions section |

---

## Coverage matrix (emit points)

| Site | In plan? | Task ID | Payload spec adequate? |
|---|---|---|---|
| `streamText` finish (`onFinish` — sub-agent path, orchestrator.ts:1470) | Yes | 2.6 | Adequate; `llm-done` fields match what `onFinish` provides |
| `streamText` finish (`onFinish` — top-level path, orchestrator.ts:4123) | Yes | 2.6 ("Second streamText site") | Adequate — mentioned as second site |
| `streamText` text-delta loop (sub-agent, orchestrator.ts:1488–1499) | Yes | 2.6 | Adequate |
| `streamText` text-delta loop (top-level, orchestrator.ts:4172+) | Yes | 2.6 ("Second streamText site") | Adequate |
| `case "council_phase":` in `app.tsx` (line 2689) | Yes | 2.2 | Adequate |
| `case "council_phase":` in `app.tsx` (lines 3115, 3271 — second/third branches) | **No** | — | **Missing — CONCERN C3** |
| `case "council_status":` in `app.tsx` (role-level turn events) | **No** | — | **Missing — BLOCKER B1** |
| `setPendingCouncilQuestion` call (line 2619 — `case "council_question":`) | Yes | 2.3 | Adequate (task 2.7 researches exact setter) |
| `setPendingCouncilQuestion` calls at lines 3062 and 3210 (second/third branches) | **No** | — | **Missing — same gap as C3 above** |
| `reduceCardKey` answer path (`result.emit?.type === "answer"`) in `app.tsx` line 4004 | Yes | 2.4 | Adequate |
| `reduceCardKey` cancel path (`result.emit?.type === "cancel"`) in `app.tsx` line 4011 | **No** | — | **Not covered** — cancel currently calls `respondToCouncilQuestion(qid, "")` silently; no harness event. Minor gap: add to task 2.4 or explicitly say cancel emits no event. |
| Sprint Planning entry (`sprint-runner.ts:146`) | Yes | 2.5 | Partial — only planning stage addressed (see C2) |
| Sprint Implementation entry (`sprint-runner.ts:214`) | **No** | — | **Missing per OQ-2 resolution** |
| Sprint Verification entry (`sprint-runner.ts:228`) | **No** | — | **Missing per OQ-2 resolution** |
| Sprint Judgment entry (`sprint-runner.ts:255`) | **No** | — | **Missing per OQ-2 resolution** |
| CB-3 halt yield (`sprint-runner.ts:117–141`) | Yes | 2.5 | Adequate |
| Route decision — hot-path branch (`product-loop/index.ts:103–104`) | Yes | 2.1 | Adequate |
| Route decision — council branch (`product-loop/index.ts:106`) | Yes | 2.1 | Adequate |
| LLM error → `toast` in `app.tsx:2702` | Existing — no change needed | — | Preserved unchanged |
| `case "error":` in stream loop → `toast` emit `app.tsx:2734` | Existing | — | Preserved unchanged |
| `usage` event in `orchestrator.ts:922` | Existing | — | Preserved unchanged |

---

## Summary (≤150 words)

**Verdict: APPROVED-WITH-FIXES.** The plan is architecturally sound and well-structured; all six new event kinds are correctly discriminated and the allowlist-based redaction approach is solid. Three blockers must be resolved before implementation starts: (B1) `council_status` role-level events are missing entirely from the emit plan; (B2) `driver.events()` AsyncIterator semantics leave three critical behaviors undefined (termination, return type mismatch `AsyncIterator` vs `AsyncIterable`, subscriber leak); (B3) Task 5.3's "CI gate" claim has no concrete deliverable. Additionally, OQ-2's resolution (four `sprint-begin` events per sprint) is contradicted by the Task 2.5 body, which must be updated before a subagent implements it. Fix B1, B2, B3, and the OQ-2 task-body contradiction, then implementation can proceed on the critical path: Phase 1 → Phase 2+3 in parallel → Phase 4 → Phase 5 → Phase 6.
