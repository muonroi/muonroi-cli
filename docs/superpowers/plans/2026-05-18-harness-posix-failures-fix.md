# Plan: Fix 12 POSIX CI harness failures

**Date:** 2026-05-18  
**Branch:** feat/bb-aware-ideal  
**Scope:** Read-only investigation + fix plan (no code changes in this file)

---

## Root Cause Summary

12 test failures across 4 root cause groups, all POSIX-only (Linux CI):

---

## Group A — Empty-frame idle race (6 tests)

**Failing tests:**
- `askcard.spec.ts > composer accepts input on startup`
- `composer.spec.ts > composer is focused on startup`
- `council-flow.spec.ts > typing /council surfaces the slash menu`
- `subagents-modal.spec.ts > opens via /agents`
- `point-to-existing.spec.ts > navigate Down`
- `ideal-halt.spec.ts > Down arrow moves selection`

**Root cause:**

`createIdleDetector` in `packages/agent-harness-core/src/idle.ts` fires `onIdle` after `quiescenceMs` (default: 50ms from `--agent-idle-ms`) of no `markActivity()` calls. The timeline on POSIX:

1. TUI boots → `installOpenTUIHarness` sets up `setInterval(trySend, ~16ms)` at 60fps
2. First `trySend` call captures seq=0 frame with `nodes: []` (empty — React has not mounted yet)
3. No more frames change → idle detector fires after 50ms → `{ t: "idle" }` emitted
4. **`wait_for({ idle: true })` resolves** — driver's `lastIdleAt` updates
5. `latestFrame` at this point is seq=0 with `nodes: []`
6. Test asserts `driver.query("role=textbox")` → returns `null` → **FAIL**

On Windows (named-pipe transport), the additional handshake round-trip (~5ms) + pipe-connect latency delays the first `trySend` tick until after React has mounted, so seq=0 already has nodes.

**Evidence:**
- `driver.ts:194-196` — `buildCheck` for idle: `() => lastIdleAt >= capturedStart` — resolves on ANY idle event including the first one fired after the empty initial frame
- `install.ts:79-80` — `getTs: () => Date.now()` and `getSeq: () => seq++` — seq=0 frame is emitted for every first capture regardless of node count
- `reconciler-hook.ts:48-58` — `capture()` dedupes via hash; BUT the first call always emits because `lastHash` is `undefined`
- `agent-mode.ts:157-162` — `onFrame: () => idle.markActivity()` — activity is only marked when a frame is SENT (content changed). Empty seq=0 frame marks activity once; after that no more changes → idle fires

**The real issue:** `wait_for({ idle: true })` is semantically "system has quiesced after activity" but tests use it to mean "UI is fully rendered". On POSIX the first quiescence happens while `nodes: []`.

**Fix options (ranked by surface change):**

**Fix A1 (RECOMMENDED — test-side, smallest change):** After `wait_for({ idle: true })` in beforeAll, add `await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 })` as a second guard in the affected specs. This is the correct semantic — wait for the textbox to actually exist before querying it.

**Fix A2 (harness-side, medium change):** In `agent-mode.ts`, do NOT emit `{ t: "idle" }` until at least one non-empty frame has been sent. Add `let hasEmittedNonEmptyFrame = false` flag; in `onFrame` callback, set it only when `frame.nodes.length > 0`. In `createIdleDetector`'s `onIdle`, gate the write behind this flag.

**Fix A3 (driver-side):** Add `wait_for({ idle: true, minNodes: 1 })` that also requires `latestFrame?.nodes.length >= 1`. More surgical but adds API surface.

**Recommended:** Apply A1 to all Group A tests immediately (unblocks CI in one PR). Consider A2 as a follow-up improvement.

**Files to change (A1):**
- `tests/harness/composer.spec.ts:22` — add `wait_for({ selector: "role=textbox" })` after idle wait
- `tests/harness/askcard.spec.ts:19` — same
- `tests/harness/council-flow.spec.ts:33` — same
- `tests/harness/subagents-modal.spec.ts:29` — same  
- `tests/harness/point-to-existing.spec.ts:29` — add `wait_for({ selector: "id=ideal-halt-card" })` (halt tests need card, not textbox)
- `tests/harness/ideal-halt.spec.ts:30` — same

---

## Group B — Navigation idle race (3 tests)

**Failing tests:**
- `ideal-halt.spec.ts > Down arrow moves selection to second option`
- `ideal-init-new-flow.spec.ts > stage 4: Down arrow Modular → Microservices`
- `point-to-existing.spec.ts > navigate Down`

**Root cause (secondary, after Group A idle race):**

