# Harness Event Stream — Reactive Driver API

> **Status:** Draft — 2026-05-17
> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## Context & Motivation

The agent harness currently emits two channel types over the fd3/named-pipe sidechannel:
- `LiveFrame` — semantic tree snapshots (deduped by hash)
- `LiveEvent` — only `toast`, `stream.delta`, and `usage` today

E2E specs like `tests/harness/ideal-e2e-live.spec.ts` compensate with polling loops: `setTimeout → query → press → wait_for(idle) → repeat`. This pattern is brittle because:
- LLM token streaming arrival is unobservable; specs sleep-guess latencies.
- Council phase transitions (opening → round → evaluation → synthesis) are invisible; specs poll `driver.query`.
- Askcard open/close cycle has no event; the spec tight-loops on `driver.query("id=askcard")` at 5-second intervals (Stage 2 of `ideal-e2e-live.spec.ts`, line 258).
- Sprint begin/halt/pass has no boundary event; the spec waits for a terminal modal (`id=ideal-halt-card`).

**Goal:** TUI streams discrete events outward; driver subscribes and reacts step-by-step rather than guessing timing.

---

## Architecture Notes (pre-read findings)

| Component | Location | Role |
|---|---|---|
| `LiveEvent` union | `packages/agent-harness-core/src/protocol.ts` | Wire format for all events |
| `AgentModeRuntime.emitEvent` | `packages/agent-harness-opentui/src/agent-mode.ts:193` | Single emit path: serializes to JSONL and writes to `outStream` |
| `Driver._ingest` | `packages/agent-harness-core/src/driver.ts:220` | Ingests frames/idle/events; notifies `waiters` set |
| `eventBuffer: LiveEvent[]` | `driver.ts:47` | Unbounded ring — no cap today |
| `wait_for({ event: kind })` | `driver.ts:136` | Already present; checks `eventBuffer.some(...)` but has no match-predicate support |
| `last_event(kind)` | `driver.ts:207` | Untyped string `kind` |
| Existing emit sites | `src/ui/app.tsx:2702,2734` | Toast only (LLM error path) |
| Only other emit site | `src/orchestrator/orchestrator.ts:922` | `usage` event via `__muonroiAgentRuntime` globalThis access |

Key observations:
- `CouncilPhaseEvent` already exists in `src/types/index.ts:286` and is yielded as `StreamChunk` of type `"council_phase"` — it's a chunk, not yet a harness event.
- Council phase chunks are processed in `src/ui/app.tsx:2690` via `setCouncilPhases` — the emit point is one line below each `councilPhase` chunk handler.
- Askcard lifecycle is driven by the `CouncilQuestionCard` component (`src/ui/components/council-question-card.tsx`). The card mounts when `activeAskcard` state is set and unmounts on answer/cancel — both transitions are already in `app.tsx`. No `<Semantic>` lifetime hooks today.
- Sprint begin/halt is text-only today (`\n## Sprint N — Planning\n` etc.) from `src/product-loop/sprint-runner.ts`.
- The `runHotPath` / `runStart` routing decision is inline in `src/product-loop/index.ts:103–107`.
- `emitEvent` is synchronous and best-effort; callers wrap in `try/catch`. This convention must be preserved.

---

## Phase 1 — Event Protocol Expansion

**Goal:** Extend `LiveEvent` in `packages/agent-harness-core/src/protocol.ts` with six new discriminated-union members. Existing members (`stream.delta`, `toast`, `usage`, `idle`) remain byte-identical.

**Files touched:**
- `packages/agent-harness-core/src/protocol.ts`

**Tasks:**

- [ ] **1.1 — Add `llm-token` event**
  Add member to `LiveEvent`:
  ```ts
  | {
      t: "event";
      kind: "llm-token";
      /** Correlation ID — matches the `runId` or `callId` passed at emit time. */
      correlationId: string;
      /** The raw text delta exactly as the model returned it. */
      delta: string;
      /** Monotonic token index within this call (0-based). */
      tokenIndex: number;
    }
  ```
  This is the high-volume event. Volume control (Phase 4) will gate it behind `MUONROI_HARNESS_EVENTS` opt-in.

- [ ] **1.2 — Add `llm-done` event**
  ```ts
  | {
      t: "event";
      kind: "llm-done";
      correlationId: string;
      /** Total text chars emitted (not token count — avoids provider coupling). */
      totalChars: number;
      /** Finish reason from the AI SDK: "stop" | "length" | "tool-calls" | "error" | "other". */
      finishReason: string;
    }
  ```

- [ ] **1.3 — Add `council-step` event**
  Bridges the existing internal `CouncilPhaseEvent` to the harness channel:
  ```ts
  | {
      t: "event";
      kind: "council-step";
      phaseId: string;
      /** CouncilPhaseKind string union (not imported here — kept as string to avoid cross-package dep).
       *  Source enum: CouncilPhaseKind in src/types/index.ts */
      phaseKind: string;
      /** "active" | "done" | "error" */
      state: string;
      label: string;
      elapsedMs?: number;
    }
  ```

- [ ] **1.3b — Add `council-speaker` event**
  Bridges `council_status` (role-level speaker turn) to the harness channel. This is distinct from `council-step` which operates at phase granularity; `council-speaker` gives specs per-role visibility (e.g. "has `architect` finished?"):
  ```ts
  | {
      t: "event";
      kind: "council-speaker";
      /** The council role label (e.g. "architect", "security", "qa"). */
      role: string;
      /** "start" — speaker began their turn; "done" — speaker finished. */
      status: "start" | "done";
      /** Round number if available from the status chunk. */
      round?: number;
      /** Correlation ID linking this speaker event to the enclosing council run. */
      correlationId: string;
    }
  ```

- [ ] **1.4 — Add `askcard-open` event**
  ```ts
  | {
      t: "event";
      kind: "askcard-open";
      questionId: string;
      question: string;
      /** "clarify" | "preflight" | "plan-confirm" | "post-debate" */
      phase: string;
      optionCount: number;
      defaultIndex?: number;
    }
  ```

- [ ] **1.5 — Add `askcard-answered` event**
  ```ts
  | {
      t: "event";
      kind: "askcard-answered";
      questionId: string;
      /** "choice" | "freetext" | "chat" */
      answerKind: string;
      /** The answer text. Redacted to "[redacted]" if it contains any API key pattern. */
      answerText: string;
    }
  ```

