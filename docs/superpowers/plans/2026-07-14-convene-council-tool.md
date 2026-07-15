# convene_council Tool — Implementation Plan (v2, post design-debate)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the CLI agent (any model, incl. reasoning) convene the multi-model
council on demand via a `convene_council` tool, get the synthesis back as that
tool's result, and continue the same turn — deciding from its OWN intent what to
do next (continue silently, or ask the user via an `ask_user` tool, or hand off
to `/ideal`). ZERO CLI-hardcoded post-council branching.

**Architecture:** A process-global one-shot channel (mirroring
`compact-request.ts`) queues the request; the tool-engine consumes it from the
**outer restart loop after every stream drain** (not only `dynamicStopWhen`),
runs the existing `runCouncilV2` with a new `convenePath` flag that suppresses
ALL hardcoded post-debate decision surface, splices the synthesis into the tool's
`tool_result` (in-place by `toolCallId`, exactly like
`rewriteSafetyApprovedToolResults`), and restarts `streamText` (SAMR-restart
precedent). Agent-intent is carried by a front-loaded operating-contract line,
not a low-primacy suffix.

**Tech Stack:** TypeScript, AI SDK v6 (`ai`), OpenTUI React, Zod/jsonSchema,
Vitest + agent-harness (`tests/harness/`).

## Global Constraints

- **Zero Hardcode Rule:** no model/provider ID literals; council resolves via `runCouncilV2`.
- **No CLI hardcode of the post-council decision (user directive):** CLI may ONLY (1) inject the synthesis as context and (2) inject a NON-BINDING suggestion. No option set, no continue-vs-ask branch, no implement tree decided by the CLI. The agent decides; `ask_user` is how it asks the human; `/ideal` handoff fires only from a model-callable tool the agent invokes.
- **No Silent Catch:** every catch logs module + operation + `err.message`.
- **Prerequisite:** merge `fix/council-reasoning-hang` (commit 3eb3755b) first.
- Tool registered only when `configuredRoleCount >= getAutoCouncilMinRoles()`.
- Verify: `bunx tsc --noEmit`, `bunx vitest run`, harness E2E for UI/harness surfaces, `self-verify` Tier 1.

## Sequencing (from design debate)

- **MVP (this plan, implement now):** Tasks 1,2,3,4,5,7 — "agent convenes council and continues." One risk surface (the splice), fully enforces the no-hardcode rule.
- **Follow-up 1:** Task 6 — `ask_user` (own askcard, blocking `execute()` + watchdog keepalive).
- **Follow-up 2:** Task 8 — agent-driven `/ideal` handoff via a model-callable tool + debate-skip inside real `runStart` (NOT a synthesis→ProductSpec transform).

---

## Task 1 — `council-request` channel

**Files:** Create `src/orchestrator/council-request.ts`, `src/orchestrator/council-request.test.ts`.

**Interfaces — Produces:**
- `requestCouncilConvene(reason?: string|null, toolCallId?: string|null): void`
- `hasPendingCouncilConvene(): boolean`
- `consumeCouncilConvene(): { reason: string|null; toolCallId: string|null } | null`
- `peekCouncilConveneToolCallId(): string|null`  (non-consuming — for the BUG-3 toolCallId guard)
- `__resetCouncilConveneForTests(): void`

- [ ] **Step 1:** Write `council-request.test.ts` mirroring `compact-request.test.ts`: set→`hasPending` true→`peek` returns toolCallId→`consume` returns `{reason,toolCallId}`→`hasPending` false→second `consume` null→`__reset` clears.
- [ ] **Step 2:** Run `bunx vitest run src/orchestrator/council-request.test.ts` — expect FAIL (module missing).
- [ ] **Step 3:** Implement `council-request.ts` (copy `compact-request.ts` shape; store `{reason, toolCallId}`; add `peekCouncilConveneToolCallId`).
- [ ] **Step 4:** Run the test — expect PASS.
- [ ] **Step 5:** Commit.

## Task 2 — `convene_council` tool

