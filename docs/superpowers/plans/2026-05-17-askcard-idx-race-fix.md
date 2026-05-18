# Plan: askcard idx race fix

**Date:** 2026-05-17  
**Branch:** feat/bb-aware-ideal  
**Status:** Evidence complete — root cause CONFIRMED

---

## V1: Is askcard's `idx` a useState or already a ref?

**Finding:** `CouncilQuestionCard` is a **pure controlled component** — it receives
`state: CouncilCardState` as a prop. It owns no internal state. `idx` is only read
from `state.idx`, passed down from the parent.

The parent is `src/ui/app.tsx`. Two separate useState declarations own the two card
states:

```
line 926:  const [councilCardState, setCouncilCardState] = useState<CouncilCardState | null>(null);
line 927:  const [preflightCardState, setPreflightCardState] = useState<CouncilCardState | null>(null);
```

There is **no useRef mirror** for either of these. This is the exact structural gap
that was fixed for `showSlashMenu` in commit `5ef5525` but was not applied to the
card state variables.

**Conclusion:** `idx` is pure useState, no ref. Race confirmed structurally.

---

## V2: Input pipeline trace

**Path:** harness driver → named-pipe/fd4 → `agentRuntime.onCommand` callback →
`packages/agent-harness-opentui/src/input-bridge.tsx` `useAgentInputBridge` →
`keyHandler.emit("keypress", k)`.

`keyHandler` is an instance of `class KeyHandler extends EventEmitter` (opentui
core, `index-mw2x3082.js` line 1876). Node.js `EventEmitter.emit()` is **fully
synchronous** — all registered listeners fire before `emit()` returns.

`useKeyboard` registers `handleKey` as a `"keypress"` listener. It wraps it with
`useEffectEvent`, which is:

```js
function useEffectEvent(handler) {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => { handlerRef.current = handler; });  // fires AFTER render
  return useCallback((...args) => handlerRef.current(...args), []);
}
```

`handlerRef.current` is updated by `useLayoutEffect`, which fires **after the
render phase and DOM commit**, not during the synchronous emit. This means:

**Sequence for a tight `Down,Enter` burst from the harness:**

1. `keyHandler.emit("keypress", Down)` → synchronous call into `handleKey`
2. Inside handleKey: `councilCardState` is read from the **closed-over** value
   captured when `useCallback` last ran (idx=0). `reduceCardKey` computes new
   state `{idx:1}`. `setCouncilCardState({idx:1})` is enqueued — React state
   update, NOT yet committed.
3. `keyHandler.emit("keypress", Enter)` fires synchronously — still inside the
   same JS call stack, React has not re-rendered yet.
4. Inside handleKey: `councilCardState` is read from the **same stale closure**
   (idx=0). `reduceCardKey(…, {idx:0}, enter)` selects option at index 0
   ("override") and emits the answer.
5. React eventually flushes: renders with `{idx:1}`, but the answer was already
   submitted with idx=0.

**Conclusion:** The race is in the closure-over-useState read inside `handleKey`.
`useEffectEvent` does NOT help here — it keeps `handlerRef.current` pointing to
the latest handler function, but that handler still closes over stale React state
via `councilCardState` in its `useCallback` deps array (line 5161). The handler
reference is fresh but the state value it captures is stale during the burst.

This is structurally identical to the `showSlashMenu` bug: handler is fresh but
reads a stale state variable that was captured at last-render time.

---

## V3: Existing race fix as reference

Commit `5ef5525` introduced the pattern:

```tsx
const showSlashMenuRef = useRef(false);
const setShowSlashMenuSync = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
  setShowSlashMenu((prev) => {
    const next = typeof v === "function" ? v(prev) : v;
    showSlashMenuRef.current = next;   // write ref synchronously inside setState updater
    return next;
  });
}, []);
```

Then all reads of `showSlashMenu` inside the keyboard handler switched to
`showSlashMenuRef.current`.

The key insight: the updater form of `setShowSlashMenu` runs synchronously inside
the React scheduler's commit path and inside a functional updater that is called
when enqueuing, so the ref is written before the next emit processes. However for
the card state this is more complex because:

1. The state has two fields (`idx` and `freetext`), not a single boolean.
2. The handler reads `councilCardState` AND passes it to `reduceCardKey` — the
   entire state object is consumed, not just one flag.

The same ref-mirror pattern applies but must mirror the full `CouncilCardState`
object.

---

## V4: Other racing state fields and other modals