- [ ] **1.5b — Add `askcard-cancel` event**
  Emitted when the user cancels a question card without answering (`result.emit?.type === "cancel"` path in `app.tsx:~4011`):
  ```ts
  | {
      t: "event";
      kind: "askcard-cancel";
      questionId: string;
    }
  ```

- [ ] **1.6 — Add `sprint-stage` event**
  Fires once per stage transition (planning → implementation → verification → judgment), not once per sprint. This replaces the earlier `sprint-stage` name to make the per-stage semantics unambiguous:
  ```ts
  | {
      t: "event";
      kind: "sprint-stage";
      /** Sprint number (1-based). */
      sprintIndex: number;
      /** Current stage entering. */
      stage: "planning" | "implementation" | "verification" | "judgment";
      runId: string;
    }
  ```

- [ ] **1.7 — Add `sprint-halt` event**
  ```ts
  | {
      t: "event";
      kind: "sprint-halt";
      sprintN: number;
      /** Halt reason as surfaced by the CB gate that fired. */
      reason: string;
      runId: string;
    }
  ```

- [ ] **1.8 — Add `route-decision` event**
  ```ts
  | {
      t: "event";
      kind: "route-decision";
      /** "hot-path" | "council" */
      path: "hot-path" | "council";
      complexity: string;
      forceCouncil: boolean;
      runId: string;
    }
  ```

- [ ] **1.9 — Bump `PROTOCOL_VERSION` to `"0.2.0"`**
  Update the const and verify `LiveFrame.version` type inference still resolves.

**Acceptance criteria:**
- `tsc --noEmit` zero errors in `packages/agent-harness-core`.
- All existing `LiveEvent` literal members still compile unchanged.
- `HarnessMessage = LiveFrame | LiveEvent` widens correctly.
- No changes to any file outside `protocol.ts` in this task.

**Risks:**
- None — additive union extension; no existing code breaks.

---

## Phase 2 — Emit Points

**Goal:** Identify and wire `agentRuntime.emitEvent(...)` at each state transition. No new logic — only event emission alongside existing side effects. Each task is ≤ 2 file edits.

> Convention (carried from existing orchestrator emit at line 917): always wrap in `try { ... } catch { /* best-effort */ }`. The agentRuntime is undefined in normal user mode; calls must never throw into product code.

### 2.1 — Route decision (`src/product-loop/index.ts:103`)

**File:** `src/product-loop/index.ts`

The routing branch already at line 103:
```ts
if (opts.complexity === "low" && !opts.flags.forceCouncil) {
  return yield* runHotPath(opts);
}
return yield* runStart(opts);
```

**Emit point:** Before each branch, after the `runId` is available (it is obtained in `runHotPath` and `runStart` individually). The most practical approach is to emit inside each function at the point where `runId` is known — `runHotPath` at line ~123 after `createRun`, `runStart` at the equivalent location.

**Payload:** `{ kind: "route-decision", path: "hot-path"|"council", complexity: opts.complexity ?? "unknown", forceCouncil: !!opts.flags.forceCouncil, runId }`.

**Depends on:** Task 1.8.

### 2.2 — Council phase transitions (`src/ui/app.tsx` — all three branches)

**File:** `src/ui/app.tsx`

`CouncilPhaseEvent` chunks are consumed by `app.tsx` in THREE separate stream-handling branches:
- Branch 1: `case "council_phase":` at line ~2689 (main stream)
- Branch 2: `if (chunk.type === "council_phase" && chunk.councilPhase)` at line ~3115 (second stream)
- Branch 3: `if (chunk.type === "council_phase" && chunk.councilPhase)` at line ~3271 (third stream / resume path)

**All three branches** must emit the event immediately after their respective `setCouncilPhases(...)` call. The `agentRuntime` ref is already in scope in all three contexts. If wired at only one location, council steps during resume or alternative flows will silently drop events.

**Payload mapping from `CouncilPhaseEvent` (same for all three branches):**
```ts
agentRuntime?.emitEvent({
  t: "event",
  kind: "council-step",
  phaseId: cp.phaseId,
  phaseKind: cp.kind,
  state: cp.state,
  label: cp.label,
  elapsedMs: cp.elapsedMs,
});
```

**Depends on:** Task 1.3.

### 2.2b — Council speaker status (`src/ui/app.tsx` — `council_status` branches)

**File:** `src/ui/app.tsx`

The `council_status` chunk carries per-role speaker turn signals (role-level start/done). There are THREE branches in `app.tsx` handling this chunk type:
- Branch 1: `case "council_status":` at line ~2657
- Branch 2: `if (chunk.type === "council_status" && chunk.councilStatus)` at line ~3085
- Branch 3: `if (chunk.type === "council_status" && chunk.councilStatus)` at line ~3241

**Emit point:** In each branch, immediately after the existing `councilStatus` state-setter call.

**Payload mapping from `CouncilStatusData`:**
```ts
agentRuntime?.emitEvent({
  t: "event",
  kind: "council-speaker",
  role: cs.role,
  status: cs.state === "active" ? "start" : "done",
  round: cs.round,
  correlationId: cs.statusId ?? runId,
});
```

Map `cs.state === "active"` → `"start"`, any terminal state → `"done"`. The `runId` fallback for `correlationId` must be available in scope; verify this per-branch before implementing.

**Depends on:** Task 1.3b.

### 2.2c — Second and third `council_question` branches (`src/ui/app.tsx`)

**File:** `src/ui/app.tsx`

The `setPendingCouncilQuestion` / equivalent setter is invoked in three branches:
- Branch 1: `case "council_question":` at line ~2618 — covered by Task 2.3.
- Branch 2: `if (chunk.type === "council_question" …)` at line ~3062 — **must also emit `askcard-open`**.
- Branch 3: `if (chunk.type === "council_question" …)` at line ~3210 — **must also emit `askcard-open`**.

Apply the same `askcard-open` emit described in Task 2.3 at all three callsites.

**Depends on:** Task 1.4, Task 2.7.

### 2.3 — Askcard open (`src/ui/app.tsx`)

**File:** `src/ui/app.tsx`

The `case "halt":` branch at line ~2721 sets `setActiveHaltCard(chunk.haltChunk)`. Separately, `activeAskcard` state (the `CouncilQuestionCard` path, not the halt card) is set when the council yields a question chunk. Search confirms the question card state is set via a different reducer — look for `setActiveQuestion` or analogous state setter in `app.tsx`.