**Files:** Modify `src/tools/registry.ts` (register beside `compact`, ~line 236) and its factory signature to receive `configuredRoleCount`.

**Interfaces — Consumes:** Task 1; `opts.toolCallId` from `dynamicTool` execute's 2nd arg.

- [ ] **Step 1:** Find how the registry factory is called from the tool-engine turn scope and thread a `councilConfigured: boolean` (computed `configuredRoleCount >= getAutoCouncilMinRoles()`) param (the tool-engine already computes `configuredRoleCount`, tool-engine.ts:~684).
- [ ] **Step 2:** Add unit test in an existing registry test file (or new `registry-convene-council.test.ts`): when `councilConfigured` true, `tools.convene_council` exists and `execute({reason:"x"}, {toolCallId:"tc1"})` queues a request (`hasPendingCouncilConvene()` true, `peek` == "tc1"); when false, tool is absent.
- [ ] **Step 3:** Run test — FAIL.
- [ ] **Step 4:** Implement the tool:
```ts
if (councilConfigured) {
  tools.convene_council = dynamicTool({
    description:
      "Convene the multi-model council to debate THIS request. Use ONLY when the task has genuinely conflicting design tradeoffs, needs cross-provider/second-opinion review, or is a high-stakes architecture/analysis decision where one model's view is insufficient. It runs a real multi-role debate across several models and returns a synthesized conclusion AS THIS TOOL'S RESULT. Do NOT use it for routine/low-ambiguity work — it is expensive. After calling, read the returned conclusion and continue.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        reason: { type: "string", description: "Why this task needs a multi-model debate (the specific tradeoff/decision at stake)." },
      },
    }),
    execute: async (input: any, opts: any) => {
      requestCouncilConvene(typeof input?.reason === "string" ? input.reason : null, opts?.toolCallId ?? null);
      return formatResult({ success: true, output: "Council convening — the multi-model debate runs now and its conclusion replaces this result before your next step." });
    },
  });
}
```
- [ ] **Step 5:** Run test — PASS. `bunx tsc --noEmit`. Commit.

## Task 3 — `convenePath` council option (suppress ALL hardcoded post-debate decision surface)

**Files:** Modify `src/council/types.ts` (add option), `src/council/index.ts` (gate the block), `src/orchestrator/orchestrator.ts` (thread through `runCouncilV2`).

**No-hardcode enforcement (debate V1–V4):** gate the ENTIRE interactive block
`src/council/index.ts:1102-1360` — NOT just the card yield. Leave
`postDebateAction` undefined, do NOT call `onPostDebateAction`, do NOT run
`pickPostDebateRecommendation`/`baseOptions`/the action-routing tree/
`postDebateContinuation`. `return synthesis` before the block.

**Interfaces — Produces:** `RunCouncilOptions.convenePath?: boolean`.

- [ ] **Step 1:** Add `convenePath?: boolean` to `RunCouncilOptions` (`src/council/index.ts` interface) with a doc comment: "Convene-tool path: render clarify(optional)+debate+synthesis, then RETURN the synthesis string WITHOUT any post-debate card, recommendation, continuation, or onPostDebateAction — the calling agent decides what happens next (no CLI hardcode)."
- [ ] **Step 2:** Add `convenePath?: boolean` to `runCouncilV2`'s `options` type (`orchestrator.ts:2035-2041`) and forward it into the `runCouncil(...)` options object (`orchestrator.ts:~2100`).
- [ ] **Step 3:** Write a unit test (`src/council/__tests__/convene-path.test.ts`): drive `runCouncil` (with mock LLM producing a synthesis) with `convenePath:true`; assert the generator yields NO `council_question` chunk with `phase:"post-debate"`, `onPostDebateAction` is never called, and the returned value equals the synthesis. Mirror existing council test harness (mock model via `createMockModel`).
- [ ] **Step 4:** Run — FAIL.
- [ ] **Step 5:** In `runCouncil`, locate the post-synthesis interactive block (the `let answer` at `:1102` through the routing tree end `:~1360`). Wrap it: `if (!options?.convenePath) { …existing block… }`. Before that block (right after synthesis is produced), add: `if (options?.convenePath) { yield { type: "content", content: "\n[Council concluded — returning conclusion to the agent.]\n" }; return synthesisText; }`. Ensure `synthesisText`/`lastSynthesis` is set on `councilManager`/stats as usual so the caller reads it.
- [ ] **Step 6:** Run — PASS. Add an assertion test that with `convenePath:false` the card DOES appear (guard against over-suppression). `bunx tsc --noEmit`. Commit.

