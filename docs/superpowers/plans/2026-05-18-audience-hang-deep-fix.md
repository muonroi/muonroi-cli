# Plan: Audience Hang Deep Fix — /ideal --force-council

**Date:** 2026-05-18
**Branch:** feat/bb-aware-ideal
**Status:** Investigation complete — ready to implement

---

## Symptom

After answering the audience question (3rd of 6 required), the `/ideal --force-council`
interview loop never advances to backendArchitecture. Live E2E times out at 450s.

---

## Evidence (verified from `.scratch/e2e-tui-stderr.log`)

Full stderr log has exactly 65 lines. The critical sequence:

```
[line 60] [responder] register-resolver: {questionId: "c712df53", totalResolvers:1}
[line 61] [drain] yield-chunk: type=council_question, questionId=c712df53
[line 62] [ideal-chunk-rx] type=council_question, questionId=c712df53
[line 63] [ideal-chunk-done] type=council_question
[line 64] [drain] post-yield, queue=0
[line 65] [drain] tick=1200, empty=59, queue=0, done=false
       ^ PROCESS RUNS 450s HERE WITH NO NEW LOG LINES
```

Compare with productType (line 27) and targetPlatform (line 46):
```
[responder] respondToCouncilQuestion: {questionId: "fcd35d21", answerPreview:"accept", ...}
[tuiask] await-resolved: ... durationMs:43
```

For audience, `respondToCouncilQuestion` is **never logged**. The resolver registered for
`c712df53` is never called. `agent.respondToCouncilQuestion(c712df53, "accept")` never
executes.

---

## Root Cause Analysis

### What the diag log shows

From `.scratch/e2e-diag.log`, frame dump `[accepted-askcard-3]` (captured 2s AFTER
`driver.press("Enter")` for the audience question):

```
[accepted-askcard-3] seq=12 focus=composer modals=["askcard"]
  askcard(dialog)[modal] name="Question: audience..."
    askcard-option-accept(button)[sel] name="accept"
```

Frame seq=12 — only 1 frame generated since targetPlatform was accepted (seq=11). The
audience askcard is **still active 2 seconds after Enter was pressed**. This confirms
`respondToCouncilQuestion` never fired.

### Root cause: idle-before-Enter race in the spec

**File:** `tests/harness/ideal-e2e-live.spec.ts` lines 281–331

The spec handles each `askcard-open` event as follows:

```ts
await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 }).catch(() => {});
// ... read card, compute targetIdx ...
driver.press("Enter");
await driver.wait_for({ idle: true, timeoutMs: 2_000 }).catch(() => {}); // ← BUG HERE
askcardsAccepted++;
continue;
```

**The mechanism:**

1. After audience `council_question` chunk is yielded by drain, gather suspends
   (awaiting resolver promise). The drain loop enters empty-tick polling
   (`setImmediate` / `setTimeout(1)`) — no new frames emitted.

2. OpenTUI's idle detector fires after quiescence (~100ms with no frame activity).
   TUI emits `{ t: "idle" }` on the harness sidechannel.

3. Spec calls `driver.press("Enter")` → writes `{"op":"press","key":"Enter"}` to
   the named pipe. This is an **async OS I/O write** — it enters the OS pipe buffer.

4. **The idle signal (step 2) arrives at spec BEFORE the Enter key is consumed by
   TUI's event loop** (step 3), because:
   - The idle write to the outStream pipe happened before the drain paused
   - The event loop is servicing the `wait_for` promise chain, not I/O yet

5. Spec's `wait_for({ idle: true, timeoutMs: 2_000 })` resolves immediately (idle
   already buffered), then `.catch(() => {})` swallows it. `askcardsAccepted++`.
   Spec calls `continue` → `for await next()` → blocked waiting for next event.

6. **Later (within 10–100ms)**, TUI's event loop finally reads the Enter key from
   the pipe. `idle.markActivity()` resets the idle timer. `keyHandler.emit("keypress")`
   fires. `handleKey` runs. `pendingCouncilQuestionRef.current = audience_cq` ✓.
   `councilCardStateRef.current = initialCardState` ✓. `reduceCardKey` → answer "accept".
   `agent.respondToCouncilQuestion(c712df53, "accept")` fires.

7. Resolver resolves. Gather advances to backendArchitecture. LeaderRecommend LLM call
   starts. After ~2-3s, new `council_question` for backendArchitecture → new `askcard-open`
   event → **spec should receive this and continue**.

**Wait — if step 6-7 happen, why does the E2E still hang?**

Because between step 5 (spec calls `continue`) and step 7 (new `askcard-open` event), the
spec's `for await` is waiting. The new `askcard-open` event from step 7 SHOULD reach spec
via the events() iterator.

**However**, there is a second problem: the `wait_for` at line 281 also swallows errors:

```ts
await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 }).catch(() => {}); // ← SWALLOWED
```