These tests press `Down`, then `await driver.wait_for({ idle: true })`, then assert `selected` state. On POSIX, `wait_for({ idle: true })` can resolve **before React commits the `selected` state setter** to the semantic registry snapshot. The idle fires after 50ms of no `markActivity()` — but React's state update + reconciler poll (60fps = ~16ms) may land within that same window, creating a race:

```
press("Down")
  → idle.markActivity()    // command received
  → [50ms later] idle fires (no new frames if Semantic didn't re-render yet)
  → wait_for resolves
  → driver.query(...selected) → stale state
```

`ideal-init-new-flow.spec.ts:191-196` explicitly documents this with `waitForStable()` polling, but `point-to-existing` and `ideal-halt` use only `wait_for({ idle: true })`.

**Fix B1 (RECOMMENDED):** Replace `wait_for({ idle: true })` after Down presses with `wait_for({ selector: "id=X >> role=listitem selected" })` using the selector grammar. If selector grammar doesn't support `selected` flag matching, fall back to the `waitForStable()` polling pattern already used in `ideal-init-new-flow.spec.ts:191`.

**Files to change (B1):**
- `tests/harness/point-to-existing.spec.ts:46-48` — replace idle wait with `waitForStable` predicate
- `tests/harness/ideal-halt.spec.ts:82-86` — replace idle wait with `waitForStable` predicate
- Extract the `waitForStable` helper from `ideal-init-new-flow.spec.ts:35-42` into `tests/harness/helpers.ts` for reuse

---

## Group C — Timestamp non-determinism (1 test)

**Failing test:**
- `determinism.spec.ts > 10× identical LiveFrame traces`

**Root cause:**

Test comment (line 14-16) says `--agent-fake-clock` sets `ts = seq * 16`. But actual implementation:

- `agent-mode.ts:133` — `const now = (): number => (opts.fakeClock ? 0 : Date.now())` — returns `0`, not `seq * 16`
- `install.ts:80` — `getTs: () => Date.now()` — **does NOT use `fakeClock` at all**

`installOpenTUIHarness` receives no `fakeClock` option — it's an `InstallOpenTUIHarnessOptions` (see `install.ts:28-45`) which has no such field. The `now()` function returned by `startAgentMode` is separate and unused for frame timestamps.

Result: even with `--agent-fake-clock`, every LiveFrame carries `ts = Date.now()` which differs between runs → byte-identity assertion fails.

**Fix C1 (REQUIRED):** Pass `fakeClock` flag through to `installOpenTUIHarness` so `getTs` uses `seq * 16` instead of `Date.now()`.

Option 1 — Add `getTs` override to `InstallOpenTUIHarnessOptions`:
```ts
// install.ts
export interface InstallOpenTUIHarnessOptions {
  ...
  getTs?: () => number;  // optional clock override
}
// usage in agent-mode.ts:
installOpenTUIHarness({
  registry,
  transport,
  fps: 60,
  onFrame: () => idle.markActivity(),
  getTs: opts.fakeClock ? () => seq * 16 : undefined,  // seq shared with reconcilerHook
})
```

But `seq` is internal to `installOpenTUIHarness`. Need to either:
- Expose a counter ref, OR
- Add `fakeClock?: boolean` to `InstallOpenTUIHarnessOptions` and handle internally

Option 2 (RECOMMENDED, cleaner) — Add `fakeClock` to `InstallOpenTUIHarnessOptions`:
```ts
// install.ts line 35 area
fakeClock?: boolean;
// line 80:
getTs: opts.fakeClock ? () => seq * 16 : () => Date.now(),
```

Then in `agent-mode.ts:157`:
```ts
const harnessHandle = installOpenTUIHarness({
  registry, transport, fps: 60,
  onFrame: () => idle.markActivity(),
  fakeClock: opts.fakeClock,
});
```

**Files to change (C1):**
- `packages/agent-harness-opentui/src/install.ts` — add `fakeClock?: boolean` to options, use `seq * 16` when set
- `packages/agent-harness-opentui/src/agent-mode.ts:157` — pass `fakeClock: opts.fakeClock`

---

## Group D — Cost-leak TUI tests (4 tests)

**Failing tests:**
- `cost-leak-b3-tui.spec.ts > sub-agent compactor reduces cumulative prompt size`
- `cost-leak-b4-tui.spec.ts > top-level compactor reduces cumulative prompt size`
- `cost-leak-c1-tui.spec.ts > DeepSeek cache field split`
- `cost-leak-g1-tui.spec.ts > orchestrator drops maxOutputTokens`

**Root cause:**

All 4 tests follow the same pattern:
1. `spawnCostLeakHarness` → calls `ctx.driver.wait_for({ idle: true, timeoutMs: 15_000 })` (line 96 in `cost-leak-tui-helpers.ts`)
2. Drive a prompt
3. `wait_for({ selector: "role=log" })` — waits for log to appear
4. Further processing

