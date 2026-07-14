# convene_council Tool — Implementation Plan (DRAFT for design debate)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is a DRAFT** pending a sub-agent design debate. Full per-step code is
> filled in after the debate reshapes the architecture.

**Goal:** Let the CLI agent (any model, including reasoning models) convene the
multi-model council on demand via a `convene_council` tool, decide from its own
intent what to do with the result (silently continue, or ask the user via an
`ask_user` askcard tool), and hand off to `/ideal` for implementation while
inheriting the council it already ran — with ZERO CLI-hardcoded post-council
branching.

**Architecture:** A process-global one-shot channel (mirroring
`compact-request.ts`) lets the tool queue a council request; the tool-engine
consumes it at a step boundary, runs the existing `runCouncilV2` (rendered via
the existing `yield*` path), splices the synthesis into the tool's `tool_result`
via stop-and-restart, and injects a non-binding suggestion prompt. A new
`ask_user` tool (mirroring `askSafetyOverride`) lets the agent raise its own
askcard. Implementation hand-off reuses `/ideal` via `runProductLoopV1` with a
council-free resume seam.

**Tech Stack:** TypeScript, AI SDK v6 (`ai`), OpenTUI React, Zod/jsonSchema,
Vitest (unit) + agent-harness (`tests/harness/`) E2E.

## Global Constraints

- **Zero Hardcode Rule (CLAUDE.md):** no model/provider ID string literals in
  production code; council resolves models from catalog/settings via
  `runCouncilV2`. No new literals introduced.
- **No CLI hardcode of the post-council decision (user directive):** the CLI may
  ONLY (1) inject context (the synthesis) and (2) inject a non-binding suggestion
  prompt. It MUST NOT hardcode an option set, a continue-vs-ask branch, or an
  implement decision tree. The agent decides; `ask_user` is how it asks the human.
- **No Silent Catch Rule:** every catch logs module + operation + `err.message`.
- **Prerequisite:** the council reasoning-hang fix (branch
  `fix/council-reasoning-hang`, commit 3eb3755b) must be merged first — this
  feature invokes council on reasoning models far more often.
- Tool registered only when council is usable (`configuredRoleCount >=
  getAutoCouncilMinRoles()`).
