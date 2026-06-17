# Live Queue Steering — mid-turn message injection

> Design spec. Status: **approved (Strategy 1)**, pending implementation plan.
> Date: 2026-06-17. Topic owner: muonroi.

## Problem

When the user types a message while a turn is actively streaming, muonroi-cli
queues it and runs it **only after the entire turn finishes** — as a brand-new
turn. The user wants the Claude-Code behaviour: a message typed mid-turn is
**injected into the running turn at the next step boundary**, so it steers the
in-flight task instead of waiting for completion.

## Current state (evidence)

The TUI already has a message queue — it is the *deferred* kind, not steering:

- On submit while busy, the message is pushed to `queuedMessagesRef` and shown
  in a queue box above the composer — `src/ui/app.tsx:6488`. Placeholder becomes
  *"Queue a follow-up… (esc to interrupt)"* — `src/ui/components/prompt-box.tsx:214`.
- The queue is consumed only in `finishTurnProcessing`, which fires **after the
  current turn ends** and shifts the next message into a *new* `processMessage`
  turn — `src/ui/app.tsx:2000`.
- Esc is a two-stage interrupt: stage 1 clears the queue, stage 2 aborts the turn
  — `src/ui/app.tsx:2869`. Up-arrow pops the last queued message back for editing.
- There is **no event bus** between UI and orchestrator. A turn is started by
  calling `agent.processMessage()` and consuming its async generator
  — `src/ui/app.tsx:3033`. The queue lives entirely in the UI.

The enabling mechanism already exists in the repo:

- AI SDK v6 `streamText` calls `prepareStep` at every step boundary; it receives
  the running `messages` and can return `{ messages }` to override what the model
  sees on the next step — type sig `node_modules/ai/dist/index.d.ts:1182-1245`.
- The repo **already** uses `prepareStep` to rewrite messages mid-run (compaction
  + reminder injection) at `src/orchestrator/message-processor.ts:1856-2048`, via
  `attachReminderToMessages` (`src/orchestrator/scope-reminder.ts:179`). Injecting
  a user message there is the same proven pattern.

## Decided behaviour

- **Default = auto-inject at the next step boundary.** A message typed during an
  active turn is injected as a `role:"user"` interjection at the next `prepareStep`
  boundary of the running turn. The model reads it and adjusts the current task.
- **Tail fallback.** If no further step boundary occurs (the turn is already
  wrapping up), the message stays in `queuedMessagesRef` and runs via the existing
  `finishTurnProcessing` as the next turn. No data loss.
- **Esc semantics unchanged** (stage 1 clear / stage 2 abort).

## Strategy (approved: Strategy 1 — `prepareStep` override)

The model finishes its current step; at the boundary, `prepareStep` appends the
queued user message(s) to the `messages` array it returns for the next step.
Smooth, no wasted generation, reuses the existing prepareStep rewrite path.

> Rejected alternative — Strategy 2 (boundary restart): abort the live stream at
> a boundary, push the steer into `deps.messages`, and `continue streamAttempt`
> (the v1.6.4 stall-reprompt precedent). Simpler, but discards and re-generates
> the in-flight step — less smooth. Not chosen.

## Architecture

### 1. Steer inbox (UI → running turn channel)

`deps` gains an optional UI-provided callback:

```ts
// new field on the message-processor deps bag
drainSteerMessages?: () => { text: string }[];
```

- The UI implements it by popping all current entries from `queuedMessagesRef`,
  calling `setQueuedMessages` to update the visual box, and returning their full
  (already @-mention-resolved) `text`.
- Whole app runs in one Bun process / one event loop (React + OpenTUI +
  orchestrator), so a synchronous drain that reads/mutates `queuedMessagesRef`
  from inside `prepareStep` is race-free — no locking needed.
- When `getSteerInjectionEnabled()` is `false`, the callback is not wired;
  behaviour falls back entirely to today's deferred queue.

### 2. Injection at `prepareStep` (`message-processor.ts`)

Turn-scoped accumulator, declared next to the existing per-turn state:

```ts
const pendingSteers: ModelMessage[] = []; // persists across steps within the turn
```

Inside the existing `prepareStep` (after compaction + reminder, before return):

1. Preflight: if `signal.aborted` → skip (no drain, no inject).
2. `const drained = deps.drainSteerMessages?.() ?? []`.
3. Map non-empty `text` → `{ role: "user", content: text }`; push onto
   `pendingSteers`; for each, also push into `deps.messages` and write-ahead
   persist (see §4); emit a `steer-inject` event (see §5).
4. Return `{ messages: [...withReminder, ...pendingSteers] }`.

### 3. Carry-forward / dedup (the crux)

`prepareStep`'s returned `messages` are an override for **that step only**. The
SDK builds the next step's `stepMessages` from the original input messages plus
the *generated* response messages — an injected user message is not a generated
message, so it is **absent** from the next `stepMessages`. Therefore re-appending
the full `pendingSteers` accumulator on every step is correct and does **not**
duplicate, because the SDK base never carries the override forward.

