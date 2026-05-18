# Plan: Tab autocomplete flakiness in ideal-e2e-live.spec.ts Stage 1c

**Date**: 2026-05-17  
**Branch**: feat/bb-aware-ideal  
**Spec**: `tests/harness/ideal-e2e-live.spec.ts` — Stage 1c  
**Status**: Needs logging addition before fix can be confirmed

---

## W1: How Tab autocomplete works

**File**: `src/ui/app.tsx` lines 4572–4600

Key handler `handleKey` (registered via `useKeyboard` → `useEffectEvent`) — when
`showSlashMenuRef.current` is true and `key.name === "tab"`:

1. Reads `filteredSlashItems[slashMenuIndex]` — the currently highlighted item.
2. If item exists: calls `setShowSlashMenuSync(false)`, `setSlashSearchQuery("")`,
   then `ta.clear()`, `ta.insertText("/<id> ")`, tries to set `ta.cursorOffset`,
   then tries `ta.focus()` (all wrapped in `try/catch` — failures are silently eaten).
3. Always calls `key.preventDefault()` and `key.stopPropagation()` regardless of
   whether `item` existed.

`useEffectEvent` (OpenTUI's `useKeyboard` hook implementation,
`node_modules/@opentui/react/index.js` line 21–29) stores `handleKey` in a ref via
`useLayoutEffect(() => { handlerRef.current = handler; })`. This runs after every
commit, so the handler always reads the current render's `filteredSlashItems` — there
is no stale-closure problem here.

**`filteredSlashItems`** is computed inline (not memoized) from `slashSearchQuery`
state. After `wait_for({idle})` in stage 1b, React has committed with
`slashSearchQuery = "ideal"` and `filteredSlashItems = [{id: "ideal", ...}]`.

