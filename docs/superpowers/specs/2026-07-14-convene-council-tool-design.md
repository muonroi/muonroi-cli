# Design: `convene_council` — model-callable council

**Date:** 2026-07-14
**Status:** Approved (pending spec review)
**Author:** agent session

## Problem

Auto-council currently **skips reasoning models** with a hardcoded rule:

```
[Auto-council skipped: deepseek-v4-flash is a reasoning model and already
performs internal self-debate. Set MUONROI_AUTOCOUNCIL_SKIP_REASONING=0 or
autoCouncilSkipReasoning=false to force council.]
```

Evidence (`src/orchestrator/tool-engine.ts:698`):
```ts
const shouldSkipForReasoning = sessionModelIsReasoning && skipReasoningSetting && !heavyTier;
```

The skip decision is a **static CLI rule**. Whether a reasoning model actually
benefits from council depends on the task at hand (conflicting tradeoffs?
cross-provider review warranted? high-stakes design decision?) — a per-turn,
context-dependent judgement. That judgement belongs to the **agent driving the
loop**, not a global setting.

The rationale for the original skip is sound: council's value is **diversity of
perspective across multiple models/providers debating** (`runCouncil`
resolves a leader + panel ≥2 participants, each playing a distinct persona over
multiple rebuttal rounds — `src/council/index.ts:340`, `src/council/debate.ts:527`).
A reasoning model self-debates **within a single model** — no cross-provider
diversity. So the skip is a cost/ROI heuristic, not a claim that council is
useless for reasoning models. That is exactly why the decision should be
delegated to the agent rather than removed.

## Goal

Give the agent a first-class way to convene the council mid-turn when it judges
the request warrants multi-model debate — regardless of whether auto-council
fired. The static skip-reasoning heuristic only governs the **automatic**
trigger; it no longer removes the agent's ability to opt in.

Non-goals:
- Do NOT remove or change the auto-council skip-reasoning heuristic itself.
- Do NOT add a second council rendering/orchestration code path — reuse
  `runCouncilV2`.

## Approved decisions

| Decision | Choice |
|---|---|
| Mechanism | Model-callable tool (`convene_council`) |
| Pipeline scope | Full `runCouncilV2` (clarify + debate + synthesis + post-debate) |
| Availability | Always registered when council is configured (≥ `autoCouncilMinRoles` roles) |
| Turn handling | Council runs, synthesis becomes the tool's `tool_result`, the model continues the SAME turn |

## Architecture

Three parts, mirroring the existing `compact` tool precedent
(`src/orchestrator/compact-request.ts` → `src/tools/registry.ts` →
`src/orchestrator/tool-engine.ts` prepareStep consumption).

### 1. Channel — `src/orchestrator/council-request.ts` (new)

Process-global one-shot request slot (same single-active-turn assumption as
`compact-request.ts`):

```ts
export interface CouncilConveneRequestState {
  /** Model-supplied justification for convening (why it needs multi-model debate). */
  reason: string | null;
  /** Tool-call id of the convene_council call, so the tool-engine can replace its result. */
  toolCallId: string | null;
}

export function requestCouncilConvene(reason?: string | null, toolCallId?: string | null): void
export function hasPendingCouncilConvene(): boolean
export function consumeCouncilConvene(): CouncilConveneRequestState | null
export function __resetCouncilConveneForTests(): void
```

### 2. Tool — `src/tools/registry.ts` (new tool beside `compact`)

```ts
tools.convene_council = dynamicTool({
  description:
    "Convene the multi-model council to debate THIS request. Use ONLY when the " +
    "task has genuinely conflicting design tradeoffs, needs cross-provider/second-" +
    "opinion review, or is a high-stakes architecture/analysis decision where a " +
    "single model's view is insufficient. It runs a real multi-role debate across " +
    "several models → a synthesized conclusion, which comes back to you as this " +
    "tool's result. Do NOT call it for routine or low-ambiguity work — it is " +
    "expensive. After calling, the debate runs and its conclusion is returned here; " +
    "read it and continue.",
  inputSchema: jsonSchema({
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why this task needs a multi-model debate (the specific tradeoff / decision at stake).",
      },
    },
  }),
  execute: async (input: any, opts: any) => {
    requestCouncilConvene(
      typeof input?.reason === "string" ? input.reason : null,
      opts?.toolCallId ?? null,
    );
    // Placeholder result — REPLACED with the synthesis by the tool-engine before
    // the next step. If for any reason the council cannot run (no reachable
    // panel), the model still gets an actionable string here.
    return formatResult({
      success: true,
      output: "Council convening — the multi-model debate runs now and its conclusion replaces this result before your next step.",
    });
  },
});
```

**Registration gate:** register only when the council is actually usable, i.e.
`configuredRoleCount >= getAutoCouncilMinRoles()` (the same `configuredRoleCount`
already computed in the tool-engine turn scope). When fewer roles are
configured, the tool is omitted so the model never calls a council that cannot
convene. The tool is registered independently of `shouldAutoCouncil` /
`shouldSkipForReasoning` — it is available even on turns where auto-council also
fires (per the "always available" decision).

The registry factory (`buildToolRegistry` / equivalent) already receives
turn-scoped context; the gate value (`configuredRoleCount`) is threaded in the
same way other conditional tools are gated.

### 3. Consumption — `src/orchestrator/tool-engine.ts`

The delicate part. Council renders through the generator `yield` path
(auto-council does `yield* deps.runCouncilV2(...)` at `tool-engine.ts:762`),
NOT through the observer. So the council cannot run inside the tool's
`execute()` without losing the visual debate and lacking turn-scoped deps
(`userMessage`, `observer`, `cwd`, `session`). It must run in the outer
generator loop. Mechanism ("stop-and-restart, synthesis replaces tool_result"):

