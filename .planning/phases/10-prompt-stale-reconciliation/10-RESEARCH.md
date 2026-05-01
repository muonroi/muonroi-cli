# Phase 10: Prompt-stale Reconciliation - Research

**Researched:** 2026-05-02
**Domain:** Experience Engine integration — PostToolUse hook, PIL Layer 3 state tracking
**Confidence:** HIGH

## Summary

Phase 10 closes a gap in the EE learning loop: when the EE injects experience suggestions
into the agent's prompt via PIL Layer 3 (bridge-based) or the PreToolUse intercept path
(HTTP-based), and the agent ignores those suggestions, EE currently has no signal. The
`promptStale` call already exists at compact/clear/session-end trigger points
(`orchestrator.ts`, `ui/app.tsx`, `ui/slash/clear.ts`, `ui/slash/compact.ts`), but
**per-turn** reconciliation — triggered from the PostToolUse hook after each tool call —
is entirely absent.

The three requirements are narrowly scoped:
- **STALE-01**: PIL Layer 3 must record the IDs of points it injects so they appear in
  `_lastSurfacedIds` alongside HTTP-intercept surfaced IDs.
- **STALE-02**: PostToolUse handler calls `/api/prompt-stale` for any surfaced IDs that
  were not acknowledged via explicit `feedback()` in the same turn.
- **STALE-03**: The reconcile call is fire-and-forget; it must never add latency to the
  next turn.

All primitives are already built: `getLastSurfacedState()` / `_lastSurfacedIds` in
`intercept.ts`, `client.promptStale()` in `client.ts`, `PromptStaleRequest` /
`PromptStaleResponse` in `types.ts`, and the PostToolUse branch in `hooks/index.ts`.

**Primary recommendation:** Add a `reconcilePromptStale()` function in a new
`src/ee/prompt-stale.ts` module; call it fire-and-forget inside `executeEventHooks()`
PostToolUse branch in `hooks/index.ts`; update `layer3EeInjection()` to write its injected
point IDs back to `_lastSurfacedIds` via a new exported setter in `intercept.ts`.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
All implementation choices are at Claude's discretion — pure infrastructure phase.

Key existing assets that constrain approach:
- `intercept.ts` already tracks `_lastSurfacedIds` and `_lastSurfacedTimestamp` via `getLastSurfacedState()`
- `client.ts` already has `promptStale()` method with 2s timeout + offline queue fallback
- `types.ts` already defines `PromptStaleRequest` / `PromptStaleResponse`
- PostToolUse handler in `hooks/index.ts` is the natural integration point
- Fire-and-forget semantics must be preserved (B-4 budget constraint)

### Claude's Discretion
All implementation choices (module placement, function signatures, test strategy).

### Deferred Ideas (OUT OF SCOPE)
None — infrastructure phase.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| STALE-01 | PIL Layer 3 tracks suggestions injected into prompt | Add `updateLastSurfacedState()` setter in `intercept.ts`; call from `layer3EeInjection()` with the EEPoint IDs returned by bridge search |
| STALE-02 | After each turn, call /api/prompt-stale for suggestions not used by agent | New `reconcilePromptStale()` in `src/ee/prompt-stale.ts`; called from PostToolUse branch in `hooks/index.ts`; reads `getLastSurfacedState()`, calls `client.promptStale()`, resets state |
| STALE-03 | Reconciliation is async fire-and-forget (does not block next turn) | Same pattern as compact/clear/session-end: `.catch(() => {})` on the returned promise; never `await` inside the hook dispatcher |
</phase_requirements>

---

## Standard Stack

### Core (all already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | project-defined | Unit test framework | Already used project-wide |
| TypeScript | project-defined | Language | All src files are .ts |

No new dependencies required. This phase is pure integration of existing modules.

**Installation:** None needed.

## Architecture Patterns

### Recommended Project Structure

New file:
```
src/ee/prompt-stale.ts          # reconcilePromptStale() + resetSurfacedState()
src/ee/prompt-stale.test.ts     # unit tests
```

Modified files:
```
src/ee/intercept.ts             # export updateLastSurfacedState() setter
src/pil/layer3-ee-injection.ts  # call updateLastSurfacedState() after bridge search
src/hooks/index.ts              # fire reconcilePromptStale() in PostToolUse branch
src/ee/__test-stubs__/ee-server.ts  # add /api/prompt-stale handler
```

