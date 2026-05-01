# Phase 7: Full Pipeline Validation - Research

**Researched:** 2026-05-01
**Domain:** EE hook pipeline integration testing — PreToolUse → PostToolUse → Judge → Feedback → Touch ordering and auto-judge correctness
**Confidence:** HIGH

## Summary

Phase 7 is a pure validation/integration phase. All five pipeline components (intercept, posttool, judge, fireFeedback, touch) already exist and are individually unit-tested. The gap is a single integration test that asserts all five events fire in correct order for one tool invocation, plus a sequencing guard that prevents routeFeedback from firing before posttool completes.

The current orchestrator wires posttool as fire-and-forget (`void this.fireHook(postInput)`), meaning there is no await between the PostToolUse posttool call and the routeFeedback call at turn completion. The race documented in CONTEXT.md is real: routeFeedback fires once the streaming loop completes, but posttool HTTP calls are non-blocking. The fix is to track whether posttool has resolved before routeFeedback fires, using a promise latch or awaiting posttool within the tool-result handler.

The auto-judge (judge.ts) is already deterministic and classifies correctly per unit tests. No code changes are needed in judge.ts. The integration test must verify that `fireFeedback` is called with `judgeCtx` from the posttool call site in hooks/index.ts — which currently passes `judgeCtx: undefined`, bypassing the auto-judge entirely.

**Primary recommendation:** One integration test file (`src/ee/__tests__/pipeline.integration.test.ts`) using the existing `startStubEEServer` stub, asserting all five stub endpoint calls in order. Then fix the hooks/index.ts posttool call site to pass `judgeCtx` from PreToolUse context, and optionally add a Promise latch in the orchestrator to ensure posttool settles before routeFeedback.

**Primary recommendation:** Use `startStubEEServer` + `await new Promise(r => setTimeout(r, 50))` settle pattern (already established in touch.test.ts) for integration test. For the race condition fix, capture the posttool Promise in hooks/index.ts and await it before returning from the PostToolUse handler.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
All implementation choices are at Claude's discretion — pure infrastructure/validation phase. Key constraints from prior phases:
- Pipeline order: PreToolUse → PostToolUse → Judge → Feedback → Touch (5 events per tool call)
- posttool() must be awaited before routeFeedback fires (race condition prevention)
- Auto-judge classifies FOLLOWED / IGNORED / IRRELEVANT without agent intervention
- Integration test must assert all 5 events for a single tool invocation
- Existing bridge.ts, intercept.ts, posttool.ts, judge.ts, routeFeedback wiring from Phases 5-6

### Claude's Discretion
All implementation choices are at Claude's discretion.

