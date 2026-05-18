# Plan: Fix drain pipeline stall on q5+ askcard — `/ideal --force-council`

**Date:** 2026-05-17
**Bug ref:** `docs/bugs/2026-05-17-ideal-leader-unavailable-loop.md` (follow-up #2)
**Branch:** `feat/bb-aware-ideal`
**Priority:** P1 — blocks all E2E tests that reach q5+

---

## 1. Root cause (confirmed)

### Execution model

The drain loop in `src/product-loop/loop-driver.ts:276-298` runs inside an
`async function*` generator (`runLoopDriver`). Its consumer is
`runStart` → `while (true) { const { value, done } = await driverGen.next() }`.
That generator chain is itself consumed by the `for await` in
`orchestrator.ts:2405`.

All three layers are `async` generators consuming each other via `await
gen.next()`. Each `yield` suspends the generator and gives control back to the
caller — who then `await`s the next `.next()` call. This is a cooperative
microtask chain: every resume is a microtask scheduled by Promise resolution.

### The stall mechanism

Inside `loop-driver.ts`, the drain while-loop does:

```ts
// drain inner queue
while (gatherEmitted.length > 0) {
  yield c;   // suspends generator, schedules caller via microtask
}
// *** STUCK HERE ***
await new Promise<void>((r) => setTimeout(r, 50));  // macrotask
```

After q5's `council_question` chunk is pushed to `gatherEmitted` and yielded
to the consumer, `gatherEmitted` is empty. The drain loop moves to
`setTimeout(r, 50)`. This schedules a **macrotask** (timer phase of the event
loop).

Meanwhile, `gatherTask` (the async function that called `buildLiveTuiAsk`) is
suspended at `await respondToQuestion(q5)` — a Promise that will resolve only
when `respondToCouncilQuestion(q5, answer)` is called from `app.tsx`.

For `respondToCouncilQuestion` to be called, `app.tsx` must:
1. Receive the `council_question` chunk (already done — it was yielded).
2. Render the askcard modal via `setPendingCouncilQuestion`.
3. Wait for user interaction (or harness `press`/`type` command).

The critical gap: **step 2 (React re-render) requires OpenTUI's reconciler to
flush**. OpenTUI's reconciler is driven by `renderer`'s internal frame loop,
which uses — confirmed from `packages/agent-harness-opentui/src/install.ts` and
context — a `setInterval`-based tick at 60 fps.

**`setInterval` and `setTimeout` are both macrotasks.** The Bun/Node event
loop processes at most one macrotask per iteration. When the drain loop's
`setTimeout(50)` fires, it reschedules another `setTimeout(50)` (next loop
iteration). The OpenTUI reconciler tick (`setInterval(trySend, ~16ms)`) is also
a macrotask. These two **compete** in the macrotask queue.

The evidence shows the 50ms `setTimeout` never fires for 450s while leader
HTTP fetch (a microtask chain via async fetch / libcurl) did complete. This
is consistent with OpenTUI holding the reconciler in a synchronous paint burst
when the askcard modal is first mounted — flooding the macrotask queue with
back-to-back `setInterval` ticks that starve the 50ms `setTimeout` from ever
reaching the head of the queue.

**Summary:** The drain loop's `setTimeout(50)` yields to macrotasks but the
renderer's `setInterval` floods the macrotask queue, preventing the drain
tick from firing. The generator stalls indefinitely at the `setTimeout` await.
`respondToQuestion(q5)` never settles, so the `[responder] register-resolver
q5` entry is never drained.

### Why q5 and not q1-q4?

q1-q4 worked because the sequence was:
1. emit chunk → yield → caller consumes → React renders → setTimeout fires
   before next tick interval.

At q5, Layer B retry logic had already mounted a complex modal state
(3× productType retries + 1× targetPlatform). The reconciler's re-render
work is heavier on q5's first render, amplifying the macrotask starvation.

---

## 2. Option analysis

### Option A — Quick patch: replace `setTimeout` with microtask yield (recommended)

Replace the poll sleep with a microtask-based yield that does NOT go through
the macrotask queue:

```ts
// Before:
await new Promise<void>((r) => setTimeout(r, 50));

// After:
await Promise.resolve();
```

`Promise.resolve()` schedules the continuation as a **microtask**, which runs
at the end of the current macrotask before the next `setInterval` tick can
fire. This lets the drain loop spin tight without starving behind the renderer.

**Concern:** tight microtask spin with no sleep could pin the CPU. Mitigate:
add a `queueMicrotask`-based yield every N iterations with a 0ms macrotask
escape hatch:

```ts
// Hybrid approach:
_drainTick++;
if (_drainTick % 10 === 0) {
  // Every 10 microtask spins, yield one macrotask turn so the renderer can
  // service its setInterval tick. Prevents CPU pin without starving the drain.
  await new Promise<void>((r) => setTimeout(r, 0));
} else {
  await Promise.resolve();
}
```

- **Effort:** 30 min (1 file change, 1 unit test update)
- **Risk:** Tight spin adds CPU overhead between q drain ticks. Mitigated by
  the 10x hybrid cadence. May interact poorly with slow machines if drain loop
  spins 10k+ times for a large batch.
- **Test coverage:** Existing drain unit tests cover steady-state; add a test
  that stalls `setTimeout` via fake timers to assert drain still advances.

### Option B — Event-driven resolver: eliminate polling entirely (mid)

Instead of a polling drain loop, use an event-driven design where `gatherTask`
notifies the generator each time a new chunk is pushed:

```ts
// Signal emitter shared between gatherTask and drain loop
const signal = new EventEmitter(); // or a manual Promise chain
const tuiAsk = buildLiveTuiAsk(
  (chunk) => { gatherEmitted.push(chunk); signal.emit('chunk'); },
  ctx.respondToQuestion,
);

// Drain: await signal or gatherDone
while (!gatherDone.value) {
  if (gatherEmitted.length === 0) {
    await new Promise<void>((r) => signal.once('chunk', r));
  }
  while (gatherEmitted.length > 0) {
    yield gatherEmitted.shift() as StreamChunk;
  }
}
```

This removes the sleep/poll entirely — drain wakes exactly when a chunk is
available, not on a timer.

- **Effort:** 2-3 hours (refactor loop-driver + gather, add integration test)
- **Risk:** EventEmitter inside an async generator is subtle; need to guard
  against the signal firing before `once` is registered (use a boolean flag +
  re-check after registering). Adds a new abstraction that all future gather
  phases must honor.
- **Regression:** `buildLiveTuiAsk`'s `emit` callback must remain synchronous
  (already is) to guarantee the push happens before the signal fires.

### Option C — Refactor drain to a streaming pipeline (long)

Replace the manual queue + drain loop with an async iterable pipeline:

```ts
async function* streamGather(io): AsyncGenerator<StreamChunk> {
  // buildLiveTuiAsk becomes an async generator that yields chunks directly
}
for await (const chunk of streamGather(io)) {
  yield chunk;
}
```

Eliminates the queue and drain loop entirely. Gather phase emits directly via
`yield` inside a generator, consumer pulls naturally.

- **Effort:** 1-2 days (full refactor of gather.ts + loop-driver.ts gather case)
- **Risk:** Large surface change; requires updating every callsite of
  `runGatherPhase`. Blocks on Task 16 (`buildDiscoveryDebateRunner`) which is
  still a stub.
- **Benefit:** Architecturally correct; removes the race class entirely.

---

## 3. Recommended approach

**Option A (hybrid microtask/macrotask poll)** for immediate unblock.
Option B as a follow-up cleanup task (can be done in the same sprint without
blocking E2E).

Rationale:
- Option A is a single-line change in one file with a clear correctness
  argument (microtasks run before the next `setInterval` tick).
- The hybrid `% 10 === 0 → setTimeout(0)` gate gives the renderer one
  macrotask slot per 10 drain spins, preventing CPU starvation while
  ensuring the drain never gets stuck behind an `setInterval` flood.
- Option B eliminates the poll class entirely but requires an EventEmitter
  or similar — adds non-trivial complexity for the same functional outcome.

---

## 4. Task breakdown

### Task 1 — Fix drain poll scheduler (30 min)

**File:** `src/product-loop/loop-driver.ts`

Replace line 291:
```ts
// BEFORE
await new Promise<void>((r) => setTimeout(r, 50));

// AFTER (hybrid microtask/macrotask)
if (_drainTick % 10 === 0) {
  // Every 10 microtask spins, yield a macrotask turn so setInterval-based
  // renderers (OpenTUI) can service their frame tick.
  await new Promise<void>((r) => setTimeout(r, 0));
} else {
  // Microtask yield: resumes before next setInterval fires.
  await Promise.resolve();
}
```

The `_drainTick` counter is already in place. No other changes needed in this
task.

### Task 2 — Unit test: drain loop advances under stalled setTimeout (45 min)

**File:** `src/product-loop/__tests__/loop-driver-drain.spec.ts` (new or
extend existing)

Using Bun's `vi.useFakeTimers()` (or equivalent), freeze macrotask timers and
verify that the drain loop still yields all chunks in `gatherEmitted` before
`gatherDone` becomes true. Without the fix, this test would hang. With the
fix, microtask ticks advance the drain independent of the frozen timer clock.

```ts
it("drain loop advances under stalled setTimeout", async () => {
  vi.useFakeTimers();
  // ... setup gatherEmitted with 3 chunks, gatherDone=false initially
  // advance time by 0 (no macrotasks) — drain should still flush via microtasks
  // then set gatherDone=true
  // assert all 3 chunks were yielded
  vi.useRealTimers();
});
```

### Task 3 — Debug log: emit `[drain] scheduler=microtask` on tick type (10 min)

Optional but useful for diagnostics: extend the existing `[drain] tick=` log
to show whether the current tick used `setTimeout(0)` or `Promise.resolve()`:

```ts
if (_drainDbg && _drainTick % 20 === 0) {
  const tickType = _drainTick % 10 === 0 ? "macrotask(0)" : "microtask";
  process.stderr.write(`[drain] tick=${_drainTick}, queue=${gatherEmitted.length}, done=${gatherDone.value}, scheduler=${tickType}\n`);
}
```

### Task 4 — E2E verification (20 min)

Re-run the live E2E against `feat/bb-aware-ideal` with `--force-council` and
`MUONROI_DEBUG_LEADER=1`. Confirm:
1. `[drain] tick=` lines appear at the expected ~10x cadence.
2. q5 yields through within <5s of q4 being answered.
3. No `<silence 450s>` gap in stderr.
4. `sprint-halt` event fires (Layer B still handles required-skip path).

---

## 5. Verification plan

### Unit (automated)

- Task 2 spec: drain loop advances with frozen timers.
- Existing drain tests continue to pass unchanged (no regression).
- Run: `bunx vitest run src/product-loop/__tests__/`

### Integration (E2E harness)

- Run existing `tests/harness/` suite — specifically `ideal-flow.spec.ts` (or
  equivalent) that covers q1-q5 path with `--force-council`.
- Assert `askcard-open` harness event fires for all 5 questions.
- Assert `sprint-halt` or `council-step` fires after q5 answer.
- No test should time out at 450s boundary.
- Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/`

---

## 6. Risk and mitigation

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Tight microtask spin causes CPU spike on slow machines | Low | Hybrid `% 10` gate gives renderer a macrotask slot every 10 spins (~10-16ms). |
| `Promise.resolve()` still not enough (renderer holds microtask queue) | Very low | Microtasks are always drained before the next event-loop tick, regardless of `setInterval`. No renderer can block microtasks. |
| Other drain-like loops in codebase also use `setTimeout(50)` | Low | Only `loop-driver.ts:291` uses this pattern in a hot generator path. `llm.ts:708,816` use `Promise.race([work, tick])` which is fine — they're not inside OpenTUI's render cycle. |
| Regression in headless tests (no renderer, setTimeout works fine) | Low | Headless path: `setTimeout(0)` fires immediately in the macrotask queue — drain still progresses. No behavioral change. |

---

## 7. Effort estimate

| Option | Estimate |
|--------|----------|
| Option A (recommended) — Task 1+2+3+4 | ~1.5 hours total |
| Option B (event-driven, follow-up) | ~3 hours |
| Option C (pipeline refactor) | ~1-2 days |

---

## 8. Cross-reference: open issues NOT in scope

### Leader 401 / `resolveLeaderModel` returns `"unknown"`

Root cause: `getRoleModel("leader")` config or provider-key resolution mismatch
causes the leader HTTP call to use an invalid model string, resulting in 401
from the provider. The ~100s delay per call is likely an HTTP retry/backoff
inside the provider wrapper that incorrectly treats 401 as transient.

This is independent of the drain stall — it surfaced only because Layer B's
retry budget kept the gather phase alive long enough to expose the drain bug.
Should be tracked as a separate issue: audit `resolveLeaderModel →
getLeaderModelId → getConfiguredLeaderModel` call chain and add
`MUONROI_DEBUG_LEADER=1` raw-response logging (already landed in commit
`47cb460`).

### Layer B skip-counter regression

The retry budget (3× skip → escalate) landed in `eafc8e5` and was verified
working up to q4. No regressions expected from this fix, but the E2E
verification in Task 4 implicitly covers it.
