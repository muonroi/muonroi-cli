# Plan: Fix Audience Question Hang in /ideal --force-council Flow

**Date:** 2026-05-18  
**Branch:** feat/bb-aware-ideal  
**Status:** Draft

---

## Symptom

After answering audience question (3rd of 10), the interview loop never advances to `backendArchitecture`.

Two failure modes observed:
1. **No resolver fires at all** — `respondToCouncilQuestion` for audience qid never appears in log; drain ticks forever.
2. **Resolver fires (3/3 resolved), but `[interview-entry] outer-for backendArchitecture` never logs** — gather completes persist-end but stalls before next iteration.

---

## Evidence Trail

From `.scratch/e2e-tui-stderr.log`:
- `[drain] yield-chunk: type=council_question, questionId=c712df53` — audience chunk emitted
- `[responder] register-resolver: {questionId: "c712df53", totalResolvers: 1}` — resolver registered
- `[drain] post-yield, queue=0` — drain resumes
- `[drain] tick=1200, empty=59, ...done=false` — gather still waiting for resolver
- **No `[responder] respondToCouncilQuestion` for c712df53**
- **No `[interview-entry] outer-for ... backendArchitecture`**

---

## Root Cause Analysis

### Hypothesis 1 (MOST LIKELY) — `wait_for({idle})` blocks spec, misses Enter window

**Location:** `tests/harness/ideal-e2e-live.spec.ts` lines 323–324

```ts
driver.press("Enter");
await driver.wait_for({ idle: true, timeoutMs: 2_000 }).catch(() => {});
```

The gather drain loop (`loop-driver.ts` lines 277–312) is a busy-wait (`setImmediate`/`setTimeout(1)`) that **never emits an idle signal** while waiting for a resolver. The TUI only emits `{ t: "idle" }` after a full paint cycle settles. After the audience chunk is yielded, the drain loop parks on `setImmediate` waiting for the next chunk — it never settles idle.

**Consequence:** After pressing Enter for targetPlatform, `wait_for({idle, 2000ms})` always times out (`.catch(() => {})` swallowed). Spec proceeds: `askcardsAccepted++`, `continue`. Spec then calls `for await next()` on subscriber queue.