### Pattern 1: Surfaced-state setter in intercept.ts

**What:** Export a setter so PIL Layer 3 (and future callers) can register injected IDs
without going through the HTTP intercept path.

**When to use:** Any code path that injects EE suggestions into the prompt context but
does not go through `client.intercept()`.

```typescript
// src/ee/intercept.ts — add alongside getLastSurfacedState()
export function updateLastSurfacedState(ids: string[]): void {
  if (ids.length === 0) return;
  _lastSurfacedIds = [...ids];
  _lastSurfacedTimestamp = new Date().toISOString();
}

/**
 * Resets surfaced state to empty — called after prompt-stale reconciliation
 * so the same IDs are not re-reported on the next turn.
 */
export function resetLastSurfacedState(): void {
  _lastSurfacedIds = [];
  _lastSurfacedTimestamp = null;
}
```

### Pattern 2: PIL Layer 3 registers injected IDs (STALE-01)

**What:** After `queryEeBridge` returns points, call `updateLastSurfacedState()` with
the point IDs.

```typescript
// src/pil/layer3-ee-injection.ts — after bridge search resolves
import { updateLastSurfacedState } from "../ee/intercept.js";

// Inside layer3EeInjection(), after points resolved:
if (points.length > 0) {
  updateLastSurfacedState(points.map((p) => String(p.id)));
}
```

Note: `p.id` is the Qdrant point ID from `EEPoint`. Currently `formatExperienceHints`
renders it as `[id:${p.id}]` in the hint text — these same IDs are what EE expects in
`PromptStaleRequest.state.surfacedIds`.

### Pattern 3: reconcilePromptStale() module (STALE-02 + STALE-03)

**What:** Standalone function that reads current surfaced state, fires promptStale, then
resets state.

```typescript
// src/ee/prompt-stale.ts
import { getDefaultEEClient } from "./intercept.js";
import { getLastSurfacedState, resetLastSurfacedState } from "./intercept.js";

/**
 * Fire-and-forget prompt-stale reconciliation.
 * Called from PostToolUse hook after each tool-use turn.
 * Returns void — caller must NOT await (B-4).
 */
export function reconcilePromptStale(cwd: string, tenantId = "local"): void {
  const { surfacedIds, timestamp } = getLastSurfacedState();
  if (surfacedIds.length === 0) return; // nothing to reconcile

  resetLastSurfacedState(); // reset before async call to avoid double-report

  getDefaultEEClient()
    .promptStale({
      state: { surfacedIds, timestamp },
      nextPromptMeta: { trigger: "auto-compact", cwd, tenantId },
    })
    .catch(() => {
      // Errors swallowed — fire-and-forget (B-4)
    });
}
```

**Design note on trigger value:** The `PromptStaleRequest.nextPromptMeta.trigger` field
is typed as `"compact" | "clear" | "auto-compact" | "session-end"`. The per-turn
PostToolUse reconciliation does not fit any of these exactly. Two options:

1. Reuse `"auto-compact"` as the closest semantic match (each turn is an implicit
   context refresh).
2. Add `"post-tool"` to the trigger union in `types.ts`.

**Recommendation:** Extend the union with `"post-tool"` — it is the accurate descriptor
and avoids misrepresenting semantics to EE. This is a one-line change in `types.ts`.

### Pattern 4: Integration point in hooks/index.ts (STALE-02 + STALE-03)

**What:** Call `reconcilePromptStale()` (void, not await) inside the PostToolUse and
PostToolUseFailure branches.

```typescript
// src/hooks/index.ts — in the PostToolUse branch, after posttool() call
import { reconcilePromptStale } from "../ee/prompt-stale.js";

// Inside PostToolUse branch, after: await posttool(...)
reconcilePromptStale(cwd); // fire-and-forget — returns void
```

Note: `posttool()` itself is awaited (it is `async Promise<void>`) but
`reconcilePromptStale()` returns `void` immediately — the async HTTP call runs
independently. This preserves B-4.

### Pattern 5: Stub server extension