- Verify per `CLAUDE.md`: `bunx tsc --noEmit`, `bunx vitest run`, harness E2E for
  UI/harness surfaces, `self-verify` Tier 1 on watched surfaces.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/orchestrator/council-request.ts` | Create | Process-global one-shot slot for a queued council request (reason + toolCallId). Mirrors `compact-request.ts`. |
| `src/orchestrator/council-request.test.ts` | Create | Unit: set/peek/consume/reset semantics. |
| `src/tools/registry.ts` | Modify | Register `convene_council` (gated on role count) + `ask_user` builtin tools. |
| `src/orchestrator/ask-user-request.ts` | Create | (If channel-based) OR the `ask_user` deps-callback wiring. Blocking ask pattern mirroring `askSafetyOverride`. |
| `src/orchestrator/tool-engine.ts` | Modify | Consume council request at a step boundary; run `runCouncilV2`; splice synthesis into `tool_result` (stop-and-restart); inject suggestion prompt; thread `askUser` deps; update skip-reasoning message. |
| `src/orchestrator/orchestrator.ts` | Modify | `Agent` `_askUserHandler` + `setAskUserHandler` + dispatch (mirror `setSafetyOverrideHandler`); a `runCouncilForConvene` helper that suppresses the hardcoded post-debate card. |
| `src/council/index.ts` | Modify | Add `suppressPostDebateCard`/`convenePath` option to `runCouncil`/`RunCouncilOptions` so the convene path renders debate+synthesis but SKIPS `pickPostDebateRecommendation` + the `council_question` post-debate card + `postDebateContinuation`. |
| `src/types/index.ts` | Modify | Add `CouncilQuestionPhase` value `"ask-user"`. |
| `src/ui/use-app-logic.tsx` | Modify | Register `ask_user` handler (useEffect mirror of safety-override), ref-map resolver, drain branch in key handler. |
| `src/headless/council-answers.ts` | Modify | Auto-answer path for phase `"ask-user"` so headless never hangs. |
| `src/product-loop/convene-handoff.ts` | Create | synthesis→ProductSpec transform + run-dir persistence (`manifest.json` + `roadmap.md`, no `debate-checkpoint.json`) + trigger `runProductLoopV1({subcommand:"resume", runId})`. |
| `src/product-loop/convene-handoff.test.ts` | Create | Unit: persisted artifacts make `runResume` take the no-checkpoint (council-free) path. |
| `tests/harness/convene-council.spec.ts` | Create | E2E: reasoning-model session, model emits `convene_council` → council-step events → synthesis returns as tool_result → model continues. |
| `tests/harness/ask-user.spec.ts` | Create | E2E: model emits `ask_user` → askcard renders → answer returns as tool_result. |

---

## Task breakdown (bite-sized steps filled after debate)

### Task 1 — `council-request` channel
**Files:** Create `src/orchestrator/council-request.ts` + `.test.ts`.
**Interfaces — Produces:**
- `requestCouncilConvene(reason?: string|null, toolCallId?: string|null): void`
- `hasPendingCouncilConvene(): boolean`
- `consumeCouncilConvene(): { reason: string|null; toolCallId: string|null } | null`
- `__resetCouncilConveneForTests(): void`
TDD: test set→peek→consume→null-after-consume→reset. Mirror `compact-request.test.ts`.

### Task 2 — `convene_council` tool
**Files:** Modify `src/tools/registry.ts`.
**Interfaces — Consumes:** Task 1 channel; `opts.toolCallId` from `dynamicTool` execute.
Register beside `compact`; gate on `configuredRoleCount >= getAutoCouncilMinRoles()`
(thread the count into the registry factory). `execute()` queues the request +
returns a placeholder result (replaced later). Description is explicit that
council is expensive and for high-stakes multi-perspective decisions only.

### Task 3 — council convene-path option (suppress hardcoded post-debate)
**Files:** Modify `src/council/index.ts`, `src/council/types.ts`.
Add `RunCouncilOptions.convenePath?: boolean` (or `suppressPostDebateCard`).
When set: run clarify(optional)+debate+synthesis, but SKIP the
`pickPostDebateRecommendation` + `council_question` post-debate card
(`index.ts:1119-1141`) + `postDebateContinuation`. Return the synthesis to the
caller. This is where the no-hardcode rule is enforced on this path.

### Task 4 — tool-engine consumption (stop-and-restart + tool_result splice)
**Files:** Modify `src/orchestrator/tool-engine.ts`.
- Extend `dynamicStopWhen` to stop the current step when `hasPendingCouncilConvene()`.
- In the restart loop: `consumeCouncilConvene()`; `yield* deps.runCouncilV2(userMessage, { convenePath:true, observer, userModelMessage })`; capture `councilManager.lastSynthesis`.
- Replace the `convene_council` `tool-result` message (matched by `toolCallId`) with the synthesis (or a "council unavailable: <reason>" note when null — logged, not silent).
- Inject a non-binding suggestion prompt as context (Task 5).
- Restart `streamText` so the model reads the synthesis as the tool result and continues.
**Risk (debate focus):** exact AI-SDK message shape for tool-result replacement; fallback = append synthesis as a follow-up message.

### Task 5 — suggestion-prompt injection (context-only, no hardcode)
**Files:** Modify `src/orchestrator/tool-engine.ts` (+ a small pure builder).
After council, inject ONE non-binding suggestion string into context, e.g.:
"Council concluded. If you are in an implementation-discussion with the user and
the conclusion is sufficient to proceed, you MAY ask the user (via `ask_user`)
whether to implement now, then hand off to `/ideal`. Otherwise continue." Pure
builder function, unit-tested for content (no option set, no forced branch).

### Task 6 — `ask_user` model-callable askcard tool
**Files:** Modify `registry.ts`, `orchestrator.ts`, `tool-engine.ts`, `types/index.ts`, `use-app-logic.tsx`, `headless/council-answers.ts`. Mirror `askSafetyOverride` end-to-end.
**Interfaces — Produces:** `deps.askUser({ question, options?, allowFreeText? }) => Promise<{ value: string; freeText?: string }>`; `Agent.setAskUserHandler`; `CouncilQuestionPhase "ask-user"`.
Tool `execute()` awaits `deps.askUser(...)` and returns the user's choice as the
tool result. The question + options are the AGENT's (from tool input), never a
CLI default set.

### Task 7 — skip-reasoning message update
**Files:** Modify `src/orchestrator/tool-engine.ts:793`.
Append: "…or call the `convene_council` tool if THIS task needs multi-model debate."

### Task 8 — `/ideal` inheritance handoff
**Files:** Create `src/product-loop/convene-handoff.ts` + `.test.ts`.
**Interfaces — Consumes:** `councilManager.lastSynthesis`; `runProductLoopV1`.
Transform synthesis → `ProductSpec` JSON (reuse the `loop-driver.ts:940-1011`
prompt), persist `manifest.json` + `roadmap.md`(§Product Specification), ensure
NO `debate-checkpoint.json`, then trigger
`runProductLoopV1({subcommand:"resume", runId})` → enters at planning,
council-free (`index.ts:1990→2033`). Only invoked when the AGENT decides to
implement — never auto-forced.

### Task 9 — E2E + self-verify
`tests/harness/convene-council.spec.ts`, `tests/harness/ask-user.spec.ts`;
`self-verify` Tier 1 on watched surfaces; full `bunx vitest run` + harness green
before push.

---

## Open questions for the design debate

1. **tool_result replacement vs re-entry** — is stop-and-restart with
   tool-result splice the right mechanism, or is a cleaner path available in
   AI-SDK v6? What is the exact message shape, and is the fallback (append
   message) acceptable UX?
2. **No-hardcode compliance** — does a suggestion-prompt reliably produce
   agent-driven behavior, or will weak/cheap models ignore it and never ask?
   Is there a non-hardcoded nudge that is stronger without becoming a forced
   branch?
3. **`ask_user` scope creep** — is a full new askcard tool justified now, or
   should the feature ship convene_council first and add `ask_user` as a
   follow-up? (The user explicitly wants agent-driven asking — likely required.)
4. **/ideal handoff robustness** — the synthesis→ProductSpec transform is new
   and LLM-based; what are its failure modes, and should the handoff degrade to
   "hand the synthesis to the agent and let it drive /ideal manually" if the
   transform fails?
5. **Interaction with the reasoning-hang fix** — anything convene_council must
   do so a convened council that stalls is recovered by the new watchdog path?