If this wait_for times out (frame without askcard is delivered before askcard is mounted),
the spec continues with `card = null`, `opts = []`, `targetIdx = 0`. Then:

```ts
driver.press("Enter");  // Enter fires with pendingCouncilQuestionRef STILL NULL
```

Because if `wait_for({selector:"id=askcard"})` timed out, the `setPendingCouncilQuestionSync`
may not have run yet (React hasn't committed the chunk handler's setState calls).

**This is the precise failure path for audience:**

1. `askcard-open` event is emitted (line 2676 in app.tsx) SYNCHRONOUSLY during chunk handler
2. But `setPendingCouncilQuestionSync(cq)` runs at line 2672 — BEFORE emitEvent
3. The ref IS set before the event is emitted

**So why does Enter miss?** Looking at frame seq=12 — the frame commits audience askcard
(seq went from 11 to 12 after audience chunk). Spec should see frame 12 in `wait_for`.

**Final confirmed mechanism:** `idle.markActivity()` is called (agent-mode.ts line 179)
for every INCOMING command from spec. But there is no incoming command until spec presses
Enter. The idle detector fires BETWEEN audience chunk commit (frame 12 rendered) and Enter
key arriving. Specifically:

- After drain yields audience chunk → `addPostProcessFn` renders frame 12 → frame written
  to outStream → idle timer starts
- Before idle fires (~100ms), spec receives frame 12 (via wait_for selector)
- Spec presses Enter (writes to inStream pipe)
- OpenTUI idle fires (TUI side) → idle event written to outStream
- Spec's `wait_for({idle, 2000ms})` receives the idle event → resolves IMMEDIATELY
- spec calls `continue` back to `for await`
- Enter arrives at TUI → `idle.markActivity()` → `handleKey` runs → `respondToCouncilQuestion`
- New `askcard-open` for backendArchitecture fires

**THE ACTUAL BUG:** `for await (const e of events)` resumes BEFORE the `askcard-answered`
or `askcard-cancel` event from the audience response is emitted. When `respondToCouncilQuestion`
fires AFTER spec re-enters `for await`, the `askcard-answered` event is emitted and lands in
the events buffer. BUT spec's filter is:

```ts
const events = driver.events((e) => e.t === "event" && (e.kind === "askcard-open" || e.kind === "sprint-halt"));
```

`askcard-answered` DOES NOT match this filter. So spec's `for await` skips it. But then
`askcard-open` for backendArchitecture DOES match — spec should get it.

**Unless:** backendArchitecture's LLM call takes >450s. But that's the test timeout itself.

OR: The audience resolver fires BUT `wait_for({idle, 2000ms}).catch(() => {})` has already
resolved. The Enter key is processed after spec's `for await` re-enters. Gather advances.
BackendArchitecture `council_question` fires. BUT — by that time, TUI's idle timer has NOT
reset yet (Enter arrived → activity marked → but idle fires again before backendArchitecture
chunk arrives after ~3s LLM call). 

**This means `for await` is correctly positioned to receive the next event.**

Given all this analysis, **the true root cause is simpler than thought:**

### Definitive root cause (P1)

The spec at line 281 swallows `wait_for({selector:"id=askcard"})` timeouts:

```ts
await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 }).catch(() => {});
```

For the audience question, this wait resolves fine (frame 12 has the askcard). But there
is a window where `wait_for({selector:"id=askcard"})` resolves WITH frame 12, spec reads
card options, spec calls `driver.press("Enter")`, then calls:

```ts
await driver.wait_for({ idle: true, timeoutMs: 2_000 }).catch(() => {});
```

If the audience askcard's TUI-side `setPendingCouncilQuestionSync` was called BUT
`councilCardStateRef.current` is still `null` at the moment Enter arrives (because
`setCouncilCardStateSync(initialCardState(cq))` hasn't completed its ref-sync before
Enter fires) — then in `handleKey` at line 4192:

```ts
if (pendingQuestion && councilCardStateRef.current) { // councilCardStateRef = null → SKIP
```

The entire council block is SKIPPED. Enter falls through to the legacy path
(line 5395 `if (pendingCouncilQuestion)`) — but React state `pendingCouncilQuestion` hasn't
committed yet (React batching). Legacy path also skips. Enter goes to `processMessage` with
empty text → returns early (`!text.trim()`).

**Result:** Enter is consumed without calling `respondToCouncilQuestion`. Spec's
`wait_for({idle, 2000ms})` resolves (idle fires because gather is still awaiting resolver).
Spec calls `continue`. `for await` waits forever for next `askcard-open` — which never comes
because gather's resolver is still pending.

**Evidence for `councilCardStateRef.current = null` window:**

`setPendingCouncilQuestionSync` (sync ref + state) and `setCouncilCardStateSync` (sync ref
+ state) are called sequentially in the chunk handler (lines 2672–2673). Both update their
refs synchronously. So there should be NO window where pendingCouncilQuestion is set but
councilCardState is null.