The `src/__test-stubs__/ee-server.ts` currently has no `/api/prompt-stale` handler.
Tests will need it added:

```typescript
// In StubConfig interface
promptStale?: (req: any) => any;

// In calls initialization
promptStale: [],

// In route dispatch
if (url.pathname === "/api/prompt-stale") {
  calls.promptStale.push(body);
  const r = cfg.promptStale?.(body) ?? { ok: true, unused: [], irrelevant: [], expired: [] };
  sendJson(res, r);
  return;
}
```

### Anti-Patterns to Avoid

- **Awaiting reconcilePromptStale in the hook dispatcher:** Would block the orchestrator
  before the next turn starts. Must remain void / fire-and-forget.
- **Resetting surfacedIds inside getLastSurfacedState():** The getter is read-only;
  resetting must be a separate explicit call so callers control when state clears.
- **Double-reporting:** If `resetLastSurfacedState()` is called after dispatching the
  HTTP call (not before), a second PostToolUse event on the same turn could re-report
  the same IDs. Reset BEFORE dispatching the HTTP call.
- **Reporting on every PostToolUse regardless of empty state:** The guard
  `if (surfacedIds.length === 0) return;` prevents wasteful no-op HTTP calls.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Offline fallback for failed promptStale | Custom retry logic | `client.promptStale()` already enqueues on failure | Already implemented in Phase 09; enqueue path is inside the client method |
| HTTP fire-and-forget pattern | Custom wrapper | `.catch(() => {})` on returned Promise | Established pattern across posttool, feedback, touch, clear, compact |
| State threading between PIL and hooks | New shared store | `_lastSurfacedIds` + `getLastSurfacedState()` already in `intercept.ts` | Adding `updateLastSurfacedState()` extends it minimally |

## Common Pitfalls

### Pitfall 1: PIL Layer 3 IDs vs. HTTP intercept IDs differ in type

**What goes wrong:** `EEPoint.id` from Qdrant bridge is `string | number` (Qdrant allows
both). The HTTP intercept path returns `principle_uuid` which is always a UUID string.
If `p.id` is a number, `surfacedIds` would contain stringified integers, not UUIDs, and
EE's `/api/prompt-stale` handler may reject or silently ignore them.

**Why it happens:** `EEPoint` from `bridge.ts` maps Qdrant `PointStruct` which allows
`id: string | number`.

**How to avoid:** Verify how the `experience-behavioral` Qdrant collection stores IDs.
If IDs are always UUIDs (strings), `String(p.id)` is safe. If they are integers, the
`payload` may contain a `principle_uuid` field to use instead.

**Warning signs:** EE logs show `unused` array in response containing integers, or
`PromptStaleResponse.unused` never empties despite suggestions being ignored.

**Action:** Before implementing STALE-01, check `EEPoint` payload structure for a
`principle_uuid` field, and prefer that over `p.id` if present.

### Pitfall 2: resetLastSurfacedState() called too early clears HTTP-intercept state

**What goes wrong:** If `reconcilePromptStale()` fires from PostToolUse but the *next*
PreToolUse (for the same conversation turn, in multi-step tool use) has not yet run,
resetting `_lastSurfacedIds` is correct. But if PreToolUse and PostToolUse fire in
rapid alternation for batched tool calls, one tool's PostToolUse could clear state set
by the *next* tool's PreToolUse.

**Why it happens:** Claude CLI can execute multiple tools in one agent turn (parallel
tool use). PreToolUse fires before each tool; PostToolUse fires after each. Module-level
`_lastSurfacedIds` is shared state.

**How to avoid:** The reset-before-dispatch approach in `reconcilePromptStale()` is
correct as long as PreToolUse for tool N+1 fires after PostToolUse for tool N — which
is the current sequential model. The risk only materialises with truly concurrent
PreToolUse calls, which the current hook dispatcher does not do.

**Warning signs:** `_lastSurfacedIds` is always empty when PostToolUse reads it despite
suggestions being shown.

### Pitfall 3: trigger field not accepted by EE server

**What goes wrong:** If the EE `/api/prompt-stale` endpoint validates the `trigger`
field against a fixed enum and `"post-tool"` is not in its allowed set, the call returns
a non-ok response, gets enqueued, and fills the offline queue with replay-failures.