`emitWithPriority` dispatch order in OpenTUI's `InternalKeyHandler`
(`index-mw2x3082.js` lines 1907–1956):
- Global listeners first (includes `useKeyboard`'s `stableHandler` = app.tsx `handleKey`).
- Renderable handlers second (textarea's `handleKeyPress`).
- After each global listener: if `propagationStopped` → stop global chain.
- Before renderable: if `defaultPrevented` **or** `propagationStopped` → skip textarea.

Tab handler calls BOTH `key.preventDefault()` and `key.stopPropagation()`, so the
textarea NEVER receives Tab. Tab `\t` has charCode 9 (< 32) so the textarea's own
`handleKeyPress` would reject it anyway.

**Conclusion for W1**: Tab dispatch path is correct and well-guarded.

---

## W2: Timing race between `type("ideal")` burst and Tab

Stage 1b fires `driver.type("ideal")` which the input bridge expands into 5
synchronous `keyHandler.emit("keypress", char)` calls (one per char). These are
fully synchronous in the same JS tick.

Each char falls into the `showSlashMenuRef.current` guard path → calls
`setSlashSearchQuery((q) => q + ch)` (functional updater — safe for batching) +
`setSlashMenuIndex(0)`. React batches all 5 and commits ONE re-render with
`slashSearchQuery = "ideal"`.

`wait_for({idle})` resolves when the TUI emits `t: "idle"`. The idle fires 50 ms
after the last harness frame (`onFrame → idle.markActivity()`). Frames are emitted by
a 60 fps `setInterval` poll in `install.ts`; each emitted frame resets the timer.
Once React stops producing new Semantic states the frame poll deduplicates (content
hash) and no new frames emit → 50 ms later idle fires.

By the time `wait_for({idle})` resolves in the test, React has committed, 
`useLayoutEffect` has fired, and `handlerRef.current` points to the closure
with the correct `filteredSlashItems`. Tab arriving after that reads the correct
list.

**Conclusion for W2**: No timing race in the happy path. The `wait_for({idle})`
correctly gates stage 1c.

---

## W3: Tab captured by textarea instead of slash menu?

Not applicable. The dispatch order proven in W1 (global-before-renderable) means
app.tsx's `handleKey` fires before the textarea. `preventDefault()` stops the
textarea. Tab (charCode 9) would be rejected by the textarea anyway since
`handleKeyPress` returns false for control chars (< 32). The textarea's
`keypressHandler` is only registered in `renderableHandlers` when the textarea has
focus (OpenTUI `Renderable.focus()` line 15067 registers it; `blur()` line 15090
unregisters it).

**Conclusion for W3**: Tab cannot be accidentally captured by the textarea.

---

## W4: Log evidence gap

The `dumpFrame` helper in the spec logs `n.value` only when it is truthy.

The `<Semantic id="composer">` node at `src/ui/app.tsx` lines 6060–6076 sets
`value={composerValue ?? ""}` where:

```tsx
composerValue={showSlashMenu ? `/${slashSearchQuery}` : undefined}
```

After the Tab handler closes the slash menu (`setShowSlashMenuSync(false)`),
`showSlashMenu` becomes `false`, so `composerValue` becomes `undefined`, and the
Semantic `value` prop is `""`. **The Semantic node never reflects the actual textarea
`plainText` once the slash menu is closed.**

This means the `post-dispatch` dumpFrame in stage 1d CANNOT show whether the textarea
had `/ideal ` or `/ideal` (no space) or was empty when Enter fired. The `value=""`
for the composer node is a known structural gap — it does not indicate the textarea
is empty.

**Conclusion for W4**: The diagnostic dump is blind to textarea content after Tab
closes the menu. The existing diag cannot confirm or deny which failure mode
occurred.

---

## Root cause hypothesis

**Cannot be stated with confidence from static analysis alone.**

Two plausible mechanisms are consistent with ~1-in-3 failure producing the "help"
output (args.length === 0):

**Hypothesis A — focus loss after `ta.clear()` + `ta.insertText()`:**

The Tab handler at `src/ui/app.tsx` line 4582–4595 calls:
1. `ta.clear()` — clears edit buffer (synchronous Zig-level operation, emits `input` event).
2. `ta.insertText("/ideal ")` — inserts text (synchronous).
3. `ta.cursorOffset = 7` — wrapped in try/catch.
4. `(ta as { focus? }).focus?.()` — **wrapped in try/catch, silently ignored on failure**.

OpenTUI registers the textarea's keypress handler on focus and UNREGISTERS it on
blur (`Renderable.blur()` line 15090 in `index-mw2x3082.js`). If `ta.clear()` or
`ta.insertText()` triggers a synthetic blur (e.g. via an `input` event handler in
OpenTUI that moves focus, or from a React re-render that unmounts/remounts the
textarea due to conditional rendering), the textarea will lose its renderable
keypress handler before stage 1d's chars arrive.

Stage 1d `driver.type("--force-council build fraud detection service")` chars then
go through `emitWithPriority` → global handler (app.tsx `handleKey`) — which has no
char handling when `showSlashMenuRef.current === false` — but NOT to the textarea's
renderable handler (unregistered). The chars are silently dropped.

`driver.press("Enter")` then fires. With no modal open and `showSlashMenuRef.current
=== false`, the Enter key goes through `handleKey` (no explicit handler for it in the
baseline "no modal" case), then to the textarea's renderable handler. **But if the
textarea is blurred, its renderable handler is unregistered and Enter also does
nothing.** — OR — the textarea IS re-focused by some post-render effect, and Enter
fires the textarea's `submit()` with only the content `ta.insertText` put there
(`/ideal ` — no args) → `handleSubmit` reads `inputRef.current.plainText = "/ideal
"` → `handleCommand("/ideal ")` → `c = "/ideal"` → `parts = ["ideal"]` →
`args = []` → `parseIdealArgs([])` → `subcommand: "help"` → help text appears.

This matches Run #2 exactly.

**Hypothesis B — slashSearchQuery not "ideal" at Tab time in some render cycle:**

Insufficient evidence. Not supportable from code reading alone.

**The specific code site whose ordering could be wrong (Hypothesis A):**

`src/ui/app.tsx` lines 4582–4595 — specifically: `ta.clear()` at line 4582 may
trigger internal OpenTUI events that cause a blur on the textarea component before
`ta.focus()` at line 4592 can re-focus it. The re-focus call is wrapped in
`try/catch` and uses optional chaining, so any failure is silently swallowed.

**This is a hypothesis, not a confirmed root cause.** The `focus()` call may succeed
but then a subsequent React re-render (triggered by `setShowSlashMenuSync(false)`)
re-evaluates the `focus` prop on the `<Semantic id="composer">` node and the OpenTUI
textarea's focus state. The `<Semantic>` focus prop (line 6067–6075) is `true` when
no modal is active — but the Semantic node is observational only; it does NOT call
`ta.focus()` imperatively. Whether a React re-render can cause the physical textarea
focus to reset depends on OpenTUI internals not fully traced here.

---

## Logging additions needed to confirm

### Addition 1 — Log textarea plainText before stage 1d fires

**File**: `tests/harness/ideal-e2e-live.spec.ts`  
**Where**: Add a `dumpFrame` call in stage 1c AFTER `wait_for({idle})`.

The current `dumpFrame` is blind to textarea content. Instead, add a direct log of
the Semantic node's `value` AND emit a diagnostic that attempts to read the composer
node:

```ts
// stage 1c — AFTER wait_for({idle}):
const composerNode = driver.query("id=composer");
try {
  appendFileSync(DIAG_LOG,
    `[post-tab] composer.value=${JSON.stringify(composerNode?.value ?? "(unset)")}\n`);
} catch {}
dumpFrame(driver, "post-tab");
```

This will still only log `""` after tab (Semantic gap), but it will confirm whether
the Semantic `value` is being updated at all, and `dumpFrame` will show whether the
`slash-menu` node is GONE from the tree (confirming Tab closed the menu).

### Addition 2 — Wire `inputRef.plainText` into the Semantic `value` prop

**File**: `src/ui/app.tsx` line 6066  
**Where**: `<Semantic id="composer" ... value={composerValue ?? ""}>` 

Change from:
```tsx
value={composerValue ?? ""}
```
to:
```tsx
value={composerValue ?? (inputRef.current?.plainText ?? "")}
```

This makes the Semantic node reflect the actual textarea content at render time,
regardless of whether the slash menu is open. With this change, `dumpFrame` at
`post-tab` would show:
- `composer(textbox) value="/ideal "` — Tab worked correctly.
- `composer(textbox) value="/ideal"` or `value=""` — Tab failed (hypothesis A path).

**Impact**: Semantic value now reflects textarea state on every render. This is
strictly an observability improvement — no behavioral change. Cost: `plainText` is a
getter on the OpenTUI object, not React state; calling it from JSX during render is
safe (synchronous, no side effects).

### Addition 3 — Log before and after `ta.clear()` / `ta.insertText()` in the Tab handler

**File**: `src/ui/app.tsx` lines 4580–4596  
**Where**: Inside the Tab handler block

Add stderr logging (gated on `agentRuntime !== undefined` to avoid noise in normal
mode):

```ts
const before = ta.plainText;
ta.clear?.();
ta.insertText?.(completion);
const after = ta.plainText;
// agentRuntime.emitEvent or process.stderr.write for diagnostic
process.stderr.write(
  `[tab-autocomplete] before=${JSON.stringify(before)} after=${JSON.stringify(after)} focus=${ta._focused ?? "?"}\n`
);
```

This would show in `.scratch/e2e-tui-stderr.log` (already wired in `beforeAll`),
revealing exactly what `ta.insertText` produced and whether the textarea had focus
after the operation.

---

## Fix plan

**Land logging first. Rerun live ≥3 times, then revisit.**

After Addition 2 (wire `plainText` into Semantic `value`) and Addition 3 (stderr
tap on Tab handler):

- **If logs show `value="" after tab`** (textarea cleared but insertText produced
  nothing): root cause is in `ta.insertText()` returning empty, likely because the
  textarea is in an inconsistent state after `ta.clear()`. Fix: replace the
  `clear()` + `insertText()` sequence with a single `ta.value = completion` setter
  call (OpenTUI `TextareaRenderable` exposes a `value` setter at line 5265 in
  `index-mch6dv67.js` that calls `setText + emit("input")`).

- **If logs show `value="/ideal " after tab` but stage 1d chars are still missing**:
  root cause is focus loss (Hypothesis A). Fix: replace the optional `ta.focus?.()` 
  call with a mandatory call + verify textarea focus state. Alternatively, dispatch
  a synthetic focus command from the harness side.

- **If logs show `value="/ideal " after tab` AND `_focused=true`**: root cause is
  elsewhere. Need a different investigative step (e.g. log textarea state when Enter
  arrives).

---

## Alternative spec workarounds (no production change needed)

### Option 1 — Assert composer value after Tab, then proceed

Add an assertion after stage 1c Tab:

```ts
it("stage 1c: Tab autocompletes /ideal into composer", async () => {
  driver.press("Tab");
  await driver.wait_for({ idle: true, timeoutMs: 3_000 });
  // Gate: only proceed if Tab produced the expected composer state.
  // Requires Addition 2 above (wire plainText into Semantic value).
  const composer = driver.query("id=composer");
  const v = composer?.value ?? "";
  if (!String(v).startsWith("/ideal ")) {
    // Tab failed — fall back to direct type
    driver.type("/ideal ");
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
  }
});
```

Requires Addition 2 to be effective. Without it, `composer.value` is always `""` and
the guard never triggers.

### Option 2 — Skip slash menu entirely; type `/ideal ` directly

Replace stages 1a–1c with a single direct type, avoiding the slash menu path
entirely:

```ts
it("stage 1: type /ideal command directly into composer", async () => {
  driver.type("/ideal ");
  await driver.wait_for({ idle: true, timeoutMs: 3_000 });
  // Assert: slash menu should NOT be open ("/ideal " with trailing space
  // does not open the menu because text is non-empty when "/" is typed, OR
  // because the space closes it).
  expect(driver.query("id=slash-menu")).toBeNull();
});
```

Caveat: the spec comment on stage 1c notes that direct typing of `/ideal ` is
"racy because the slash filter may capture the space character before the menu
auto-completes." However, the spec also says the TUI is fully idle before this step,
and the stage 1a wait already ensures a stable initial state. This workaround trades
the Tab-autocomplete mechanism for simpler direct input, at the cost of not testing
the Tab autocomplete path itself.

**Recommended**: Use Option 2 as the immediate workaround to unblock live runs, while
Option 1 + the logging additions track down the root cause for a production fix.

---

## Summary of open questions

1. Does `ta.clear()` or `ta.insertText()` cause a blur on the OpenTUI textarea? 
   (Needs Addition 3 to confirm.)
2. Does the `value` setter on `TextareaRenderable` avoid the potential blur that
   `clear() + insertText()` may trigger? (Needs a spike.)
3. Is `ta.focus()` silently failing because OpenTUI's `focus()` method requires
   the component to be mounted in a specific lifecycle state? (Needs Addition 3.)