**Within councilCardState:**
- `freetext`: same risk. If a burst opens freetext mode then immediately types a
  char, the `state.freetext !== null` branch check would read a stale null. In
  practice the burst pattern for freetext is less likely since the harness types
  chars sequentially via `op:type`, but the structural risk is identical.

**preflightCardState (lines 4726–4761):**  
Same pattern: `useState`, no ref mirror, read inside `handleKey` deps array. The
preflight card only has two options (Y/N or choice) so the burst window is
narrower, but the race is architecturally identical. Must be fixed together.

**Other modals with similar patterns in app.tsx** (cross-check against the
`useCallback` deps array, lines 5060–5171):

| Variable | Line | Has Ref? | Race risk |
|---|---|---|---|
| `councilCardState` | 5161 | No | **HIGH** (confirmed) |
| `preflightCardState` | 5163 | No | HIGH (same pattern) |
| `activeHaltCard` | 5166 | No | MEDIUM — only Esc/Enter on 2 options, less burst exposure |
| `haltSelectedIndex` | 5166 | No | MEDIUM |
| `showSlashMenu` | 5152 | YES (`showSlashMenuRef`) | Fixed in 5ef5525 |
| `slashMenuIndex` | 5153 | No | LOW — index change is independent of Enter in the burst |
| `initNewForm` | 5168 | No | LOW — form transitions are step-by-step, not burst-prone |

---

## Root Cause

**CONFIRMED.**

`handleKey` is a `useCallback` that lists `councilCardState` in its deps array.
When two keypresses arrive synchronously (Down then Enter via the harness's
synchronous `keyHandler.emit` calls), the second keypress executes `handleKey`
with the stale pre-Down snapshot of `councilCardState` because React has not
flushed the `setCouncilCardState` from the first keypress. The Down keypress
updates `idx` from 0→1 in the React queue, but Enter reads `councilCardState`
still at `idx=0` and submits option 0 ("override") instead of option 1 ("skip").

The mechanism is identical to the `showSlashMenu` race fixed in 5ef5525. The fix
pattern is known; it needs to be applied to `councilCardState` and
`preflightCardState`.

---

## Fix Plan

### Step 1 — Add ref mirrors for councilCardState

**File:** `src/ui/app.tsx`  
**Near:** line 926–927 (where useState declarations live)

Add after the two useState declarations:

```tsx
// Ref mirrors — keep current synchronously so keyboard-burst handlers read
// the correct idx without waiting on React's setState commit.
const councilCardStateRef = useRef<CouncilCardState | null>(null);
const preflightCardStateRef = useRef<CouncilCardState | null>(null);
```

**Why:** The ref is the synchronously-readable source of truth during a keypress
burst, analogous to `showSlashMenuRef`.

### Step 2 — Introduce sync setter wrappers

**File:** `src/ui/app.tsx`  
**After** the two `useRef` additions from Step 1:

```tsx
const setCouncilCardStateSync = useCallback(
  (v: CouncilCardState | null | ((prev: CouncilCardState | null) => CouncilCardState | null)) => {
    setCouncilCardState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      councilCardStateRef.current = next;
      return next;
    });
  },
  [],
);

const setPreflightCardStateSync = useCallback(
  (v: CouncilCardState | null | ((prev: CouncilCardState | null) => CouncilCardState | null)) => {
    setPreflightCardState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      preflightCardStateRef.current = next;
      return next;
    });
  },
  [],
);
```

**Why:** Writing the ref inside the functional updater is the same pattern as
`setShowSlashMenuSync`. The updater is called synchronously during enqueue, so the
ref reflects the new value before the next `emit` fires.

### Step 3 — Replace reads of councilCardState in the keyboard handler

**File:** `src/ui/app.tsx`  
**Location:** lines 4108–4149 (the `pendingCouncilQuestion && councilCardState`
block)

Change:
```tsx
if (pendingCouncilQuestion && councilCardState) {
  const cardKey = mapCouncilCardKey(key);
  if (cardKey) {
    const result = reduceCardKey(pendingCouncilQuestion, councilCardState, cardKey);
    setCouncilCardState(result.state);
    …
    setCouncilCardState(null);
    …
    setCouncilCardState(null);
```

To:
```tsx
if (pendingCouncilQuestion && councilCardStateRef.current) {
  const cardKey = mapCouncilCardKey(key);
  if (cardKey) {
    const result = reduceCardKey(pendingCouncilQuestion, councilCardStateRef.current, cardKey);
    setCouncilCardStateSync(result.state);
    …
    setCouncilCardStateSync(null);
    …
    setCouncilCardStateSync(null);
```