**Emit point:** At the state setter call that shows the `CouncilQuestionCard` (sets the `question` state driving `<CouncilQuestionCard>`). Emit immediately after the setter.

**Payload:** `{ kind: "askcard-open", questionId: question.questionId, question: question.question, phase: question.phase ?? "clarify", optionCount: question.options?.length ?? 0, defaultIndex: question.defaultIndex }`.

**Depends on:** Task 1.4.

### 2.4 — Askcard answered / cancelled (`src/ui/app.tsx`)

**File:** `src/ui/app.tsx`

The `onAnswer` callback for `CouncilQuestionCard` (invoked by `reduceCardKey` in `council-question-card.tsx` when `emit.type === "answer"`) is wired in `app.tsx`. The answer flows through to the council loop continuation. The cancel path fires when `result.emit?.type === "cancel"` at approximately line 4011 — it currently calls `respondToCouncilQuestion(qid, "")` silently with no harness event.

**Emit point (answer):** At the `onAnswer` handler in `app.tsx`, after the answer is dispatched to the council continuation.

**Payload (answer):** `{ kind: "askcard-answered", questionId: answer.questionId, answerKind: answer.kind, answerText: answer.text }`. Apply redaction rule from Phase 4.3 before emitting.

**Emit point (cancel):** At the cancel branch (`result.emit?.type === "cancel"`, approximately line 4011), after `respondToCouncilQuestion(qid, "")`.

**Payload (cancel):** `{ kind: "askcard-cancel", questionId: qid }`.

**Depends on:** Tasks 1.5, 1.5b, 4.3.

### 2.5 — Sprint stage transitions (`src/product-loop/sprint-runner.ts`)

**File:** `src/product-loop/sprint-runner.ts`

Sprint lifecycle is currently text-only. The sprint runner yields `content` chunks with `\n## Sprint N — Planning\n`, `\n## Sprint N — Implementation\n`, etc. Each of the four stage headers is a clear boundary. Per OQ-2 resolution: `sprint-stage` fires ONCE PER STAGE TRANSITION — four events per sprint.

Access `agentRuntime` via `(globalThis as Record<string, unknown>).__muonroiAgentRuntime` — same pattern already used in `orchestrator.ts:917`.

**Payload:** `{ kind: "sprint-stage", sprintIndex: sprintN, stage: <stage>, runId: ctx.runId }`.

#### 2.5a — Planning stage entry (line ~146)
Emit `{ stage: "planning" }` after the `\n## Sprint N — Planning\n` yield.

#### 2.5b — Implementation stage entry (line ~214)
Emit `{ stage: "implementation" }` after the `\n## Sprint N — Implementation\n` yield.

#### 2.5c — Verification stage entry (line ~228)
Emit `{ stage: "verification" }` after the `\n## Sprint N — Verification\n` yield.

#### 2.5d — Judgment stage entry (line ~255)
Emit `{ stage: "judgment" }` after the `\n## Sprint N — Judgment\n` yield.

### 2.5e — Sprint halt (`src/product-loop/sprint-runner.ts`)

In the CB-gate block where `yield { type: "halt", haltChunk: ... }` is produced (line ~116 and surrounding CB-check logic). Emit **before** yielding the halt chunk so the driver receives the event before the modal appears.

**Payload:** `{ kind: "sprint-halt", sprintN, reason: haltReason, runId: ctx.runId }`.

**Depends on:** Tasks 1.6, 1.7.

### 2.6a — Add `currentCallId` field to the orchestrator model-call wrapper

**File:** `src/orchestrator/orchestrator.ts`

`this._currentCallId` does NOT exist today. It must be added before Task 2.6b can reference it.

**Task:** Add a `private _currentCallId: string = ""` field to the `Orchestrator` class (or the wrapper object that houses the `streamText` call sites). At the start of each `streamText` invocation — both the sub-agent path (~line 1445) and the top-level agentic path (~line 4123) — set:

```ts
this._currentCallId = crypto.randomUUID();
```

Clear it (set to `""`) in the `onFinish` callback after `llm-done` is emitted. This ensures `correlationId` is always a fresh UUID per call, giving specs precise `llm-token → llm-done` pairing.

**Depends on:** Nothing — standalone field addition.

### 2.6b — LLM token stream emit (`src/orchestrator/orchestrator.ts`)

**File:** `src/orchestrator/orchestrator.ts`

The main `streamText` call at line ~1445 iterates `result.fullStream`. Inside the loop at line ~1488, `part` contains text deltas. The loop already counts `textDeltaCount`.

**Emit point (token):** Inside the `for await (const part of result.fullStream)` loop, when `part.type === "text-delta"` (AI SDK v6 shape). Emit one `llm-token` event per delta.

**Payload:** `{ kind: "llm-token", correlationId: this._currentCallId, delta: part.textDelta, tokenIndex: textDeltaCount }`.

**Emit point for `llm-done`:** In the `onFinish` callback at line ~1470, after `this.recordUsage(...)`. Emit `{ kind: "llm-done", correlationId: this._currentCallId, totalChars: contentAccumulatedChars, finishReason: reason ?? "stop" }`. Clear `this._currentCallId = ""` immediately after.

**Note:** This is the high-volume path. The emit must be gated by `isKindAllowed("llm-token")` (Phase 4 filter). If the filter is not loaded yet, default-skip `llm-token`.

**Second streamText site:** `orchestrator.ts:4123` (top-level agentic path). Apply the same pattern — set `this._currentCallId = crypto.randomUUID()` before each `streamText` call.

**Depends on:** Tasks 1.1, 1.2, 2.6a, Phase 4.1.

### 2.7 — Locate `activeAskcard` setter more precisely

**Must complete before Tasks 2.3 and 2.2c.** A subagent must grep `app.tsx` for the exact state setter name and line number for the `CouncilQuestionCard` active state. This is a research-only task, no code changes.

```
Grep "setActiveQuestion\|activeQuestion\|councilQuestion\|setCouncilQuestion\|setPendingCouncilQuestion" in src/ui/app.tsx
```

Output feeds Tasks 2.3 and 2.2c's exact line references. Must appear as a dependency in the execution graph before those tasks run.

---

## Phase 3 — Driver API

**Goal:** Extend `packages/agent-harness-core/src/driver.ts` with typed event access. The ring buffer gets a cap. `wait_for` gains a `match` predicate for events.