If audience `askcard-open` event is already in the queue (via late-subscribe replay or direct push), spec handles it. Spec calls `wait_for({selector:"id=askcard", 5000ms})` — **but if the askcard Semantic has not yet committed to a frame at this exact moment** (React batched setState hasn't flushed yet after setPendingCouncilQuestionSync), this also times out with `.catch(() => {})`. Then `driver.query("id=askcard")` returns `null` → `opts = []` → `targetIdx = 0` (last resort) → `currentIdx = 0` → `diff = 0` (no Down presses) → `driver.press("Enter")` → **Enter fires before `id=askcard` Semantic is mounted**, so `pendingCouncilQuestionRef.current` is stale (still null from after targetPlatform answer was cleared at line 4187) → `handleKey` falls through to the legacy `pendingCouncilQuestion` state check → **no answer dispatched**.

The resolver is registered but Enter never reaches it with a live ref.

**Evidence:** `register-resolver` fires (line 60 of log), but no `respondToCouncilQuestion` in log. `tick=1200, empty=59` confirms gather is still awaiting resolver 59 frames after yield.

### Hypothesis 2 (SECONDARY) — `allRequiredAnswered` triggers user-gate too early after audience

**Location:** `discovery-interview.ts` lines 198–213

After audience is saved (question 3), `allRequiredAnswered` is called. `REQUIRED_QUESTION_IDS` has 6 entries; after 3 answers `baseRequired = false`, so gate does NOT fire. **This is correct behavior.**

However, there is a subtle scenario: if `targetPlatform` answer = `["web"]` (single-platform), then `isRequiredForPlatform("frontendApproach", ["web"]) = true`. After answering productType + targetPlatform + audience (3 required), `baseRequired` is still false for missing backendArchitecture/backendStack/dbStrategy. Gate still won't fire early. This hypothesis is a non-issue for the current run (platforms = `["web","ios","android"]` → same result).

### Hypothesis 3 (LESS LIKELY) — `setPendingCouncilQuestionSync` null-clear race

**Location:** `app.tsx` line 4187 + `app.tsx` line 2659

When targetPlatform answer is emitted, `setPendingCouncilQuestionSync(null)` runs synchronously (line 4187). Then audience `council_question` chunk arrives in the drain loop. In the async stream handler, `setPendingCouncilQuestionSync(cq3)` fires (line 3346). If a React batching boundary sits between these two state updates, there is a window where `pendingCouncilQuestionRef.current === null` after null-clear but before cq3-set.

This is **not the primary cause** because ref updates are synchronous (the ref part of `setPendingCouncilQuestionSync` runs outside React scheduling), but could compound with Hypothesis 1 timing issues.

---

## Fix Options

### Option A — Make spec robust: wait for `id=askcard` frame BEFORE pressing Enter (Recommended)

**Files:** `tests/harness/ideal-e2e-live.spec.ts`

Replace the current pattern:
```ts
await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 }).catch(() => {});
const card = driver.query("id=askcard");
```
With a **hard wait** (no `.catch`) before proceeding:
```ts
// Wait until the Semantic for id=askcard is actually committed to a frame.
// Do NOT swallow timeout — if askcard doesn't appear in 5s the test must fail.
await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
const card = driver.query("id=askcard");
if (!card) {
  // Card disappeared between wait_for and query (extremely rare); skip this event.
  continue;
}
```

Also replace the post-Enter idle wait with a concrete `askcard` disappear check:
```ts
driver.press("Enter");
// Wait for askcard to CLOSE (ref cleared + Semantic unmounted), not for idle.
// This is the reliable signal that respondToCouncilQuestion fired and inner-loop advanced.
await driver.wait_for({
  // selector returns no matches when askcard unmounts
  selector: "id=askcard",
  // invert: wait until selector is NOT present
  // driver.wait_for doesn't have "absent" yet — use polling:
  timeoutMs: 3_000,
}).catch(() => {});
// Alternatively: wait for the NEXT askcard-open event or sprint-halt (handled by for-await loop)
```

**Simpler approach** — replace the idle wait entirely with a sentinel:
```ts
driver.press("Enter");
// Don't wait for idle (gather never settles idle while resolvers are pending).
// The for-await loop will pick up the next askcard-open event organically.
askcardsAccepted++;
```
Remove `await driver.wait_for({ idle: true, timeoutMs: 2_000 }).catch(() => {})` at line 324.

**Diff sketch:**
```diff
-        driver.press("Enter");
-        await driver.wait_for({ idle: true, timeoutMs: 2_000 }).catch(() => {});
-        askcardsAccepted++;
+        // Enter fires; don't wait for idle — gather loop never settles idle mid-interview.
+        // The next for-await iteration picks up the next askcard-open event.
+        driver.press("Enter");
+        // Give the key handler one event-loop turn to fire respondToCouncilQuestion
+        // and clear pendingCouncilQuestionRef before we loop back.
+        await new Promise<void>((r) => setImmediate(r));
+        askcardsAccepted++;
```

And change the guard around `wait_for({selector:"id=askcard"})` to **not swallow**:
```diff
-        await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 }).catch(() => {});
+        await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
```

### Option B — Emit idle from drain loop after resolver resolves (Deeper fix)

**Files:** `src/product-loop/loop-driver.ts`, `src/agent-harness/reconciler-hook.ts`

After each resolver resolves (i.e., `respondToQuestion` returns), the gather task continues synchronously: `persist-start` → `persist-mid` → `persist-end` → `inner-loop-exit`. These are all awaits that process in Node's microtask queue. After they complete, the drain loop can detect the queue state changed and emit a synthetic idle event.

**Implementation sketch:**
```ts
// In loop-driver.ts, after each drain cycle that sees queue grow then go empty:
// Add a post-gather-answer idle pulse via agentRuntime.
// This requires threading agentRuntime into the loop driver — non-trivial.
```

This option is more invasive (requires plumbing agentRuntime into loop-driver) and would change production behavior. **Not recommended** — the spec should not rely on idle signals from non-TUI async work.

---

## Recommended Fix

**Option A** — minimal spec change only.

Key changes in `tests/harness/ideal-e2e-live.spec.ts`:
1. Remove `.catch(() => {})` from `wait_for({selector:"id=askcard"})` — let it hard-fail so spec doesn't silently skip a missing card.
2. Replace `await driver.wait_for({ idle: true, timeoutMs: 2_000 }).catch(() => {})` after Enter with `await new Promise<void>((r) => setImmediate(r))` — gives key handler time to fire without waiting for idle that will never arrive.
3. Add `if (!card) continue;` guard after query.

These three changes together ensure:
- Spec waits until `id=askcard` Semantic is actually in the frame before pressing keys.
- Enter fires and the key handler processes it (pendingCouncilQuestionRef is set).
- Loop back to `for await` quickly without 2s timeout overhead.

---

## Diagnostic Taps (If Hypothesis Still Unclear)

Add to `discovery-interview.ts` outer-for to confirm whether code reaches backendArchitecture:
```ts
// After inner-loop-exit:
process.stderr.write(`[interview-gate] allRequired=${allRequiredAnswered(refreshed?.questionsAnswered??[], refreshedPlatforms)} answered=${JSON.stringify(refreshed?.questionsAnswered)}\n`);
```

Add to `app.tsx` handleKey:
```ts
// At start of pendingQuestion block:
process.stderr.write(`[handlekey] pendingQuestion=${pendingCouncilQuestionRef.current?.questionId ?? "null"}\n`);
```

These taps will pinpoint whether:
- a) `outer-for backendArchitecture` was never entered (gather-side hang), or
- b) `handleKey` saw `pendingCouncilQuestionRef.current === null` when Enter was pressed (spec-side timing bug).

---

## Estimate

| Task | Time |
|------|------|
| Apply Option A diff to spec | 15 min |
| Add diagnostic taps (optional) | 10 min |
| Run E2E live to confirm fix | 15 min |
| **Total** | **~40 min** |

---

## Files Changed

- `tests/harness/ideal-e2e-live.spec.ts` — primary fix (Option A)
- `src/product-loop/discovery-interview.ts` — diagnostic tap only (optional, remove before PR)
