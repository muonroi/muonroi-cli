# Agent-Driven Post-Council Follow-up — Design

**Date:** 2026-07-14
**Branch:** `feat/convene-council-tool`
**Status:** Design (awaiting review)

## Problem

When auto-council or `/council` finishes a debate, the CLI **always** shows a
hardcoded post-debate askcard offering the same fixed option set: *implement /
stop-and-return-context / ask-deeper*. This is CLI-hardcoded branching — the
"what to do next" decision is baked into the runtime, not decided by the agent
based on the user's actual intent.

Evidence (current code):

- Auto-council: `src/orchestrator/tool-engine.ts:813-838` calls `runCouncilV2`
  **without** `convenePath`, so the post-debate block in
  `src/council/index.ts:806` (`if (sessionId && !options?.convenePath)`) fires —
  recommendation banner + option-set build (`index.ts:895-1037`) + askcard.
  Follow-up is then routed by `postDebateContinuation(chosenAction, synthesis)`
  (`tool-engine.ts:827-833`).
- `/council` slash: `src/orchestrator/orchestrator.ts:2111-2185` — same card,
  same `postDebateContinuation` routing (isolated sub-agent for
  implement/generate_plan; `null` for analysis `continue_session`).
- `postDebateContinuation` (`src/council/index.ts:280-323`) maps a
  CLI-collected `chosenAction` → a re-entry prompt. It exists **only because**
  the hardcoded card produces `chosenAction` in the first place.

The standing directive: after a council concludes, the follow-up MUST originate
from the **agent's own intent**. The CLI may only (1) inject the synthesis as
context and (2) inject a NON-BINDING suggestion. No hardcoded option set, no
continue-vs-implement branch, no decision tree. The agent asks the human itself
via `ask_user` when a decision genuinely needs a human.

`convene_council` **already** does exactly this: `convenePath:true` suppresses
the entire post-debate block, splices the synthesis into the tool result, and
the agent resumes its own turn to decide. This design brings auto-council and
`/council` onto the same principle.

## Scope

- **In scope:** auto-council (`tool-engine.ts` routing branch) and `/council`
  slash (`orchestrator.runCouncilV2`, `ownsController` path).
- **Out of scope:** `/ideal`. It uses `sprint-runner.ts` → `runCouncil(...,
  sprintPlanningMode:true)` (a separate wiring, mirrored at
  `orchestrator.ts:2299`) with an auto-lock that forces `generate_plan`. Its
  build loop depends on `postDebateContinuation`'s implementation carry-forward.
  `/ideal` is left byte-for-byte unchanged.
- **Unchanged:** `convene_council` keeps its native splice-resume — it is a real
  tool call inside an active `streamText` loop, so it resumes that turn. It is
  the reference behavior this design generalizes, not something to modify.

## Approaches considered

1. **Splice synthesis into history and resume the same `streamText` turn** (what
   convene does). **Rejected for auto/slash:** neither path is a tool call in an
   active `streamText` loop. Auto-council is a routing branch that runs *before*
   the main loop starts; `/council` is dispatched from the UI. There is no turn
   to resume — forcing this would mean building a brand-new resume seam for two
   paths that architecturally don't have one.
2. **Re-enter `processMessage` with a neutral continuation prompt** (chosen).
   Reuses the existing re-entry seam both paths already use; the only change is
   *what* prompt is fed. The prompt carries the synthesis as context + a
   non-binding nudge, then a normal agent turn decides (respond / `ask_user` /
   implement) from the user's original intent.
3. **Hybrid.** Unnecessary complexity — the mechanism per path is already
   determined by whether the path is a live tool call. No third mode needed.

**Recommendation: approach 2 for auto/slash; convene keeps approach 1 natively.**
The mechanism differs by path because the paths are architecturally different,
but both are agent-driven — the CLI never decides the next step.

## Design

### 1. Unify auto-council + `/council` onto `convenePath`

Both call sites pass `convenePath: true` into the council run:

- `tool-engine.ts:813` — add `convenePath: true` to the auto-council
  `runCouncilV2` options. Keep existing `skipClarification`
  (`!isAutoCouncilClarifyEnabled()`) — the pre-debate interview is orthogonal to
  the post-debate card and stays as-is (clarification gate is `index.ts:458`,
  independent of `convenePath`).