## Task 4 — tool-engine consumption (outer-loop, splice, restart)

**Files:** Modify `src/orchestrator/tool-engine.ts`.

**Mechanism (debate #2, verified safe):**
- Consume from the OUTER restart loop after EVERY stream drain (BUG 2: phase-1 `stepCountIs(1)` bypasses `dynamicStopWhen`). Also add `|| hasPendingCouncilConvene()` to `dynamicStopWhen` (tool-engine.ts:~1627) as a fast-path stop so the placeholder is never consumed by the model.
- Placement: after `stall.dispose()` (`:3364`), before `appendCompletedTurn` (`:3622`).
- Guard by `toolCallId` presence in `response.messages` (BUG 3: nested sub-session cross-talk) — only run council if the pending `toolCallId` is a recorded tool-result in THIS drain's messages; else skip (leave pending or reset, logged).
- Clear the flag in a `finally` at turn teardown (BUG 1: leak across turns when convene shares a step with terminal `respond_*`).
- Splice: reuse the `rewriteSafetyApprovedToolResults` pattern (`:468-495`) — find `role:"tool"` content with matching `toolCallId`, replace `result` with the synthesis (or "council unavailable: <reason>" note, logged). Graft `response.messages` into `deps.messages` (SAMR precedent `:3380-3394`), then `continue streamAttempt`.

- [ ] **Step 1:** Add import `consumeCouncilConvene, hasPendingCouncilConvene, peekCouncilConveneToolCallId` from `./council-request.js`.
- [ ] **Step 2:** Add `hasPendingCouncilConvene()` to the `dynamicStopWhen` OR-chain; add a comment referencing BUG-2 (this is a fast-path only; the real consumption is outer-loop).
- [ ] **Step 3:** After `stall.dispose()` (`:3364`), before turn finalize: if `hasPendingCouncilConvene()`, `await result.response`, verify the pending `toolCallId` exists as a tool-result in `response.messages`; if yes → `consumeCouncilConvene()`, `yield* deps.runCouncilV2(userMessage, { convenePath:true, observer, userModelMessage })`, capture `deps.councilManager.lastSynthesis`, splice it into the convene tool-result in `response.messages` by `toolCallId`, graft into `deps.messages`, then `continue streamAttempt`. If the toolCallId isn't present → log + leave for the owning frame.
- [ ] **Step 4:** Wrap the turn body so a `finally` calls `consumeCouncilConvene()` (discard) if still pending at teardown — prevents cross-turn leak. Log when discarding a non-empty pending flag.
- [ ] **Step 5:** Write `tests/harness/convene-council.spec.ts` (see Task 9). Also add a focused unit test for the splice helper (extract `spliceToolResult(messages, toolCallId, value)` as a pure fn if not already present; test it replaces by id and preserves pairing).
- [ ] **Step 6:** `bunx tsc --noEmit`; run harness spec; commit.

## Task 5 — agent-intent nudge (front-loaded, non-binding)

**Files:** Modify `src/pil/agent-operating-contract.ts` (primary), add a small pure builder + test.

**Debate #1 (b):** a tool_result suffix is the lowest-primacy slot; cheap/reasoning
models ignore it. Put the nudge in the front-loaded operating contract, mirroring
the existing VERIFICATION mandate (item 9, `agent-operating-contract.ts:~55`) —
which mandates a behavior with NO option set and NO branch.

- [ ] **Step 1:** Write a test asserting the contract text contains a convene/post-council line that (a) mentions `convene_council` and `ask_user`, (b) contains no fixed option list, (c) frames the ask as the agent's judgment ("if… you MAY… ; otherwise continue").
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Add the line to `AGENT_OPERATING_CONTRACT` (and, if fast-tier prepends a workbook, note it), e.g.: "When a task has genuinely conflicting tradeoffs or needs a second opinion, you MAY call `convene_council` — its conclusion returns as the tool result. After it concludes: if you are in an implementation discussion with the user and the conclusion is enough to proceed, ask the user via `ask_user` before building; otherwise keep working. You decide — nothing is auto-chosen for you."
- [ ] **Step 4:** Run — PASS. Commit.

## Task 7 — skip-reasoning message update

**Files:** Modify `src/orchestrator/tool-engine.ts:793`.

- [ ] **Step 1:** Append to the skip message: " — or call the convene_council tool if THIS task needs multi-model debate."
- [ ] **Step 2:** `bunx tsc --noEmit`; commit. (Covered incidentally by the harness spec.)

## Task 9 — MVP E2E + verification

- [ ] **Step 1:** `tests/harness/convene-council.spec.ts` — spawn in a fresh greenfield temp cwd (known-caveat #2), reasoning-model session id, mock-LLM fixture whose first response emits a `convene_council` tool call and whose second (post-splice) response references the synthesis; assert: `council-step` events fire → the model's subsequent step sees the synthesis as the convene tool result → turn completes. Prove the skip-reasoning no longer blocks the agent's opt-in.
- [ ] **Step 2:** `self-verify` Tier 1 on touched watched surfaces.
- [ ] **Step 3:** Full `bunx vitest run` + harness green (Pre-Push Test Gate). Commit.

---

## Follow-up 1 — Task 6: `ask_user` tool (after MVP green)

Own askcard, NOT `planSafetyAskcard` reuse (debate V5–V6). Block inside AI-SDK
`execute()` (result is a plain string) + watchdog keepalive while the card is open
(debate #2 c). Files: `registry.ts`, `orchestrator.ts` (`setAskUserHandler` +
dispatch), `tool-engine.ts` (deps `askUser` + keepalive), `types/index.ts` (phase
`"ask-user"`), `use-app-logic.tsx` (handler + resolver ref-map + drain branch),
`headless/council-answers.ts` (`"ask-user"` phase; index 0 = agent's first option,
documented as NOT a CLI recommendation). Options come ONLY from tool input; no
CLI-synthesized option set; `defaultIndex` agent-supplied or neutral 0.

## Follow-up 2 — Task 8: agent-driven `/ideal` handoff (after Follow-up 1)

DROP the synthesis→ProductSpec transform + synthetic resume (debate #3: fragile,
wrong preconditions — `manifest.md` not `.json`, needs createRun/state.md/
project-context.md/backlog, and auto-routing council→implement violates the
no-hardcode rule). Instead:
- Add a model-callable `handoff_to_ideal` (or extend an existing `/ideal`-start
  path) tool the AGENT invokes from its own intent (typically after its own
  `ask_user` returns "proceed"). The CLI never auto-routes.
- Council-inheritance ("don't re-debate") = a debate-skip inside the REAL
  `runStart` scoping path (`loop-driver.ts:680` `research` FSM case): detect a
  fresh convene synthesis for this session and skip the CB-1 `runDebate`, reusing
  the existing `debate-inputs.json` / debate-checkpoint inheritance plumbing —
  keeping discovery/scoping (real MVP/architecture) intact. Gated on the agent's
  decision, not a CLI branch.

---

## Self-review notes (spec coverage)

- Skip-reasoning heuristic itself: UNCHANGED (only governs the AUTO trigger) — Task 7 just points the agent at the tool. ✔
- Every hardcoded post-council decision point (debate V2 list) is bypassed on the convene path by Task 3's full-block gate. ✔
- The three AI-SDK ordering bugs (flag leak, phase-1 bypass, nested cross-talk) are addressed in Task 4 steps 2–4. ✔
- ask_user + /ideal handoff preserve the user's full vision but are correctly sequenced as follow-ups with the no-hardcode-compliant approach. ✔