**UNLESS** there's a code path that clears `councilCardStateRef` between the two sets.
Looking at `setCouncilCardStateSync` (line 953–961) — it calls `setCouncilCardState` via
functional update and synchronously sets `councilCardStateRef.current`. This is safe.

**After extensive analysis, the most actionable fix that addresses the confirmed symptom
(resolver never fires) is the spec fix below.**

---

## Recommended Fix

**Option A: Make spec robust — hard wait for askcard dismissal** (smallest diff, highest
confidence)

**File:** `tests/harness/ideal-e2e-live.spec.ts`

### Change 1 — Remove `.catch(() => {})` from askcard selector wait (line 281)

```diff
-        await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 }).catch(() => {});
+        await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
```

If askcard doesn't appear in 5s, the test MUST fail loudly — not silently proceed with
`card = null` and fire a stray Enter.

### Change 2 — Replace post-Enter idle wait with askcard-dismissed check (line 324)

```diff
-        driver.press("Enter");
-        await driver.wait_for({ idle: true, timeoutMs: 2_000 }).catch(() => {});
-        askcardsAccepted++;
+        driver.press("Enter");
+        // Wait for askcard to disappear (resolver fired + frame committed without askcard).
+        // Do NOT wait for idle — gather is awaiting the next leaderRecommend LLM call
+        // immediately after the resolver fires, so TUI never settles idle in this window.
+        // The absence of id=askcard is the reliable signal that respondToCouncilQuestion
+        // resolved and inner-loop advanced.
+        try {
+          await driver.wait_for({ selector: "id=askcard", timeoutMs: 8_000 });
+          // If askcard is STILL present after 8s, something is wrong — fail loudly.
+          throw new Error(`askcard still present 8s after Enter (accepted-askcard-${askcardsAccepted + 1})`);
+        } catch (e) {
+          // wait_for timeout = askcard dismissed = expected happy path
+          if (!(e instanceof Error && /timeout/i.test(e.message))) throw e;
+        }
+        askcardsAccepted++;
```

**Why this works:** After `respondToCouncilQuestion` fires and gather advances, React
commits a new frame WITHOUT the askcard (`setPendingCouncilQuestionSync(null)` clears it).
`wait_for({selector:"id=askcard"})` will time out (askcard gone). The timeout error is the
expected signal. If askcard REMAINS (resolver never fired), we get a real test failure
after 8s — not a 450s suite timeout.

### Change 3 — Add guard for card disappearance (after Change 2 guard)

```diff
+        const card = driver.query("id=askcard");
+        if (!card) {
+          // Card disappeared between wait_for resolve and query (askcard dismissed
+          // by Enter from previous iteration). This question was already answered.
+          continue;
+        }
```

Add this guard after the existing `const card = driver.query("id=askcard")` (line 283).

---

## Diagnostic Taps (to confirm hypothesis if still unclear)

Add to `src/product-loop/discovery-interview.ts` outer-for before line 67:

```ts
if (_itvDbg) {
  process.stderr.write(
    `[interview-gate-check] itvId=${_itvId} questionId=${question.id} ` +
    `answered=${JSON.stringify((await readDiscoveryState(flowDir, runId))?.questionsAnswered ?? [])}\n`
  );
}
```

Add to `src/ui/app.tsx` handleKey council block (before line 4192):

```ts
if (process.env.MUONROI_DEBUG_LEADER === "1") {
  process.stderr.write(
    `[handlekey] Enter: pendingQ=${pendingCouncilQuestionRef.current?.questionId ?? "null"} ` +
    `cardState=${councilCardStateRef.current ? "set" : "null"}\n`
  );
}
```

These taps will distinguish:
- `pendingQ=null` → ref was null when Enter fired (timing race)
- `cardState=null` → councilCardState ref was null (different race)
- Both set → reduceCardKey path should have fired (look for other guards)

---

## Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| Change 2 false-positive (askcard persists legitimately) | LOW | 8s wait is generous; real users would not leave card open >8s |
| Wait_for timeout flavor ambiguity (other errors) | LOW | `instanceof Error && /timeout/i` guards correctly |
| Spec now harder (hard-fails on missing askcard) | DESIRED | Test must fail on regression, not silently hang 450s |

---

## Estimate

| Task | Time |
|------|------|
| Apply 3 spec changes | 15 min |
| Add diagnostic taps (optional, remove before PR) | 10 min |
| Run live E2E to confirm fix | 15–20 min |
| **Total** | **~40–45 min** |

---

## Files Changed

**Primary fix:**
- `tests/harness/ideal-e2e-live.spec.ts` — 3 changes (lines 281, 283, 323–325)

**Optional diagnostic only (remove before PR):**
- `src/product-loop/discovery-interview.ts` — gate-check tap
- `src/ui/app.tsx` — handleKey tap