- `/council` slash — the UI/`runCouncilV2` slash entry passes `convenePath:
  true` on the non-convene slash path (the convene builtin already does).

Effect (already implemented behavior of `convenePath`, verified in
`src/council/__tests__/convene-path.test.ts`):

- Post-debate block `index.ts:806` fully skipped — no recommendation banner, no
  option-set build, no askcard, no `onPostDebateAction`.
- Preflight auto-approves (`index.ts:534`).
- Escalation auto-accepts (`debate.ts:905`).

### 2. Replace `postDebateContinuation` routing with a neutral continuation

Both callers currently compute `postDebateContinuation(chosenAction, synthesis)`.
With `convenePath:true` there is no `chosenAction` (no card). Replace that call —
in the auto-council branch and the `/council` `ownsController` branch **only** —
with a single neutral continuation that always hands the synthesis to the agent:

```
Council debate completed. Conclusion:

<synthesis>

You now decide the next step based on the user's original request — do not stop
without doing one of these:
  • If the conclusion IS the deliverable (analysis/evaluation/decision), respond
    to the user with it.
  • If a choice genuinely needs the human before proceeding, call `ask_user`.
  • If the task calls for building and the conclusion is a sufficient spec,
    implement it now through your normal workflow (do not re-litigate or expand
    scope).
```

This is a **non-binding** nudge listing the agent's own capabilities — not a
menu the CLI adjudicates. The re-entered `processMessage` turn runs normally and
the agent's intent (respond / `ask_user` / implement) drives the follow-up.

Implementation notes:

- `postDebateContinuation` itself stays in the file — `/ideal`'s carry-forward
  path may still reference it. The two redesigned call sites stop calling it and
  use the neutral continuation instead. (Confirm `/ideal` linkage before
  deleting anything; default is keep.)
- The synthesis is still persisted as `[Council Decision]`/`[Council Memory]`
  system messages, so even if the agent chooses to stop, the user's next message
  inherits full council context (`buildCouncilContextBundle`). No behavior lost.
- Guard the existing convene loop cap (`conveneRunsThisTurn`,
  `tool-engine.ts:648`) still applies — the neutral turn could itself call
  `convene_council`; the once-per-turn cap prevents a convene→synthesis→convene
  loop.

### 3. (Secondary) Close the clarifier scope-research heartbeat gap

Discovered while dogfooding: the clarifier's scope-research calls `llm.research`
**directly** (not wrapped in `tracedAsync`), so it emits **no** `council_status`
tick — unlike debate-research (`llm.ts:1129-1145`). A monitor watching
`council-speaker` elapsedMs sees a frozen signal during a long clarification and
mis-reads it as a stall (the exact false-stall this branch already fixed for
debate-research in commit `0f5c1118`).

Fix: wrap the clarifier scope-research call in the same `tracedAsync` heartbeat
so it yields `council_status` `tick` with advancing `elapsedMs`. Small,
self-contained, same-observability theme — included here rather than a separate
ticket.

## Testing

- Reuse/extend `src/council/__tests__/convene-path.test.ts` — assert
  auto-council and `/council` now emit **no** post-debate card and return the
  synthesis (parity with convene's existing assertions).
- Unit: the neutral continuation builder returns a synthesis-carrying,
  non-binding prompt (no `chosenAction` input, no option enumeration).
- Regression: `/ideal` sprint path unchanged — its `postDebateContinuation`
  carry-forward tests (`post-debate-continuation.test.ts`) stay green.
- E2E (harness): drive `/council` in a greenfield temp cwd, assert the debate
  concludes and the follow-up is a normal agent turn (no askcard selector), with
  the monitor reading advancing `council-speaker` elapsedMs through
  clarification (validates §3).
- Full suite green + `bunx tsc --noEmit` before push (pre-push gate).

## Non-goals / YAGNI

- No new tool, no `handoff_to_ideal`, no agent-driven `/ideal` handoff (deferred).
- No change to convene_council.
- No deletion of `postDebateContinuation` unless `/ideal` linkage is proven
  independent.