1. **Stop the current step.** Extend the existing `dynamicStopWhen` (the same
   hook the loop already uses to end a step) to also stop when
   `hasPendingCouncilConvene()` is true. The step in which the model called
   `convene_council` therefore ends cleanly after the tool result is recorded.

2. **Consume + run council in the outer loop.** After the `streamText` step
   returns control to the tool-engine's restart loop (the same loop that
   already handles stall-reprompt restarts and compaction), if
   `consumeCouncilConvene()` returns a request:
   - `yield* deps.runCouncilV2(userMessage, { skipClarification: false, observer, userModelMessage })`
     — identical invocation to the auto-council branch, so the debate UI (panel,
     rounds, council_meta, post-debate card) renders exactly as today.
   - Capture `deps.councilManager.lastSynthesis` (as the auto-council branch
     does at `tool-engine.ts:767`).

3. **Replace the tool_result with the synthesis.** Before restarting
   `streamText`, locate the `tool-result` message for the recorded
   `convene_council` call (matched by `toolCallId` from the consumed request)
   in the messages the next step will see, and replace its content with the
   synthesis (or a "council could not convene: <reason>" note when synthesis is
   null). This is what makes the model perceive the synthesis as the tool's
   return value and continue the SAME turn — satisfying the chosen turn-handling
   semantics without a `processMessage` re-entry.

4. **Restart `streamText`** with the amended messages. The model reads the
   synthesis as `convene_council`'s result and proceeds.

**Why not re-enter via `postDebateContinuation`?** That is the auto-council
semantics (council result becomes a fresh turn). The chosen design keeps the
model inside its current turn with the synthesis as tool output, so
tool_result-replacement is used instead of re-entry. The post-debate askcard
still runs inside `runCouncilV2`; its chosen action is captured but does not
force a new turn here (the model decides what to do next from the synthesis).

**Failure modes (No Silent Catch):** if `runCouncilV2` yields no synthesis
(e.g. `< 2` reachable providers — `src/council/index.ts:357`), log the reason
and replace the tool_result with an explicit "council unavailable: <reason>"
string so the model is never left with the stale placeholder. Any thrown error
is logged with module + message and surfaced as the tool_result, not swallowed.

### Secondary change: skip-reasoning message

`src/orchestrator/tool-engine.ts:793` — append one clause pointing the agent at
its new option:

> `[Auto-council skipped: … Set MUONROI_AUTOCOUNCIL_SKIP_REASONING=0 or autoCouncilSkipReasoning=false to force council — or call the convene_council tool if THIS task needs multi-model debate.]`

Same clause is unnecessary in the decision-log reason string (that is for
forensics, not the model), but harmless if added.

## Data flow

```
model step calls convene_council(reason)
  └─ execute(): requestCouncilConvene(reason, toolCallId); returns placeholder
dynamicStopWhen sees hasPendingCouncilConvene() → step ends
tool-engine restart loop:
  consumeCouncilConvene() → { reason, toolCallId }
  yield* runCouncilV2(userMessage, {...})     ← visual debate, reuses existing path
  synthesis = councilManager.lastSynthesis
  replace tool_result(toolCallId) content ← synthesis (or unavailable note)
  restart streamText with amended messages
model next step: reads synthesis as convene_council result → continues turn
```

## Components & boundaries

- `council-request.ts` — pure process-global slot. No deps. Testable in
  isolation (set → peek → consume → reset), exactly like `compact-request.ts`.
- `registry.ts` `convene_council` tool — depends only on `council-request.ts`
  + the registration gate value. No knowledge of council internals.
- `tool-engine.ts` consumption — the only place that knows how to run council
  and splice its result. Reuses `deps.runCouncilV2` + `deps.councilManager`;
  adds no new council orchestration.

## Testing

Per `CLAUDE.md` harness workflow (touches a council flow with UI; registry is
not UI but the debate render is a watched surface).

1. **Unit** — `council-request.ts`: set/peek/consume/reset one-shot semantics
   (mirror `compact-request.test.ts`).
2. **Unit** — registration gate: `convene_council` present iff
   `configuredRoleCount >= minRoles`; tool `execute` queues a request with the
   reason + toolCallId.
3. **Harness E2E** (`tests/harness/convene-council.spec.ts`) — spawn in a fresh
   greenfield temp cwd (per known-caveat #2), mock-LLM fixture whose response
   emits a `convene_council` tool call, assert: `council-step` events fire →
   post-debate/synthesis surfaces → the model's subsequent step sees the
   synthesis. Force a reasoning-model session id so this proves the skip no
   longer blocks the agent's opt-in.
4. **Self-verify Tier 1** on touched surfaces after implementation.
5. Full `bunx vitest run` + harness suite green before push (Pre-Push Test Gate).

## Risks

- **tool_result replacement** is the highest-risk step: the exact shape/location
  of the `convene_council` tool-result message in the restart messages array
  must be confirmed against the AI SDK message model during planning. Fallback
  if replacement proves infeasible: append the synthesis as a follow-up
  `tool`/`user` message instead of replacing (model still continues same turn
  with synthesis in context) — a documented degradation, not a silent one.
- **Zero Hardcode Rule:** no model/provider ids introduced; `runCouncilV2`
  resolves models from catalog/settings as today.
- **Cost:** the tool description is explicit that council is expensive and for
  high-stakes decisions only, mitigating over-calling. Auto-council's own gates
  are unchanged.