**Why it happens:** Types in CLI `types.ts` and server validation are separate; adding a
new trigger value in the CLI type does not automatically update the server.

**How to avoid:** Either (a) use an existing trigger value (`"auto-compact"`) so no
server change is needed, or (b) coordinate with the EE server to add `"post-tool"` to
its validation. Check `D:/Personal/Core/experience-engine/` if accessible.

**Recommendation:** Use `"auto-compact"` as the trigger for the per-turn PostToolUse
reconciliation to avoid a cross-repo server dependency for this phase.

### Pitfall 4: Test isolation — module-level state leaks between tests

**What goes wrong:** `_lastSurfacedIds` and `_lastSurfacedTimestamp` are module-level
variables. Tests that call `updateLastSurfacedState()` without resetting afterwards will
contaminate subsequent tests in the same vitest worker.

**How to avoid:** Export `resetLastSurfacedState()` and call it in `afterEach()` in
test files that touch surfaced state.

## Code Examples

### Minimal integration in hooks/index.ts

```typescript
// Source: existing pattern from hooks/index.ts PostToolUse branch
if (input.hook_event_name === "PostToolUse") {
  // ... existing posttool() call ...
  await posttool({ ... }, judgeCtx);

  // STALE-02/STALE-03: fire-and-forget per-turn reconciliation
  reconcilePromptStale(cwd); // void — does not block
  return emptyResult();
}
```

### Test skeleton for prompt-stale.test.ts

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateLastSurfacedState, resetLastSurfacedState } from "./intercept.js";
import { reconcilePromptStale } from "./prompt-stale.js";

const mockPromptStale = vi.fn().mockResolvedValue({ ok: true, unused: [], irrelevant: [], expired: [] });

vi.mock("./intercept.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intercept.js")>();
  return {
    ...actual,
    getDefaultEEClient: () => ({ promptStale: mockPromptStale }),
  };
});

afterEach(() => {
  resetLastSurfacedState();
  mockPromptStale.mockClear();
});