**Files touched:**
- `packages/agent-harness-core/src/driver.ts`
- `packages/agent-harness-core/src/protocol.ts` (re-export helper types if needed)

### 3.1 — Cap the event ring buffer

**Task:** Replace `const eventBuffer: LiveEvent[] = []` with a bounded ring. Suggested cap: 1000 events. When full, drop the oldest entry before pushing the newest (FIFO eviction). Add a unit test asserting eviction at cap+1.

```ts
const EVENT_RING_CAP = 1000;
// On push: if (eventBuffer.length >= EVENT_RING_CAP) eventBuffer.shift();
```

**Depends on:** Nothing. Can land standalone.

### 3.2 — Type `last_event` against the new union

**Task:** Change `last_event(kind: string): LiveEvent | null` to an overloaded form:
```ts
last_event<K extends LiveEvent["kind"]>(kind: K): Extract<LiveEvent, { kind: K }> | null;
last_event(kind: string): LiveEvent | null;
```
The implementation already does a `find` scan — only the return type changes. Update the `Driver` exported type accordingly.

**Depends on:** Phase 1 tasks (all new union members must exist before overloads are written).

### 3.3 — Add `match` predicate to `wait_for({ event })`

**Task:** Extend `WaitConditionEvent`:
```ts
type WaitConditionEvent = {
  event: string;
  /** Optional: only satisfy if at least one buffered event of `kind` passes this check. */
  match?: (e: LiveEvent) => boolean;
};
```
Update `buildCheck` in `createDriver` to respect `match`:
```ts
if ("event" in cond) {
  const kind = cond.event;
  const match = cond.match;
  return () => eventBuffer.some(
    (e) => e.t === "event" && e.kind === kind && (match ? match(e) : true)
  );
}
```
Add one unit test: `wait_for({ event: "council-step", match: e => e.state === "done" })` resolves only after a matching event is ingested.

**Depends on:** Task 3.1 (buffer must be stable before adding predicate tests).

### 3.4 — Add `driver.events()` async iterable

**Task:** Add to `Driver` type and `createDriver`:
```ts
events(filter?: (e: LiveEvent) => boolean): AsyncIterable<LiveEvent>;
```

**Critical: return type MUST be `AsyncIterable<LiveEvent>`, NOT `AsyncIterator<...>`.** The spec usage pattern is `for await (const e of driver.events(...))` which requires `[Symbol.asyncIterator]()`, not a bare iterator. An `AsyncIterator` returned directly is not iterable without wrapping.

Implementation: maintain a `Set` of active subscriber objects, each with their own push-queue array and a resolve/reject handle for the pending `next()` promise. The returned object exposes `[Symbol.asyncIterator]() { return this; }` plus `next()` and `return()`:

```ts
// Each call creates an independent subscriber with its own queue.
// Late subscriber: replays all events currently in eventBuffer that pass filter,
// then streams new ones as they arrive.
// Queue cap: PER_SUBSCRIBER_QUEUE_CAP = 256 events (see Task 3.6).
// Cleanup: subscriber is removed from the Set on .return() call.
```

**Termination behavior (REQUIRED — specs deadlock without this):** When the harness shuts down, `driver._closeAllSubscribers()` must be called (wired from the TUI exit / `proc.on("exit")` handler in `test-spawn.ts`). `_closeAllSubscribers()` iterates the subscriber set and resolves each pending `next()` promise with `{ done: true, value: undefined }`, then clears the set. After closure, any subsequent `next()` call on a terminated iterator also returns `{ done: true }` immediately. This guarantees `for await` loops complete cleanly when the TUI exits — no deadlock.

**Replay-on-subscribe:** on each new `events()` call, immediately enqueue all events currently in `eventBuffer` that pass the filter, then begin receiving live pushes. This is essential for: `const it = driver.events(e => e.kind === "council-step"); // subscribes after boot`.

**Unit tests (required):**
1. Subscribe after 3 events already buffered → first 3 yields are replayed events in insertion order.
2. Close all subscribers mid-iteration → `for await` loop exits cleanly (`done: true`), no unhandled rejection.

**Depends on:** Task 3.1, Task 3.6.

**Note:** Do NOT use Node.js `EventEmitter` — the `Driver` type must remain framework-agnostic. Use a plain `Set` of push-queue subscriber objects.

### 3.5 — Update `WaitArgs` type export

`WaitArgs` is currently not exported. Export it so specs can build typed wait objects before calling `wait_for`. Merge acceptance into Task 3.3: "compiles without error after export addition."

### 3.6 — Per-subscriber queue cap (256 events, FIFO eviction)

**Task:** Define `const PER_SUBSCRIBER_QUEUE_CAP = 256` in `driver.ts`. When a subscriber's internal push-queue length reaches the cap, evict the **oldest** event (shift from front) before pushing the new one. This prevents unbounded allocation when `llm-token` events (80–120/sec when enabled) are emitted to a slow or leaked subscriber.

Document this cap in the `driver.events()` JSDoc: `// Under llm-token load (80-120 events/sec), a slow consumer will lose oldest events when its queue exceeds 256. Subscribe with a narrow filter or process events synchronously to avoid loss.`

**Unit test:** Ingest 300 events to a subscriber that never calls `next()`. Assert the queue length is exactly 256 (cap enforced), and the 256 retained events are the LAST 256 ingested (oldest 44 evicted).

**Depends on:** Task 3.1.

### 3.5 — Update `WaitArgs` type export

`WaitArgs` is currently not exported. Export it so specs can build typed wait objects before calling `wait_for`.

---

## Phase 4 — Volume Control & Redaction

**Goal:** Gate high-volume events behind an env allowlist; redact sensitive payload fields before any event hits the wire.

**Files touched:**
- New: `packages/agent-harness-core/src/event-filter.ts`
- `packages/agent-harness-opentui/src/agent-mode.ts` (integrate filter into `emitEvent`)

### 4.1 — `MUONROI_HARNESS_EVENTS` allowlist filter

**Task:** Create `packages/agent-harness-core/src/event-filter.ts`:
```ts
/**
 * Returns a predicate that returns true when an event kind is allowed to be emitted.
 * Default: all kinds except "llm-token" (high volume).
 * Override: set MUONROI_HARNESS_EVENTS=comma,separated,kinds to restrict or expand.
 * Use MUONROI_HARNESS_EVENTS=llm-token,council-step to add token stream.
 * Use MUONROI_HARNESS_EVENTS=* to enable all.
 */
export function createEventFilter(envValue?: string): (kind: string) => boolean;
```