### Deferred Ideas (OUT OF SCOPE)
None — infrastructure phase stayed within scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ROUTE-12 | Full EE hook pipeline verified end-to-end — PreToolUse → PostToolUse → Judge → Feedback → Touch fires deterministically on every tool call; auto-judge tags FOLLOWED/IGNORED/IRRELEVANT without agent intervention | Integration test using startStubEEServer asserting all 5 endpoints. Judge already implemented in judge.ts. Fix posttool call site to pass judgeCtx. Race guard in orchestrator. |
</phase_requirements>

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | Already installed | Unit + integration test runner | Established in all src/ee/*.test.ts files |
| Node http (built-in) | Node 20+ | Stub EE server | Already used in src/__test-stubs__/ee-server.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| vi.fn() / vi.mock | vitest built-in | Mock module dependencies in unit tests | When testing in isolation (judge, posttool units already mocked this way) |
| startStubEEServer | Internal (`src/__test-stubs__/ee-server.ts`) | HTTP-level integration stub | When asserting actual HTTP calls to all 5 EE endpoints |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| startStubEEServer | msw (mock service worker) | msw adds dependency and complexity; stub server already exists and has all needed endpoints |
| vi.spyOn for integration | Real HTTP stub | Spying skips network path; for ROUTE-12 the network path must be exercised |

**Installation:** No new packages required. All tooling is already present.

---

## Architecture Patterns

### Current Pipeline Wire Diagram

```
orchestrator.ts (processMessage)
  │
  ├── tool-call part
  │     └── fireHook(PreToolUse) → intercept.ts → POST /api/intercept
  │           ↳ warningResponse stored (currently NOT threaded to posttool)
  │
  └── tool-result part
        ├── void fireHook(PostToolUse) → hooks/index.ts → posttool(payload, judgeCtx?)
        │     ├── client.posttool() → POST /api/posttool  [fire-and-forget]
        │     └── fireFeedback(judgeCtx)  ← judgeCtx currently UNDEFINED (bug)
        │           ├── judge(ctx) → FOLLOWED | IGNORED | IRRELEVANT
        │           ├── client.feedback() → POST /api/feedback  [fire-and-forget]
        │           └── if FOLLOWED: client.touch() → POST /api/principle/touch  [fire-and-forget]
        │
        └── [turn complete] → void routeFeedback(...)  [fire-and-forget, race risk]
```

### Gap Analysis (what needs fixing for ROUTE-12)

**Gap 1: judgeCtx not threaded to posttool call site**

In `src/hooks/index.ts` lines 104-118, `posttool(payload)` is called without `judgeCtx`. This means `fireFeedback` is never called, so Feedback and Touch never fire. The `warningResponse` from PreToolUse is not captured and not passed forward.

Fix: Thread `warningResponse` from `intercept()` return value to the PostToolUse handler. This requires a shared variable between the PreToolUse and PostToolUse branches in `executeEventHooks`, or a caller-managed context. Current `executeEventHooks` handles both events in the same function scope — a module-level `_lastWarningResponse` variable (reset per tool call) is the simplest fix.

**Gap 2: Race condition — posttool not awaited before routeFeedback**

In `orchestrator.ts` line 2300, PostToolUse fires as `void this.fireHook(postInput).catch(() => {})`. The HTTP posttool call within is itself fire-and-forget. The routeFeedback call at line 2432 fires once the streaming loop completes. Since posttool is fire-and-forget there is no ordering guarantee. In practice, routeFeedback fires after posttool resolves at the HTTP layer, but this is not guaranteed under load.

Fix: Capture a Promise from the posttool HTTP call and await it before routeFeedback. The simplest approach: make `posttool()` return `Promise<void>` and await it at the call site in hooks/index.ts, then await `fireHook(postInput)` in the orchestrator (currently `void`-cast).

**Gap 3: Integration test does not exist**

No test file currently asserts all 5 events in sequence for one tool invocation.

Fix: Create `src/ee/__tests__/pipeline.integration.test.ts`.

### Pattern 1: End-to-End Integration Test (startStubEEServer)

**What:** Start a local HTTP stub, configure all 5 endpoint handlers, simulate one PreToolUse → PostToolUse invocation via the hooks module, assert endpoint call counts and ordering.

**When to use:** ROUTE-12 success criterion requires this exactly.

**Example:**
```typescript
// src/ee/__tests__/pipeline.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStubEEServer, type StubHandle } from "../../__test-stubs__/ee-server.js";
import { createEEClient, resetEEClientState } from "../client.js";
import { setDefaultEEClient } from "../intercept.js";
import { executeEventHooks } from "../../hooks/index.js";

describe("Full pipeline: PreToolUse → PostToolUse → Judge → Feedback → Touch", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    stub = await startStubEEServer({
      intercept: () => ({
        decision: "allow",
        matches: [{ principle_uuid: "P1", confidence: 0.9, why: "test", message: "warning",
                    embedding_model_version: "v1", scope_label: "global",
                    last_matched_at: new Date().toISOString() }],
      }),
    });
    resetEEClientState();
    setDefaultEEClient(createEEClient({ baseUrl: `http://127.0.0.1:${stub.port}` }));
  });

  afterAll(() => stub.stop());

  it("fires all 5 events for a single tool invocation", async () => {
    const cwd = process.cwd();

    // Step 1: PreToolUse → intercept
    await executeEventHooks({ hook_event_name: "PreToolUse", tool_name: "Edit",
                               tool_input: { path: "/tmp/x.ts" }, cwd }, cwd);

    // Step 2: PostToolUse → posttool + judge + feedback + touch
    await executeEventHooks({ hook_event_name: "PostToolUse", tool_name: "Edit",
                               tool_input: { path: "/tmp/x.ts" },
                               tool_output: { result: "ok" }, cwd }, cwd);

    // Settle fire-and-forget HTTP calls
    await new Promise((r) => setTimeout(r, 100));

    expect(stub.calls.intercept).toHaveLength(1);   // PreToolUse
    expect(stub.calls.posttool).toHaveLength(1);    // PostToolUse
    expect(stub.calls.feedback).toHaveLength(1);    // Judge → Feedback
    expect(stub.calls.touch).toHaveLength(1);       // FOLLOWED → Touch
  });
});
```

### Pattern 2: Module-Level warningResponse Latch (judgeCtx threading)

**What:** Track the last PreToolUse warning response in hooks/index.ts so the PostToolUse handler can pass `judgeCtx` to `posttool()`.

**When to use:** This is the minimal-impact fix that avoids changing the public API of `executeEventHooks`.

**Example:**
```typescript
// src/hooks/index.ts — add near top
let _lastWarningResponse: import("../ee/types.js").InterceptResponse | null = null;

// In PreToolUse branch:
const r = await interceptWithDefaults({ ... });
_lastWarningResponse = r;  // capture for PostToolUse

// In PostToolUse branch:
const judgeCtx: JudgeContext = {
  warningResponse: _lastWarningResponse,
  toolName: input.tool_name,
  outcome: { success: true },
  cwdMatchedAtPretool: _lastWarningResponse !== null,
  diffPresent: false,   // conservative default; diffPresent=false → never IGNORED on this flag
  tenantId: "local",
};
_lastWarningResponse = null;  // reset after use
posttool(payload, judgeCtx);
```

**Critical:** `_lastWarningResponse` must be reset after use to prevent cross-turn contamination.

### Pattern 3: Race Condition Guard (posttool → routeFeedback ordering)

**What:** posttool() currently returns void; changing it to return Promise<void> lets the orchestrator await it before firing routeFeedback.

**When to use:** Required by success criterion #3 — "posttool() awaited before routeFeedback fires".

**Option A — Minimal (preferred):** Return `Promise<void>` from `posttool()` (only the HTTP call, not fireFeedback which is already sync void). The orchestrator then awaits `fireHook(PostToolUse)` before reaching the routeFeedback callsite.

```typescript
// src/ee/posttool.ts
export async function posttool(payload: PostToolPayload, judgeCtx?: JudgeContext): Promise<void> {
  await getDefaultEEClient().posttool(payload);   // await HTTP
  if (judgeCtx) fireFeedback(judgeCtx);           // sync after posttool HTTP settles
}
```

Note: `client.posttool()` is currently `void` (fire-and-forget). To make it awaitable, change `EEClient.posttool` return type to `Promise<void>` and update `client.ts` to `return f(...).catch(...)`.

**Option B — Simpler:** Keep posttool fire-and-forget, add a short `await Promise.resolve()` in the orchestrator before routeFeedback to yield the microtask queue. This is weaker but avoids changing signatures.

Option A is preferred because it provides a real ordering guarantee documented in STATE.md.

### Anti-Patterns to Avoid

- **Setting `_lastWarningResponse` as class state:** hooks/index.ts is a module, not a class. Module-level variable is correct and consistent with `_cachedScope` already in the file.
- **Awaiting fireFeedback:** fireFeedback is synchronous void by design (B-4 invariant). Do not make it async.
- **Checking `stub.calls` ordering by array index:** The test must assert counts and content, not index timing, because fire-and-forget HTTP calls land in non-deterministic order relative to each other (feedback vs touch). Use `toHaveLength` + `toMatchObject`, not order assertions.
- **Not resetting EE client state between tests:** Must call `resetEEClientState()` in `beforeEach`/`beforeAll` to clear circuit breaker + cache. Already established in intercept.test.ts.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTTP stub server | Custom Express/Hapi server | `startStubEEServer` (src/__test-stubs__/ee-server.ts) | Already handles all 5 EE endpoints, port 0 binding, call recording |
| Auto-judge logic | New classification code | `judge()` in src/ee/judge.ts | Already deterministic, fully unit-tested, correct rules |
| Fire-and-forget settle | sleep(N) polling | `await new Promise(r => setTimeout(r, 100))` | Established pattern in touch.test.ts; 50-100ms sufficient for localhost |
| Client state reset | Manual flag clearing | `resetEEClientState()` from client.ts | Clears circuit breaker + cache + rate-limit timer atomically |

**Key insight:** Every component needed for ROUTE-12 already exists. This phase is wiring + testing, not building.

---

## Common Pitfalls

### Pitfall 1: judgeCtx Never Reaches posttool
**What goes wrong:** PostToolUse fires, posttool is called, but Feedback and Touch are never hit because `judgeCtx` is `undefined`. Integration test asserts `stub.calls.feedback.length === 0`.
**Why it happens:** `executeEventHooks` in hooks/index.ts calls `posttool(payload)` without the second argument. warningResponse from PreToolUse is not stored.
**How to avoid:** Add `_lastWarningResponse` latch (Pattern 2 above). Verify integration test now shows `feedback.length === 1`.
**Warning signs:** `stub.calls.feedback` stays empty despite successful intercept with matches.

### Pitfall 2: Module Cache Prevents _lastWarningResponse Reset
**What goes wrong:** Vitest module cache means `_lastWarningResponse` persists across test cases within a file.
**Why it happens:** `vi.mock` replaces the module, but module-level state in unmocked modules persists.
**How to avoid:** Call a `resetHookState()` export (or use `vi.resetModules()`) in `beforeEach` if needed. For integration tests using real modules, this is not a concern if each test uses a fresh stub.
**Warning signs:** Second test in the suite has `feedback.length === 2` instead of 1.

### Pitfall 3: posttool B-4 Violation
**What goes wrong:** Making `posttool()` awaitable breaks the B-4 invariant (posttool must never block the orchestrator).
**Why it happens:** Awaiting posttool in a hot path adds latency.
**How to avoid:** Await is only in the PostToolUse branch of the orchestrator, which already awaits `fireHook`. The hook is not on the model response streaming hot path — it fires after tool-result is processed. B-4 applies to the EE client methods (they remain fire-and-forget at the HTTP layer); posttool() returning Promise<void> that resolves when the fetch *starts* (not when server responds) is acceptable.
**Warning signs:** Measurable latency regression in tool-call throughput. Monitor with existing vitest perf tests if present.

### Pitfall 4: Race Condition Still Present After Fix
**What goes wrong:** routeFeedback fires before posttool HTTP lands despite code change.
**Why it happens:** `void this.fireHook(postInput)` in orchestrator.ts line 2300 — removing `void` and adding `await` is required. If only posttool.ts is changed but the orchestrator still `void`-casts, posttool is still not awaited.
**How to avoid:** Change `void this.fireHook(postInput).catch(() => {})` to `await this.fireHook(postInput).catch(() => {})` in the tool-result handler.
**Warning signs:** Integration test ordering assertion fails intermittently under CI load.

### Pitfall 5: Stub Endpoint Not Registered for /api/posttool
**What goes wrong:** `startStubEEServer({})` with no `posttool` handler still records calls in `stub.calls.posttool` — but the HTTP response is a 404, causing `client.posttool()` to silently fail.
**Why it happens:** `stub.calls.posttool` is populated before the handler check. The response is still 200 text/plain "ok" from the catch-all text handler — actually this IS handled in ee-server.ts (line 114-119 sends "ok" unconditionally).
**How to avoid:** Confirm by reading ee-server.ts: posttool endpoint always returns 200. No config callback needed for basic recording.
**Warning signs:** N/A — posttool always 200 in stub.

---

## Code Examples

Verified patterns from actual codebase:

### Stub server with all 5 endpoints (from touch.test.ts + intercept.test.ts patterns)
```typescript
// Source: src/__test-stubs__/ee-server.ts + src/ee/touch.test.ts
stub = await startStubEEServer({
  intercept: () => ({
    decision: "allow",
    matches: [{ principle_uuid: "P1", confidence: 0.9, why: "w", message: "m",
                embedding_model_version: "v1", scope_label: "global",
                last_matched_at: new Date().toISOString() }],
  }),
});
// stub.calls.intercept, .posttool, .feedback, .touch are all pre-initialized []
```

### Settle fire-and-forget (from touch.test.ts)
```typescript
// Source: src/ee/touch.test.ts lines 31, 42
await new Promise((r) => setTimeout(r, 50));
expect(stub.calls.touch.length).toBe(1);
```

### EE client state reset (from intercept.test.ts)
```typescript
// Source: src/ee/intercept.test.ts
import { resetEEClientState } from "./client.js";
beforeEach(() => { resetEEClientState(); });
```

### posttool with judgeCtx (from posttool.test.ts)
```typescript
// Source: src/ee/posttool.test.ts lines 41-58
const ctx: JudgeContext = {
  warningResponse: { decision: "allow", matches: [] },
  toolName: "bash",
  outcome: { success: true, durationMs: 10 },
  cwdMatchedAtPretool: true,
  diffPresent: false,
  tenantId: "local",
};
posttool(mockPayload, ctx);
expect(mockFF).toHaveBeenCalledOnce();
```

### Module-level cached state pattern (from hooks/index.ts)
```typescript
// Source: src/hooks/index.ts line 49
let _cachedScope: Scope | null = null;
// Same pattern applies for _lastWarningResponse
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Shell-spawn hook executor | HTTP EE client dispatch | Phase 0.06 | Cross-platform (Windows), no WSL dependency |
| judgeCtx undefined (gap) | judgeCtx threaded from PreToolUse | Phase 7 (this phase) | Enables auto-judge Feedback+Touch |
| posttool fire-and-forget (race) | posttool awaited before routeFeedback | Phase 7 (this phase) | Eliminates ordering race documented in STATE.md |

---

## Open Questions

1. **diffPresent detection**
   - What we know: `JudgeContext.diffPresent` must be `true` when the tool made a file edit. Currently always `false` in the PostToolUse handler (no diff computation).
   - What's unclear: Should Phase 7 implement real diff detection, or accept `diffPresent: false` as a conservative default?
   - Recommendation: Use `diffPresent: false` as conservative default for Phase 7. With `diffPresent: false`, the `should-not-edit` rule never triggers, so IGNORED classification is only reached via `outcome.success = false`. This is safe — the success criterion does not require exact diffPresent computation, only that auto-judge classifies without agent intervention.

2. **cwdMatchedAtPretool detection**
   - What we know: `JudgeContext.cwdMatchedAtPretool` indicates whether the PreToolUse scope matched the current cwd. Currently `_lastWarningResponse !== null` is used as a proxy.
   - What's unclear: Whether scope mismatch (different cwd between Pre and Post) is a real concern in Phase 7.
   - Recommendation: Use `_lastWarningResponse !== null` as the cwdMatchedAtPretool flag. This is conservative and sufficient for Phase 7 validation.

---

## Environment Availability

Step 2.6: No new external dependencies identified. All tools (vitest, Node http, startStubEEServer) are already installed and verified through existing tests.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| vitest | Integration tests | Yes | in package.json | — |
| Node http | ee-server.ts stub | Yes | Node 20+ | — |
| startStubEEServer | Pipeline integration test | Yes | src/__test-stubs__/ee-server.ts | — |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (vitest.config.ts) |
| Config file | vitest.config.ts |
| Quick run command | `bunx vitest run src/ee` |
| Full suite command | `bunx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ROUTE-12 | All 5 events fire in order for one tool invocation | integration | `bunx vitest run src/ee/__tests__/pipeline.integration.test.ts` | No — Wave 0 |
| ROUTE-12 | Auto-judge tags FOLLOWED/IGNORED/IRRELEVANT (no agent) | unit | `bunx vitest run src/ee/judge.test.ts` | Yes |
| ROUTE-12 | posttool awaited before routeFeedback (race prevention) | integration | `bunx vitest run src/ee/__tests__/pipeline.integration.test.ts` | No — Wave 0 |

### Sampling Rate
- **Per task commit:** `bunx vitest run src/ee`
- **Per wave merge:** `bunx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/ee/__tests__/pipeline.integration.test.ts` — covers ROUTE-12 end-to-end (all 5 events)
- [ ] `src/ee/__tests__/` directory — does not yet exist

---

## Sources

### Primary (HIGH confidence)
- Direct source code inspection: `src/ee/bridge.ts`, `src/ee/intercept.ts`, `src/ee/posttool.ts`, `src/ee/judge.ts`, `src/ee/client.ts`, `src/hooks/index.ts`, `src/__test-stubs__/ee-server.ts`
- Existing test files: `src/ee/judge.test.ts`, `src/ee/posttool.test.ts`, `src/ee/touch.test.ts`, `src/ee/intercept.test.ts`
- `src/orchestrator/orchestrator.ts` lines 2231-2500 — hook fire sites and routeFeedback callsites

### Secondary (MEDIUM confidence)
- Orchestrator comment at line 2428: "Must come AFTER posttool calls (posttool fires during tool-result processing above)" — confirms developer intent for ordering
- STATE.md accumulated decisions: "posttool() must be awaited before routeFeedback fires — ordering race documented"

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries directly verified in package.json and test files
- Architecture (gaps): HIGH — confirmed by direct code inspection of hooks/index.ts and orchestrator.ts
- Integration test pattern: HIGH — directly modeled on existing touch.test.ts + intercept.test.ts patterns
- Race condition fix: HIGH — pattern is straightforward async/await; confirmed by orchestrator line 2300

**Research date:** 2026-05-01
**Valid until:** 2026-06-01 (stable internal codebase, no external dependencies)