describe("reconcilePromptStale()", () => {
  it("does nothing when no surfaced IDs", () => {
    reconcilePromptStale("/tmp");
    expect(mockPromptStale).not.toHaveBeenCalled();
  });

  it("calls promptStale with surfaced IDs then resets state", async () => {
    updateLastSurfacedState(["id-1", "id-2"]);
    reconcilePromptStale("/tmp");
    await vi.runAllTimersAsync(); // flush microtasks
    expect(mockPromptStale).toHaveBeenCalledOnce();
    expect(mockPromptStale.mock.calls[0][0].state.surfacedIds).toEqual(["id-1", "id-2"]);
  });

  it("returns void (fire-and-forget)", () => {
    updateLastSurfacedState(["id-1"]);
    const result = reconcilePromptStale("/tmp");
    expect(result).toBeUndefined();
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| promptStale only at compact/clear/session-end | Also at PostToolUse per-turn | Phase 10 (this phase) | EE gets per-turn signal on ignored suggestions, not just at context boundaries |
| PIL Layer 3 IDs invisible to EE | PIL Layer 3 registers IDs via updateLastSurfacedState() | Phase 10 (this phase) | Bridge-sourced suggestions tracked for stale detection alongside HTTP-intercept suggestions |

## Open Questions

1. **EEPoint.id type — UUID string or integer?**
   - What we know: `EEPoint` maps Qdrant PointStruct; `p.id` used as `[id:${p.id}]` in
     rendered hints; `experience-behavioral` collection stores Qdrant points
   - What's unclear: whether the collection uses UUID strings or integer IDs; whether the
     `payload` contains a `principle_uuid` field separate from the Qdrant row ID
   - Recommendation: Check `bridge.ts` EEPoint type and/or query the live collection
     during Wave 0; use `payload.principle_uuid ?? String(p.id)` as the safe fallback

2. **trigger enum: extend or reuse "auto-compact"?**
   - What we know: `PromptStaleRequest.nextPromptMeta.trigger` is a string union in
     `types.ts`; EE server validation is not verified from CLI codebase alone
   - What's unclear: Whether EE server validates trigger values strictly
   - Recommendation: Use `"auto-compact"` for Phase 10 to avoid cross-repo dependency;
     extend to `"post-tool"` in a follow-on phase if EE server is updated

## Environment Availability

Step 2.6: SKIPPED — no external CLI/tool dependencies. Phase only modifies TypeScript
source files and adds tests using the existing vitest + stub server infrastructure.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (via `bunx vitest run`) |
| Config file | `vitest.config.ts` at project root |
| Quick run command | `bunx vitest run src/ee/prompt-stale.test.ts` |
| Full suite command | `bunx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| STALE-01 | `updateLastSurfacedState()` called from `layer3EeInjection()` when points injected | unit | `bunx vitest run src/pil/layer3-ee-injection.test.ts` | Verify if exists |
| STALE-01 | `getLastSurfacedState()` returns PIL-injected IDs after Layer 3 runs | unit | `bunx vitest run src/ee/intercept.test.ts` | ✅ (needs new case) |
| STALE-02 | `reconcilePromptStale()` calls `client.promptStale()` when IDs are present | unit | `bunx vitest run src/ee/prompt-stale.test.ts` | ❌ Wave 0 |
| STALE-02 | `reconcilePromptStale()` is called from PostToolUse branch in `hooks/index.ts` | unit | `bunx vitest run src/hooks/index.test.ts` | Verify if exists |
| STALE-02 | Stub server `/api/prompt-stale` handler receives request | integration | `bunx vitest run src/ee/intercept.test.ts` | ❌ Wave 0 case |
| STALE-03 | `reconcilePromptStale()` returns `undefined` (not a Promise) | unit | `bunx vitest run src/ee/prompt-stale.test.ts` | ❌ Wave 0 |
| STALE-03 | PostToolUse hook returns `emptyResult()` without awaiting reconciliation | unit | `bunx vitest run src/hooks/index.test.ts` | Verify if exists |

### Sampling Rate
- **Per task commit:** `bunx vitest run src/ee/prompt-stale.test.ts`
- **Per wave merge:** `bunx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/ee/prompt-stale.ts` — new module for `reconcilePromptStale()`
- [ ] `src/ee/prompt-stale.test.ts` — covers STALE-02, STALE-03
- [ ] `/api/prompt-stale` handler in `src/__test-stubs__/ee-server.ts` — covers integration test cases
- [ ] `updateLastSurfacedState()` + `resetLastSurfacedState()` exported from `src/ee/intercept.ts`

## Sources

### Primary (HIGH confidence)
- Direct source read: `src/ee/intercept.ts` — `_lastSurfacedIds`, `getLastSurfacedState()`, intercept tracking logic
- Direct source read: `src/ee/client.ts` — `promptStale()` implementation, 2s timeout, offline queue fallback
- Direct source read: `src/ee/types.ts` — `PromptStaleRequest`, `PromptStaleResponse`, trigger union
- Direct source read: `src/hooks/index.ts` — PostToolUse branch, `_lastWarningResponse` latch pattern
- Direct source read: `src/ee/posttool.ts` — fire-and-forget pattern baseline
- Direct source read: `src/pil/layer3-ee-injection.ts` — PIL Layer 3 bridge search, EEPoint IDs
- Direct source read: `src/ee/offline-queue.ts` — enqueue pattern for failed calls
- Direct source read: `src/orchestrator/orchestrator.ts:1733-1741` — existing promptStale fire-and-forget at auto-compact
- Direct source read: `src/ui/app.tsx:1825-1842` — existing promptStale at session-end
- Direct source read: `src/ui/slash/clear.ts:73-82` — existing promptStale at /clear
- Direct source read: `src/ui/slash/compact.ts:27-36` — existing promptStale at /compact

### Secondary (MEDIUM confidence)
- CONTEXT.md: confirmed existing assets and integration points

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, all primitives verified in source
- Architecture: HIGH — patterns derived from existing code in the same codebase
- Pitfalls: MEDIUM-HIGH — Pitfall 1 (EEPoint ID type) is unverified without querying
  live Qdrant; Pitfall 3 (trigger enum server validation) is unverified without reading
  EE server code
- Test strategy: HIGH — vitest patterns directly observed in existing test files

**Research date:** 2026-05-02
**Valid until:** 2026-06-01 (stable internal codebase, no external dependencies)