Default allowlist (when env unset):
```
toast, usage, stream.delta, llm-done, council-step, council-speaker, askcard-open, askcard-answered, askcard-cancel, sprint-stage, sprint-halt, route-decision
```
`llm-token` is excluded by default.

When `envValue === "*"`, all kinds pass.

Add unit tests: default blocks `llm-token`; explicit `*` passes everything; comma list works.

### 4.2 — Wire filter into `AgentModeRuntime.emitEvent`

**Task:** In `packages/agent-harness-opentui/src/agent-mode.ts`, create the filter at `startAgentMode` time and apply in `emitEvent`:
```ts
const filter = createEventFilter(process.env["MUONROI_HARNESS_EVENTS"]);
const emitEvent = (e: LiveEvent): void => {
  if (e.t === "event" && !filter(e.kind)) return; // filtered out
  outStream.write(createSidechannelWriter.serialize(e));
  if (e.t === "event" && e.kind === "stream.delta") idle.markActivity();
};
```
The `{ t: "idle" }` pseudo-event bypasses filtering (it is not a `LiveEvent` with `kind`; it's the idle sentinel).

**Depends on:** Task 4.1.

### 4.3 — Redaction layer

**Task:** Create `packages/agent-harness-core/src/event-redact.ts`:
```ts
/**
 * Redacts sensitive strings from event payloads BEFORE serialization.
 *
 * Strategy: allowlist payload fields per event kind. Fields not in the allowlist
 * for a given kind are stripped (set to "[redacted]") rather than relying on a
 * denylist of known-sensitive patterns. This is safer against future payload
 * field additions.
 *
 * Additionally, any string field that matches API_KEY_PATTERN (32+ hex/base64
 * chars, or starts with "sk-") is unconditionally replaced with "[redacted]"
 * regardless of allowlist.
 */
export function redactEvent(e: LiveEvent): LiveEvent;
```

Allowlisted fields per kind:
| kind | allowed string fields |
|---|---|
| `llm-token` | `correlationId`, `delta` (but `delta` capped to 500 chars) |
| `llm-done` | `correlationId`, `finishReason` |
| `council-step` | `phaseId`, `phaseKind`, `state`, `label` |
| `council-speaker` | `role`, `status`, `correlationId` |
| `askcard-open` | `questionId`, `question` (capped to 300 chars + API key pattern check applied), `phase` |
| `askcard-answered` | `questionId`, `answerKind`, `answerText` (API key pattern check applied) |
| `askcard-cancel` | `questionId` |
| `sprint-stage` | `stage`, `runId` |
| `sprint-halt` | `reason`, `runId` |
| `route-decision` | `path`, `complexity` |
| `toast` | `text` (capped to 500 chars) |
| `usage` | all numeric fields pass; `source`, `model` are string-safe |
| `stream.delta` | `target`, `text` (capped to 500 chars) |

API_KEY_PATTERN: `/\b(sk-[A-Za-z0-9]{20,}|[A-Za-z0-9+\/]{32,}={0,2})\b/`

**Wire into `emitEvent` in `agent-mode.ts`** after filtering but before serialization:
```ts
outStream.write(createSidechannelWriter.serialize(redactEvent(e)));
```

Add unit tests:
- `answerText` containing `"sk-1234567890abcdefghij"` → `"[redacted]"`.
- `toast.text` longer than 500 chars → truncated.
- `council-step` with no forbidden fields → passes through unchanged.

**Depends on:** Task 4.2.

### 4.4 — Zero-overhead when `agentRuntime` is unset

**Task:** Document and add a test confirming the existing behavior: in normal user mode (no `--agent-mode`), `(globalThis).__muonroiAgentRuntime` is `undefined`. All emit calls use optional chaining (`agentRuntime?.emitEvent(...)`) or the `try { const rt = ...; if (rt?.emitEvent) ... }` guard pattern already established. No new code needed here — add one unit test in the emit site tests (Phase 6) that imports the sprint runner without setting `__muonroiAgentRuntime` and asserts no throw.

---

## Phase 5 — Spec Rewrite & Docs

**Goal:** Rewrite `ideal-e2e-live.spec.ts` to use the event-driven pattern; add `events.spec.ts` for each new kind; update docs.

### 5.1 — New `tests/harness/events.spec.ts`

**Task:** Create `tests/harness/events.spec.ts` using `--mock-llm` + `--inject-halt` test seam to assert each new event kind fires when expected:

```ts
// Sketch — not the full spec
describe("harness event kinds", () => {
  // Setup: spawnHarness() with mock-llm, boot to idle
  
  it("emits route-decision when /ideal dispatches", async () => {
    driver.type("/ideal --force-council hello"); driver.press("Enter");
    await driver.wait_for({ event: "route-decision", timeoutMs: 10_000 });
    const e = driver.last_event("route-decision");
    expect(e?.path).toBe("council"); // --force-council overrides hot-path
  });

  it("emits council-step events during debate", async () => {
    // Wait for at least one council-step with state=active
    await driver.wait_for({
      event: "council-step",
      match: (e) => e.kind === "council-step" && e.state === "active",
      timeoutMs: 30_000,
    });
    expect(driver.last_event("council-step")).not.toBeNull();
  });

  it("emits askcard-open when question card appears", async () => {
    await driver.wait_for({ event: "askcard-open", timeoutMs: 60_000 });
    const e = driver.last_event("askcard-open");
    expect(e?.optionCount).toBeGreaterThan(0);
  });

  it("emits askcard-answered after Enter on default option", async () => {
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 10_000 });
    driver.press("Enter");
    await driver.wait_for({ event: "askcard-answered", timeoutMs: 5_000 });
    const e = driver.last_event("askcard-answered");
    expect(e?.answerKind).toBe("choice");
  });

  it("emits sprint-halt when CB-3 fires (--inject-halt)", async () => {
    // --inject-halt seam triggers synthetic halt
    await driver.wait_for({ event: "sprint-halt", timeoutMs: 10_000 });
    const e = driver.last_event("sprint-halt");
    expect(e?.sprintN).toBe(1);
  });
});
```

The spec is gated on mock-llm (not `MUONROI_E2E_LIVE`) so it runs in CI. `--inject-halt` test seam already exists in `src/index.ts`.

**Depends on:** Phase 1, Phase 2, Phase 3 (all).

### 5.2 — Rewrite `tests/harness/ideal-e2e-live.spec.ts` Stage 2

**Task:** Replace the polling loop in Stage 2 (lines 254–270) with the event-driven pattern:

Current (polling, brittle):
```ts
while (Date.now() - start < target) {
  const halt = driver.query("id=ideal-halt-card");
  if (halt) break;
  const askcard = driver.query("id=askcard");
  if (askcard) { driver.press("Enter"); ... }
  await new Promise((r) => setTimeout(r, pollMs));
}
```

Target (event-driven):
```ts
const events = driver.events(e =>
  e.kind === "askcard-open" || e.kind === "sprint-halt"
);
for await (const e of events) {
  if (e.kind === "askcard-open") {
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    driver.press("Enter");
    askcardsAccepted++;
    continue;
  }
  if (e.kind === "sprint-halt") break;
}
await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 15_000 });
```

The `setTimeout` sleep inside the loop is eliminated. The outer `target` wall-clock guard is replaced by the `timeoutMs` on `wait_for`.

**Depends on:** Tasks 1.4, 1.7, 3.4.

### 5.3 — CI gate for the harness suite

The `ideal-e2e-live.spec.ts` spec **cannot** be made unconditionally runnable — it costs real LLM tokens (~$0.20/run), takes 10–15 minutes, requires a keychain API key, and is intentionally gated on `MUONROI_E2E_LIVE=1`. It must remain gated. The CI gate deliverable is therefore split:

#### 5.3a — Confirm `events.spec.ts` runs unconditionally in the default harness suite

Task 5.1 creates `tests/harness/events.spec.ts` using `--mock-llm` — no real tokens, no `MUONROI_E2E_LIVE` guard. Verify the spec has **no** `describe.skipIf`, `describe.skip`, or `MUONROI_E2E_LIVE` guard. The filename `events.spec.ts` matches the glob `tests/harness/**/*.spec.ts` in `vitest.harness.config.ts` — confirmed by reading that file (glob is `tests/harness/**/*.spec.ts`). No change to config needed; the spec runs automatically.

**Acceptance criteria:** `bunx vitest -c vitest.harness.config.ts run tests/harness/events.spec.ts` passes in CI without any env vars.

#### 5.3b — Update `ideal-e2e-live.spec.ts` header comment only

Update the STATUS comment in `ideal-e2e-live.spec.ts` from "reference/manual-only. NOT a CI gate." to: "NOT a default CI gate (costs real tokens). Run manually or in nightly via MUONROI_E2E_LIVE=1. The mock-LLM events.spec.ts is the default CI gate for event-driven flow correctness."

Do NOT remove `describe.skipIf(!LIVE)` — the spec must remain guarded.

#### 5.3c — Create `.github/workflows/harness.yml`

No `.github/workflows/` directory exists in the repo. Create `.github/workflows/harness.yml` as the CI gate for the harness suite:

```yaml
name: Harness Suite

on:
  push:
    branches: ["**"]
  pull_request:
    branches: ["**"]

jobs:
  harness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bunx vitest -c vitest.harness.config.ts run tests/harness/
```

The `MUONROI_E2E_LIVE` flag is intentionally absent so `ideal-e2e-live.spec.ts` skips automatically. Only `events.spec.ts` and other unconditional harness specs run.

**Nightly with live LLM:** If a nightly pipeline is added in future, set `MUONROI_E2E_LIVE: "1"` in that job's `env:` block. Document this in the workflow file comment.

**Depends on:** Task 5.2, Task 5.1.

### 5.4 — Update `CLAUDE.md` — "Event-driven E2E pattern" section

**Task:** Add a new section to `D:\sources\Core\muonroi-cli\CLAUDE.md` immediately after "Driver API cheat sheet":

```markdown
## Event-driven E2E pattern

Instead of polling `driver.query()` in a sleep loop, subscribe to the event stream:

### Reacting to modal lifecycle

```ts
// Subscribe before dispatching the command so no events are missed.
const events = driver.events(e =>
  e.kind === "askcard-open" || e.kind === "sprint-halt"
);
driver.type("/ideal --force-council build X"); driver.press("Enter");

for await (const e of events) {
  if (e.kind === "askcard-open") {
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    driver.press("Enter"); // accept default
    continue;
  }
  if (e.kind === "sprint-halt") break;
}
```

### Wait for a specific council phase to complete

```ts
await driver.wait_for({
  event: "council-step",
  match: (e) => e.kind === "council-step" && e.phaseKind === "synthesis" && e.state === "done",
  timeoutMs: 60_000,
});
```

### `driver.events()` late-subscribe note

The iterator replays all events already in the buffer (cap 1000) before streaming new ones. Subscribing after a fast event fires still captures it. No event is lost between `spawnHarness()` and `events()` call.
```

**Depends on:** Phase 3 (3.4).

### 5.5 — Update `packages/agent-harness-core/README.md` event protocol section

**Task:** Add a table of all new event kinds with their payloads and volume notes to the "Event protocol" section of `packages/agent-harness-core/README.md`. Include the `MUONROI_HARNESS_EVENTS` env var documentation.

---

## Phase 6 — Verification

**Goal:** Unit tests for emit points + TypeScript strict + existing suite stays green.

### 6.1 — Unit tests for council-step emit (Tasks 2.2, 2.2b)

**Task:** Add tests to `src/ui/__tests__/` (or alongside `app.tsx` test file if it exists) that mock `agentRuntime` and assert:
1. `emitEvent` is called with `kind: "council-step"` when a `council_phase` chunk is processed in each of the three branches (main, second, third).
2. `emitEvent` is called with `kind: "council-speaker"` when a `council_status` chunk is processed in each of the three branches.

Pattern:
```ts
const emitEvent = vi.fn();
(globalThis as any).__muonroiAgentRuntime = { emitEvent };
// render app with a mock stream that yields a council_phase chunk
// assert emitEvent.mock.calls[0][0].kind === "council-step"
// repeat for council_status → council-speaker
```

### 6.2 — Unit tests for askcard-open/answered/cancel emit (Tasks 2.3, 2.4)

**Task:** Same mock pattern; assert:
- `askcard-open` fires when the question card state becomes non-null (all three `council_question` branches).
- `askcard-answered` fires when `onAnswer` is called.
- `askcard-cancel` fires when the cancel path (`result.emit?.type === "cancel"`) is triggered.

### 6.3 — Unit tests for sprint-stage/halt emit (Tasks 2.5a–2.5e)

**Task:** Unit test for `runSprint` that sets `__muonroiAgentRuntime` to a mock, runs `runSprint` with a minimal `SprintContext`, and asserts:
- `sprint-stage` events fire at ALL FOUR stage entry points: planning, implementation, verification, judgment.
- `sprint-halt` fires with the correct `reason` and `sprintN`.

**Note:** Sprint-runner is an `async function*` — tests can collect chunks and assert side effects on the mock. Use the existing `sprint-runner.test.ts` mock setup at lines 129 and 265 as the starting template (see N5 in the review); it already stubs `runCouncil` and `buildVerifyAgent`.

### 6.4 — Unit tests for route-decision emit (Task 2.1)

**Task:** Unit test that calls `runHotPath` and `runStart` with minimal opts and a mock `agentRuntime`, asserts `route-decision` event fires with the correct `path` field.

### 6.5 — Unit tests for event-filter (Task 4.1)

Already specified in Task 4.1. Mark done when implemented.

### 6.6 — Unit tests for redaction (Task 4.3)

Already specified in Task 4.3. Mark done when implemented.

### 6.7 — Unit test for ring buffer cap (Task 3.1)

Already specified in Task 3.1. Mark done when implemented.

### 6.8 — Unit tests for `driver.events()` replay + termination + cap (Tasks 3.4, 3.6)

Already specified in Tasks 3.4 and 3.6. Mark done when all three unit tests pass:
1. Replay: subscribe after 3 buffered events → 3 replayed in insertion order.
2. Termination: `_closeAllSubscribers()` → `for await` completes cleanly, no deadlock.
3. Cap: 300 events ingested to unconsumed subscriber → queue length exactly 256, last 256 retained.

### 6.9a — Unit test for `currentCallId` field (Task 2.6a)

**Task:** Unit test that creates an `Orchestrator` instance (or the enclosing class), calls the `streamText` wrapper with a mock AI SDK, and asserts:
- `_currentCallId` is a non-empty UUID at the point `llm-token` is emitted.
- `_currentCallId` is `""` after `llm-done` is emitted.
- Two consecutive `streamText` calls produce different `correlationId` values.

### 6.9 — TypeScript strict pass

**Task:** After all tasks complete: `bunx tsc --noEmit` from repo root. Fix any newly introduced type errors. Expected: 0 errors. Pre-existing PIL failures (4 known) remain baseline noise.

### 6.10 — Existing harness suite still passes

**Task:** `bunx vitest -c vitest.harness.config.ts run tests/harness/` — all previously passing specs keep passing. The new `events.spec.ts` is an additive gate.

---

## Dependency Graph (critical path)

```
Phase 1 (protocol: 1.1–1.9 incl. 1.3b, 1.5b, renamed 1.6 → sprint-stage)
    ├──► Phase 3.2 (typed last_event)
    └──► Phase 2 (all emit tasks)
              ├── 2.2 (council-step, all 3 branches)  ─ depends 1.3
              ├── 2.2b (council-speaker, all 3 branches) ─ depends 1.3b
              ├── 2.2c (council_question branches 2+3) ─ depends 1.4, 2.7
              ├── 2.3 (askcard-open)                   ─ depends 1.4, 2.7
              ├── 2.4 (askcard-answered + cancel)      ─ depends 1.5, 1.5b, 4.3
              ├── 2.5a–2.5d (sprint-stage ×4)         ─ depends 1.6
              ├── 2.5e (sprint-halt)                   ─ depends 1.7
              ├── 2.6a (currentCallId field)           ─ no deps
              └── 2.6b (llm-token/done emit)           ─ depends 1.1, 1.2, 2.6a, 4.1
                       │
                       ▼
Phase 4.1 (filter) ──► 4.2 (wire) ──► 4.3 (redact)
             (needed before 2.6b llm-token)

Phase 3.1 (ring cap) ──► 3.3 (wait_for match)
         └──► 3.6 (per-subscriber cap 256) ──► 3.4 (events iterable + termination)
                                                        │
                                                        ▼
                                                   Phase 5.2 (spec rewrite)
                                                   Phase 5.1 (events.spec.ts)
                                                   Phase 5.3a–5.3c (CI gate)

Phase 6 tests run after respective Phase 2 + Phase 3 tasks.
2.7 (research) must precede 2.3 and 2.2c — shown in execution order.
```

Phases 1, 3.1, 3.6, and 4.1 can run in parallel. Task 2.6a can run alongside Phase 1 (no protocol dependency).

---

## Risks

### R1 — `llm-token` volume at high throughput (HIGH)
DeepSeek Flash can emit 80–120 tokens/sec. At peak, the JSONL sidechannel receives 80–120 events/sec additional load. Named-pipe + JSONL is synchronous-write — back-pressure could delay the TUI render loop.

**Mitigation:** `llm-token` is off by default (`MUONROI_HARNESS_EVENTS` allowlist). When enabled, the emit is a `try { ... } catch {}` best-effort; if the write buffers, the TUI continues. Benchmark in Task 2.6: measure `outStream.write` latency under 100 msg/sec; if p99 > 2ms, add a background drain queue.

### R2 — Late-subscribe replay semantics for `driver.events()` (MEDIUM)
If the test subscribes after a fast event fires (e.g., `route-decision` fires 50ms after `/ideal` is typed), the replay from the ring buffer catches it. But if the buffer eviction cap (1000) is hit before the subscriber reads, very early events are lost. This is acceptable for long sessions but must be documented.

**Mitigation:** Cap 1000 is generous for any single test spec. Document in `CLAUDE.md` that `events()` should be called before dispatching the command if the first event fires early. The spec pattern in Task 5.2 already does this correctly.

### R3 — Redaction false positives / negatives (HIGH)
The API-key regex pattern could over-match base64 content (e.g., a hash in a council step label). Could also under-match if key format changes.

**Mitigation:** Allowlist approach (Task 4.3) is safer than denylist — only explicitly listed fields pass, unknown fields are dropped. The regex is a secondary safety net on top of field allowlisting. Test with a mock event containing a synthetic key in each known-sensitive field.

### R4 — `app.tsx` import weight for `emitEvent` calls (LOW)
`app.tsx` is already the heaviest file (~5300 lines). Adding 3 more `agentRuntime?.emitEvent(...)` calls adds negligible weight. No risk.

### R5 — Backward compat: `wait_for({ event: kind })` semantics change (LOW)
The existing `WaitConditionEvent` check (`eventBuffer.some(e => e.t === "event" && e.kind === kind)`) does not respect `match`. Adding `match` is purely additive (undefined means no filter). Existing specs that use `wait_for({ event: "toast" })` are unaffected.

### R6 — `PROTOCOL_VERSION` bump to `"0.2.0"` breaks MCP harness-driver (LOW)
The `mcp-driver` subcommand (`src/mcp/harness-driver.ts`) may expose the protocol version to MCP clients. Bumping from `0.1.0` to `0.2.0` is semver-minor (additive). MCP clients that hard-check the exact version string will need updating.

**Mitigation:** Grep `PROTOCOL_VERSION` usages before Task 1.9; update any comparison or assertion that checks the exact string.

---

## Open Questions

### OQ-1 — `correlationId` for LLM token events — RESOLVED
**Resolution:** Per-`streamText`-call UUID via `this._currentCallId` (Tasks 2.6a, 2.6b). Field must be added to the orchestrator class; set at start of each `streamText` call, cleared after `llm-done` emits.

### OQ-2 — `sprint-stage` stage granularity — RESOLVED
**Resolution:** Renamed to `sprint-stage`. Fires once per stage transition — four events per sprint (planning / implementation / verification / judgment). Tasks 2.5a–2.5d cover all four entry points in `sprint-runner.ts`.

### OQ-3 — Halt card vs. askcard naming — ADVISORY (no blocker)
The codebase has two separate modal kinds:
- `CouncilQuestionCard` (id=`askcard`) — clarification questions yielded by the council loop
- `HaltRecoveryCard` (id=`ideal-halt-card`) — CB-gate halt with recovery options

**Resolution:** `sprint-halt` (Task 2.5e) + `askcard-cancel` (Task 1.5b / 2.4) cover the needed signals. `halt-open` / `halt-option-chosen` events deferred to a follow-on plan. The rewritten spec (Task 5.2) uses `sprint-halt` + `id=ideal-halt-card` Semantic — sufficient for this iteration.

---

## Task Count & Complexity Summary

| Phase | Tasks | Complexity |
|---|---|---|
| Phase 1 — Protocol | 11 (incl. 1.3b `council-speaker`, 1.5b `askcard-cancel`, renamed 1.6 `sprint-stage`) | Low — additive union members, zero logic |
| Phase 2 — Emit points | 13 (2.2/2.2b/2.2c multi-branch; 2.4 cancel; 2.5a–e; 2.6a/b; 2.7 research) | Medium — multiple branches per site; `_currentCallId` addition |
| Phase 3 — Driver API | 6 (incl. new 3.6 per-subscriber cap; 3.4 returns `AsyncIterable`) | Medium — ring cap trivial; `events()` iterable + termination moderately complex |
| Phase 4 — Volume/Redaction | 4 | Medium — filter trivial; redaction allowlist requires care |
| Phase 5 — Specs & Docs | 7 (5.3 expanded to 5.3a/b/c incl. CI workflow) | Low–Medium — spec rewrite straightforward once Phase 3 lands |
| Phase 6 — Verification | 12 (incl. 6.9a `currentCallId`, updated 6.3 for 4 stages) | Low — unit tests per emit site |
| **Total** | **53** | — |

**Critical path:** Phase 1 → Phase 2 (emit sites) + Phase 3 (driver) in parallel → Phase 4 → Phase 5 → Phase 6.

**Estimated effort:** 3–4 focused dev sessions. Phase 1 + 4.1 + 2.6a in session 1; Phase 2 + Phase 3 in session 2; Phase 4.2–4.3 + Phase 5 in session 3; Phase 6 + tsc pass in session 4.

**Top 3 risks:** R1 (llm-token volume — default-off mitigates), R3 (redaction false negative/positive — allowlist design mitigates), R2 (late-subscribe replay — cap + documented pattern mitigates).

**User input no longer required:** OQ-1 resolved → per-`streamText`-call UUID via `_currentCallId` (Tasks 2.6a/b). OQ-2 resolved → `sprint-stage` fires per-stage-transition, four events per sprint (Tasks 2.5a–d). OQ-3 advisory — `sprint-halt` + `askcard-cancel` added; halt-card open/close events deferred to follow-on.

---

## Revision log

> 2026-05-17 — Applied cross-verifier findings from `2026-05-17-harness-event-stream-REVIEW.md`

- **B1** — Added `council-speaker` event (Task 1.3b); added Task 2.2b covering all three `council_status` branches in `app.tsx`; added Task 2.2c covering second/third `council_question` branches; added `askcard-cancel` event (Task 1.5b) and cancel emit to Task 2.4; updated default allowlist and redaction table to include new kinds.
- **B2** — Corrected `driver.events()` return type from `AsyncIterator` to `AsyncIterable<LiveEvent>`; specified termination behavior (`_closeAllSubscribers()` → `done: true` on TUI exit, no deadlock); added Task 3.6 for per-subscriber queue cap of 256 with FIFO eviction; updated Task 3.4 acceptance criteria to require termination unit test.
- **B3** — Replaced Task 5.3 with 5.3a/5.3b/5.3c: 5.3a confirms `events.spec.ts` runs unconditionally (glob match verified in `vitest.harness.config.ts`); 5.3b updates `ideal-e2e-live.spec.ts` header comment only (spec remains `MUONROI_E2E_LIVE`-gated — cannot remove due to real token cost); 5.3c creates `.github/workflows/harness.yml` as the concrete CI artifact (no workflows dir existed).
- **OQ-1** — Split Task 2.6 into 2.6a (add `_currentCallId: string` field, set `crypto.randomUUID()` at each `streamText` call, clear after `llm-done`) and 2.6b (emit using the field); added Task 6.9a for `currentCallId` unit tests.
- **OQ-2** — Renamed `sprint-begin` event to `sprint-stage` throughout; expanded Task 2.5 into 2.5a–2.5d (all four stage entry points in `sprint-runner.ts`) + 2.5e (halt); updated Phase 6.3 to assert all four stage events; updated Protocol section 1.6 payload to use `sprintIndex` + `stage` union.