> Implementation must empirically confirm this SDK behaviour. If a given SDK
> build *does* carry override messages into subsequent `stepMessages`, add a
> sentinel marker to each injected message (mirroring the scope-reminder marker
> approach) and strip-before-append to guarantee idempotency. The accumulator +
> optional marker is the safe default either way.

### 4. Persistence

Injected steers are real user turns and must survive in history:

- Push each into `deps.messages` at injection time so the next turn's context and
  any stall/overflow restart of `streamText` include them coherently. Resulting
  order `[userTurn, steer₁, steer₂, …, assistant]` is valid.
- Write-ahead persist each via the existing path (`persistMessageWriteAhead`,
  `src/orchestrator/message-processor.ts:1004`) with `role:"user"` and a `steer`
  flag, so transcript + `usage forensics` reflect them as part of the run rather
  than losing them (the SDK `response.messages` will not contain overrides).

### 5. Observability

New `LiveEvent` kind `steer-inject` `{ count: number, atStep: number, runId: string }`
emitted when injection fires (protocol bump + `docs/agent-harness/PROTOCOL.md`
table entry). Enables the harness E2E to assert injection and lets the TUI show a
subtle `↳ injected` marker.

## Isolation / units

- `planSteerInjection(state)` — a **pure** function (sibling of
  `shouldRepromptStall` in `stall-watchdog.ts`, or a new `steer-inbox.ts`):
  given `{ drained, aborted, enabled }`, returns the `ModelMessage[]` to inject
  (filters empty/whitespace, respects abort, respects enabled). Unit-testable in
  isolation with no SDK or React.
- The orchestrator wiring and the UI drain callback are thin adapters around it.

## Edge cases & error handling

- `signal.aborted` → never drain or inject.
- Empty/whitespace `text` → skipped by `planSteerInjection`.
- Ordering: a user message is appended only at a step boundary, i.e. after the
  prior step's assistant message + its tool results are complete — never inside a
  tool-call ↔ tool-result pair.
- `@`-mention / paste tokens use the submit-time resolved `text` (consistent with
  today's deferred queue). Re-resolving at injection time is out of scope (noted
  as a known limitation).
- No-silent-catch: drain + inject + persist are wrapped with
  `console.error("[steer-inject] …", { context })` on failure, then degrade to
  leaving the message in the queue (tail fallback).

## Scope & config

- **v1 = top-level loop only.** The sub-agent path (`stream-runner.ts` `runStream`)
  is excluded, mirroring the v1.6.4 stall-reprompt scope. Possible follow-up.
- Knob: `MUONROI_STEER_INJECTION` (`0`/`1`, default `1`) read via
  `getSteerInjectionEnabled()` in `src/utils/settings.ts` (env-validated, like
  `getProviderStallRetries`). Not a model/provider id — Zero-Hardcode unaffected.

## Testing

- **Unit** — `planSteerInjection`: FIFO drain, skip empty, respect abort, respect
  disabled. Plus `getSteerInjectionEnabled` env-parse tests (default/in-range/bad).
- **Harness E2E** (mandatory — touches `src/ui/**`): spawn the TUI with a
  multi-step mock turn, type a follow-up mid-turn, assert a `steer-inject`
  `LiveEvent` fires **before** the turn completes (proving injection, not defer).
- **Self-verify Tier 1** required (watched surface `src/ui/**`).
- **Full gate before push**: `bunx tsc --noEmit`, `bunx vitest run`,
  `bunx vitest -c vitest.harness.config.ts run tests/harness/` — all green.

## Risks & known limitations

- SDK carry-forward behaviour must be confirmed empirically (see §3).
- State desync between `queuedMessagesRef` and `setQueuedMessages` already exists
  (Up-arrow / Esc paths); the drain must update both atomically in the same tick.
- Stale `@`-mention file refs at injection time (submit-time resolution kept).
- Sub-agent turns do not steer in v1.

## Files touched (anticipated)

| File | Change |
|---|---|
| `src/utils/settings.ts` | `getSteerInjectionEnabled()` |
| `src/orchestrator/steer-inbox.ts` (new) | `planSteerInjection` pure helper + types |
| `src/orchestrator/message-processor.ts` | `deps.drainSteerMessages`, `pendingSteers`, prepareStep inject, persist, event |
| `src/orchestrator/types.ts` (deps bag) | add `drainSteerMessages?` |
| `src/ui/app.tsx` | wire drain callback to `queuedMessagesRef`; gate on enabled |
| `packages/agent-harness-core/src/protocol.ts` | `steer-inject` LiveEvent kind (protocol bump) |
| `docs/agent-harness/PROTOCOL.md` | document the new event |
| `tests/harness/steer-inject.spec.ts` (new) | E2E |
| `src/orchestrator/steer-inbox.test.ts` (new) | unit |
| `src/utils/settings.test.ts` | `getSteerInjectionEnabled` tests |