**Why:** Reading `councilCardStateRef.current` instead of the closed-over
`councilCardState` ensures Down's state mutation is visible to Enter in the same
burst. All `setCouncilCardState(…)` calls become `setCouncilCardStateSync(…)` so
the ref stays in sync on the way out too.

### Step 4 — Replace reads of preflightCardState in the keyboard handler

**File:** `src/ui/app.tsx`  
**Location:** lines 4726–4743

Same substitution pattern: `preflightCardState` → `preflightCardStateRef.current`,
`setPreflightCardState` → `setPreflightCardStateSync`.

### Step 5 — Remove councilCardState and preflightCardState from handleKey deps array

**File:** `src/ui/app.tsx`  
**Location:** lines 5161–5163

Remove `councilCardState` and `preflightCardState` from the `useCallback` deps
array. Add `councilCardStateRef` and `preflightCardStateRef` only if the linter
requires it (refs are stable — they typically do not need to be listed).

**Why:** Once the handler reads from refs instead of closed-over state, these
values are no longer part of the handler's dependency surface. Keeping them would
re-create the handler on every state change, which is wasteful. More importantly it
would mask future regressions where someone adds a direct state read back in.

### Step 6 — Initialize refs when state is first set

**File:** `src/ui/app.tsx`  
**Locations:** lines 2611, 3092, 3282 (all `setCouncilCardState(initialCardState(cq))` calls)

Replace all three occurrences with `setCouncilCardStateSync(initialCardState(cq))`.

**Why:** If the card is opened and a burst arrives before the first render commit,
`councilCardStateRef.current` would be null while `councilCardState` would already
be non-null in the React queue. Using the sync setter ensures the ref is populated
immediately.

---

## Risks

1. **Ref and state divergence on concurrent mode** — React 18 concurrent mode can
   call the `setState` updater multiple times for time-slicing purposes. The ref
   would be written multiple times with intermediate values. This repo uses
   OpenTUI's custom reconciler (not the React DOM concurrent scheduler), so
   concurrent mode re-entrancy is not the current concern. The risk is the same
   as in the existing `showSlashMenuRef` fix — acceptable given the renderer.

2. **Other consumers of setCouncilCardState** — Only `app.tsx` calls
   `setCouncilCardState`. The component is fully controlled; the card itself never
   calls the setter. Replacing calls with `setCouncilCardStateSync` is a complete
   substitution with no other affected files.

3. **preflightCardState Y/N quick-keys** — Lines 4747–4760 set
   `setPreflightCardState(null)` before returning. These must also be replaced with
   `setPreflightCardStateSync(null)` to keep the ref in sync, even though the
   burst risk there is lower (Y/N paths do not read the state before nulling it).

4. **Test coverage gap** — The existing
   `src/ui/components/__tests__/council-question-card.test.ts` tests `reduceCardKey`
   in isolation but does not test the parent integration. The race cannot be caught
   by pure unit tests of the reducer — it requires the integration-level timing
   test described below.

---

## Test Plan

### Unit test: reducer is already correctly tested

`src/ui/components/__tests__/council-question-card.test.ts` validates that
`reduceCardKey(q, {idx:0}, down)` → `{idx:1}` and
`reduceCardKey(q, {idx:1}, enter)` → emits option at index 1.
No changes needed to these tests.

### New integration test: burst Down+Enter without wait_for(idle)

**File:** `tests/harness/askcard-burst.spec.ts` (new)

Scenario:
1. Spawn TUI with mock-LLM fixture that immediately emits a `council_question`
   chunk with 3 options: `override` (idx=0), `skip` (idx=1), `abort` (idx=2).
   `defaultIndex: 0`.
2. Wait for `id=askcard` dialog to appear and `id=askcard-option-override` to be
   selected.
3. Send `Down` then `Enter` **without** any `wait_for(idle)` between them —
   this is the exact burst that triggers the race.
4. Assert `askcard-answered` event has `answerText` equal to the value of option
   at idx=1 (`skip`), NOT idx=0 (`override`).

### Regression guard: remove the wait_for(idle) workaround

After implementing the fix, locate the existing spec that has `wait_for(idle)`
between Down and Enter as a workaround (likely in
`tests/harness/ideal-e2e-live.spec.ts` or similar). Remove the `wait_for(idle)`
and confirm the test still passes. This proves the fix eliminates the need for the
workaround rather than just co-existing with it.

### Verify preflightCardState fix

Add a secondary scenario to `askcard-burst.spec.ts`:
1. Emit a `council_preflight` chunk with 2 options.
2. Burst `Down,Enter` without idle.
3. Assert the correct option was selected (not the default idx=0).