Step 1 has the **same empty-frame idle race as Group A**: `wait_for({ idle })` resolves before `nodes: []` → then `driver.type(...)` is dispatched, but the TUI may not be ready.

For B3/B4 specifically: after submitting the prompt, these tests also do `wait_for({ selector: "role=log", timeoutMs: 20_000 })`. If the initial frame race causes the `type()` command to be dispatched before the TUI has rendered the input textbox, the keystrokes get lost → the orchestrator never runs → no dump is written → `expect(calls.length).toBeGreaterThanOrEqual(3)` fails.

For C1: `expect(usageEvent).not.toBeNull()` fails. The poll loop runs but `driver.last_event("usage")` returns null. Root cause: `type("hi") + press("Enter")` were dispatched before the TUI rendered (same empty-frame race in `spawnCostLeakHarness:96`).

For G1: same — `wait_for({ selector: "role=log" })` times out because the initial `type("hello")` was dispatched to an un-ready TUI.

**Fix D1 (RECOMMENDED):** In `cost-leak-tui-helpers.ts:96`, after the idle wait, add:
```ts
// Wait for the textbox to confirm TUI is fully rendered before returning
await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
```

This is the same fix as A1 but applied centrally in the helper so all 4 cost-leak tests benefit from one change.

**Files to change (D1):**
- `tests/harness/cost-leak-tui-helpers.ts:96` — add `wait_for({ selector: "role=textbox" })` after idle wait

---

## Application Order

Apply fixes in this order (each group is independent but some cascade):

| Step | Fix | Tests unblocked | Risk |
|------|-----|-----------------|------|
| 1 | D1: add textbox wait in `cost-leak-tui-helpers.ts` | b3, b4, c1, g1 (4 tests) | Very low — additive wait |
| 2 | A1: add textbox/card wait in each Group A spec | composer, askcard, council-flow, subagents (4 tests) | Very low |
| 3 | B1: replace idle waits with `waitForStable` in point-to-existing, ideal-halt; extract helper | point-to-existing, ideal-halt, partial ideal-init-new | Low — uses existing pattern |
| 4 | C1: fix fakeClock threading through `install.ts` | determinism (1 test) | Low-medium — touches package code, needs pkg rebuild |

Step 4 has the highest risk because it touches `packages/agent-harness-opentui/src/install.ts` which is a published package. Verify with `bunx tsc --noEmit` after.

---

## Risk Assessment

| Fix | Surface | Regression Risk | Effort |
|-----|---------|-----------------|--------|
| A1 | Test files only | None — additive wait | 15 min |
| B1 | Test files only | None — replaces flaky wait with stable poll | 20 min |
| C1 | Package source | Low — adds optional field, backward-compat | 30 min |
| D1 | Test helper | None — additive wait | 5 min |

**Total estimate: ~1.5 hours**

---

## Verification Approach

After each step group:

1. Push branch → CI runs `vitest.harness.config.ts`
2. Target: passing count increases from 126/165 → 138/165 (after A1+D1+B1) → 139/165 (after C1)
3. Local Windows: `bunx vitest -c vitest.harness.config.ts run tests/harness/` — confirm no regression
4. WSL fallback: `wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && git pull && bunx vitest -c vitest.harness.config.ts run tests/harness/'`

---

## Key File:Line Citations

| Issue | File | Line |
|-------|------|------|
| Idle fires on empty frame | `packages/agent-harness-core/src/idle.ts:6-23` | Idle fires after ANY 50ms quiescence |
| Empty initial frame always emitted | `packages/agent-harness-opentui/src/reconciler-hook.ts:58` | `lastHash === undefined` → always send first frame |
| `onFrame` only marks activity when nodes change | `packages/agent-harness-opentui/src/agent-mode.ts:162` | `onFrame: () => idle.markActivity()` |
| `wait_for(idle)` resolves on any idle | `packages/agent-harness-core/src/driver.ts:194-196` | `() => lastIdleAt >= capturedStart` |
| `fakeClock` returns 0, not `seq*16` | `packages/agent-harness-opentui/src/agent-mode.ts:133` | `opts.fakeClock ? 0 : Date.now()` |
| `install.ts` ignores fakeClock | `packages/agent-harness-opentui/src/install.ts:80` | `getTs: () => Date.now()` — hardcoded |
| Cost-leak helper idle race | `tests/harness/cost-leak-tui-helpers.ts:96` | `wait_for({ idle })` without textbox guard |
| `waitForStable` pattern (working example) | `tests/harness/ideal-init-new-flow.spec.ts:35-42` | Reference implementation to extract |
