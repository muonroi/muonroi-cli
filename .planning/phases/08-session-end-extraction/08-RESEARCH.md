# Phase 08: Session End Extraction - Research

**Researched:** 2026-05-01
**Domain:** TypeScript / Node.js process lifecycle, HTTP client timeout control, message compaction for EE extraction
**Confidence:** HIGH

## Summary

This phase wires a session-end extraction call into all exit paths of the CLI. When a session ends (quit, SIGINT, `/clear`, headless exit), the CLI compacts the session transcript and sends it to EE `/api/extract` so the EE brain can learn from the session. The entire extraction pipeline — including the EE client method, the `ExtractRequest`/`ExtractResponse` types, the compaction helpers, and the `Promise.allSettled` cleanup pattern — already exists in the codebase. This phase is almost entirely integration and wiring work, with very little new code to write.

The primary technical risk is the 2-second shutdown budget. The existing `client.extract()` uses a hard-coded 10-second `AbortSignal.timeout`, which must be overridden to 2 seconds at the call site (the client method's signal is set inline — override by creating a new `AbortSignal.timeout(2000)` and passing a custom fetch wrapper, or better: accept an optional `signal` override via the call). The `/clear` scope-reset path adds a secondary tracking concern: a `_lastClearIndex` must be maintained on `Agent` so the post-clear extraction only covers messages after the clear.

**Primary recommendation:** Add `extractSession()` to a new `src/ee/extract-session.ts`, call it from `Agent.cleanup()` inside `Promise.allSettled`, and track `_messagesSinceLastClear` on `Agent` to handle the `/clear` scope boundary.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Reuse existing compaction pipeline (`src/flow/compaction/`) to produce the transcript string.
- **D-02:** Include tool names and success/failure outcomes; strip full parameters and raw output.
- **D-03:** Extract call runs inside `Agent.cleanup()` using `Promise.allSettled` alongside bash/LSP cleanup. NOT fire-and-forget.
- **D-04:** Extract call uses `AbortSignal.timeout(2000)`. Total shutdown = `max(current_cleanup_time, 2s)`.
- **D-05:** If extract fails (timeout, network error, EE down) — swallow error silently. No retry, no queue.
- **D-06:** Count user messages only (`role === 'user'`). 5 user messages = meaningful session.
- **D-07:** Resumed sessions: count total messages including prior session messages.
- **D-08:** All 4 exit points trigger extraction: normal quit, SIGINT, headless `--print` exit, `/clear`.
  - `meta.source = 'cli-exit'` for quit/SIGINT/headless
  - `meta.source = 'cli-clear'` for `/clear`
- **D-09:** `/clear` resets extraction scope. Extract on clear covers messages so far; subsequent exit extract covers only messages after the clear.
- **D-10:** Phase 08 does NOT pre-wire offline queue. Failed extracts silently swallowed.
- **D-11:** Extraction is completely silent to the user. Debug logging only.

### Claude's Discretion

- Internal implementation of the compaction-for-extract function (compress.ts or extract.ts from compaction module)
- How to track "messages since last clear" for the extraction scope reset
- Whether to create a dedicated `src/ee/extract-session.ts` or inline in existing files
- Testing approach (unit tests with mocked EE client, integration test for cleanup pipeline)

### Deferred Ideas (OUT OF SCOPE)

- None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EXTRACT-01 | CLI calls /api/extract with session transcript when session ends (cleanup/SIGINT) | `client.extract()` already exists at line ~340 of `src/ee/client.ts`. Wire into `Agent.cleanup()` at line ~992 of orchestrator.ts. All 4 exit paths (onExit, SIGINT, headless finally, clearHistory) already invoke cleanup. |
| EXTRACT-02 | Transcript is compacted before sending (reuse existing compaction logic) | `serializeConversation()` in `src/orchestrator/compaction.ts` serializes ModelMessage[]. `compressChat()` in `src/flow/compaction/compress.ts` can compress within a token budget. For extraction payloads, a lighter-weight serialize-then-strip approach matches D-02. |
| EXTRACT-03 | Extraction is fire-and-forget — does not block CLI shutdown beyond 2s | `AbortSignal.timeout(2000)` pattern confirmed in codebase (e.g., `promptStale` at line ~330 of client.ts already uses 2s). Override the 10s default on the `extract()` call site. `Promise.allSettled` ensures cleanup tasks run in parallel. |
| EXTRACT-04 | Extraction skipped if session < 5 messages (no meaningful content) | Count `messages.filter(m => m.role === 'user').length` before calling. D-06/D-07 locked. For resumed sessions, `this.messages` already contains the full transcript including prior session messages (loaded in orchestrator constructor at line ~783). |
</phase_requirements>

---

## Standard Stack

### Core (all already in codebase — no new installs needed)

| Asset | Location | Purpose | Status |
|-------|----------|---------|--------|
| `client.extract()` | `src/ee/client.ts` line ~340 | POST to `/api/extract`, returns `ExtractResponse \| null` | Exists, timeout needs 2s override |
| `ExtractRequest` / `ExtractResponse` | `src/ee/types.ts` line ~151 | Typed payload: `{ transcript, projectPath, meta? }` | Exists, complete |
| `getDefaultEEClient()` | `src/ee/intercept.ts` line ~35 | Singleton EE client accessor | Exists, standard pattern |
| `serializeConversation()` | `src/orchestrator/compaction.ts` | Converts `ModelMessage[]` to text string | Exists |
| `compressChat()` | `src/flow/compaction/compress.ts` | Compresses serialized text within token budget | Exists |
| `extractDecisions()` | `src/flow/compaction/extract.ts` | Regex-based decision/fact/constraint extraction | Exists, optional use |
| `Promise.allSettled` | Native Node.js | Parallel cleanup without mutual cancellation | Used in `Agent.cleanup()` already |
| `AbortSignal.timeout(2000)` | Native Node.js | Hard deadline on HTTP call | Already used in `promptStale` client method |
| `startStubEEServer()` | `src/__test-stubs__/ee-server.ts` | HTTP stub for EE integration tests | Exists, missing `/api/extract` route — needs addition |

### No New Dependencies Required

This phase installs nothing new. All required pieces exist.

---

## Architecture Patterns

### Recommended File Structure

```
src/
├── ee/
│   ├── extract-session.ts    # NEW: compaction + threshold check + extract call
│   ├── client.ts             # MODIFY: change extract() timeout to accept override
│   ├── intercept.ts          # no change
│   └── posttool.ts           # reference pattern only
├── orchestrator/
│   └── orchestrator.ts       # MODIFY: cleanup(), clearHistory()/startNewSession()
└── __test-stubs__/
    └── ee-server.ts          # MODIFY: add /api/extract route handler
```

### Pattern 1: Extract-Session Module (`src/ee/extract-session.ts`)

**What:** Thin module that takes `messages: ModelMessage[]`, checks threshold, compacts, and calls `getDefaultEEClient().extract()`.
**When to use:** Called from `Agent.cleanup()` and from the clear path.

```typescript
// Pseudocode pattern — mirrors posttool.ts simplicity
export async function extractSession(
  messages: ModelMessage[],
  projectPath: string,
  source: "cli-exit" | "cli-clear",
  sessionId?: string | null,
): Promise<void> {
  // D-06: count user messages only
  const userMsgCount = messages.filter((m) => m.role === "user").length;
  if (userMsgCount < 5) return; // D-04 / EXTRACT-04

  // D-02: serialize + strip (use serializeConversation, then strip full tool output)
  const transcript = buildExtractTranscript(messages);

  // D-04: 2s hard deadline
  await getDefaultEEClient().extract(
    { transcript, projectPath, meta: { source, sessionId: sessionId ?? undefined } },
    AbortSignal.timeout(2000), // override client default
  );
  // D-05: errors swallowed by client (returns null on failure)
}
```

### Pattern 2: Integrating into `Agent.cleanup()`

**What:** Add `extractSession()` call to the `Promise.allSettled` array in `cleanup()`.
**Reference:** `Agent.cleanup()` at orchestrator.ts line ~992.

```typescript
// BEFORE (line ~992):
async cleanup(): Promise<void> {
  await Promise.allSettled([this.bash.cleanup(), shutdownWorkspaceLspManager(this.bash.getCwd())]);
}

// AFTER:
async cleanup(): Promise<void> {
  await Promise.allSettled([
    this.bash.cleanup(),
    shutdownWorkspaceLspManager(this.bash.getCwd()),
    extractSession(this.messages, this.bash.getCwd(), "cli-exit", this.getSessionId()),
  ]);
}
```

### Pattern 3: Scope Reset on `/clear`

**What:** `clearHistory()` calls `startNewSession()`, which resets `this.messages = []`. The extraction for "messages so far" must happen BEFORE `this.messages` is reset.
**Reference:** `clearHistory()` / `startNewSession()` at orchestrator.ts line ~1011.

```typescript
// BEFORE startNewSession() resets this.messages:
async clearHistory(): Promise<void> {
  // Extract for current scope BEFORE reset (D-09)
  await extractSession(this.messages, this.bash.getCwd(), "cli-clear", this.getSessionId())
    .catch(() => {}); // D-05: silent failure
  this.startNewSession(); // resets this.messages
}
```

Note: `clearHistory()` is currently synchronous. Making it `async` is required for the await. Check callers.

### Pattern 4: Compaction for Extraction (D-02)

**What:** Produce a transcript that includes tool names and outcomes, strips full parameters and raw output.
**Recommendation:** Use `serializeConversation(messages)` as a base (already strips binary content), then apply a regex pass to truncate tool result content beyond N characters. This avoids running the full 2-pass compaction pipeline (which is designed for context window, not payloads).

```typescript
// Lightweight approach — no LLM call, no file I/O
function buildExtractTranscript(messages: ModelMessage[]): string {
  const serialized = serializeConversation(messages);
  // Truncate tool result bodies > 500 chars while keeping tool name + status
  return serialized.replace(
    /(Tool: \w+[\s\S]{0,200}?\n)([\s\S]{500,}?)(\n(?:Tool:|User:|Assistant:))/g,
    "$1[... output truncated]\n$3",
  );
}
```

### Anti-Patterns to Avoid

- **Fire-and-forget with `void`:** D-03 explicitly forbids this. `process.exit(0)` kills pending microtasks. Must be inside `Promise.allSettled` await window.
- **Using the full `deliberateCompact()` pipeline for extraction:** It does file I/O, LLM calls, and history snapshots — far too heavy for a shutdown path. Use lightweight `serializeConversation()` + truncation only.
- **Relying on 10s client timeout:** The existing `extract()` method uses `AbortSignal.timeout(10_000)`. This must be overridden to 2s at the call site (via client method signature change or wrapper).
- **Extracting after `this.messages = []`:** The clear path resets messages. Extraction must happen before `startNewSession()` is called.
- **Counting all messages:** D-06 requires `role === 'user'` filter only. Tool results and assistant responses inflate the raw count.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Serializing messages to text | Custom serializer | `serializeConversation()` from `src/orchestrator/compaction.ts` | Already handles tool_result truncation, reasoning blocks, multi-content arrays |
| HTTP request with timeout | `setTimeout` + Promise race | `AbortSignal.timeout(2000)` (native Node 18+, already used in codebase) | Built-in abort signal, composable, no extra cleanup needed |
| EE client singleton | Create new client per call | `getDefaultEEClient()` | Circuit breaker, auth token cache, retry logic already wired |
| HTTP stub for tests | Mock `fetch` globally | `startStubEEServer()` in `src/__test-stubs__/ee-server.ts` | Already exists, real HTTP server, avoids module mock contamination |

---

## Common Pitfalls

### Pitfall 1: `clearHistory()` is synchronous — callers may not handle async

**What goes wrong:** `clearHistory()` currently returns `void` (synchronous). Making it `async` changes its signature. Callers in the UI (TUI /clear command handler) that call `agent.clearHistory()` without `await` will silently drop the extraction promise.

**Why it happens:** TypeScript allows calling an `async` function without `await` — no compiler error, but the promise floats and dies when `process.exit` fires.

**How to avoid:** Audit all callers of `clearHistory()` (grep: `clearHistory`). Make them `await` the call. If any caller is in a synchronous context (e.g., a UI event handler), wrap in `void` explicitly with `.catch(() => {})` to satisfy lint.

**Warning signs:** `clearHistory` callers in TUI not updated; extraction on clear silently never fires.

### Pitfall 2: Client `extract()` 10s timeout overruns 2s budget

**What goes wrong:** The existing `extract()` method signature uses `AbortSignal.timeout(10_000)` internally. If EE is slow but eventually responds (e.g., 5s), the `Promise.allSettled` will wait the full 10s, holding up `process.exit(0)`.

**Why it happens:** The timeout is baked into the method body, not a parameter.

**How to avoid:** Either (a) add an optional `signal?: AbortSignal` parameter to `extract()` in `client.ts` and pass `AbortSignal.timeout(2000)` from the call site, or (b) wrap the entire `extractSession()` call in `Promise.race([extractPromise, delay(2000)])`. Option (a) is cleaner and consistent with how other client methods may evolve.

**Warning signs:** Shutdown takes >2s under slow/degraded EE; test with `latencyMs: 3000` in stub server.

### Pitfall 3: Stub server missing `/api/extract` route

**What goes wrong:** `startStubEEServer()` in `src/__test-stubs__/ee-server.ts` has no handler for `/api/extract`. Integration tests that use the stub will get 404 responses and the test will succeed (because errors are swallowed) but the extraction will not actually be verified.

**Why it happens:** The stub was built for earlier phases and doesn't include the extract endpoint.

**How to avoid:** Add an `extract?: (req: any) => any` handler to `StubConfig` and the corresponding `if (url.pathname === '/api/extract')` branch in the server. Track `calls.extract`.

**Warning signs:** Integration test passes but `stub.calls.extract` is empty/undefined.

### Pitfall 4: Resumed session message count under-counts

**What goes wrong:** For a resumed session, `this.messages` is loaded from `loadTranscriptState(this.session.id)` in the constructor (orchestrator.ts line ~783-784). If message counting is done on a snapshot taken BEFORE constructor finishes, the count is 0.

**Why it happens:** Extraction called before session transcript is loaded.

**How to avoid:** `extractSession()` is called from `cleanup()`, which runs at session END, long after construction. `this.messages` at cleanup time already includes the full resumed transcript. This is not an issue as long as extraction is only triggered from cleanup/clearHistory — not from a pre-session hook.

**Warning signs:** Resumed sessions with >5 messages skipped due to count = 0.

### Pitfall 5: `meta.source` enum mismatch

**What goes wrong:** `ExtractRequest.meta.source` is typed as `"cli-exit" | "cli-clear" | "hook-stop"` in `src/ee/types.ts`. Passing a different string literal causes a TypeScript compile error.

**How to avoid:** Use the enum values from `src/ee/types.ts` exactly. D-08 maps: quit/SIGINT/headless → `"cli-exit"`, clear → `"cli-clear"`.

---

## Code Examples

### Verified: `extract()` client method (client.ts ~line 340)
```typescript
async extract(req: ExtractRequest): Promise<ExtractResponse | null> {
  try {
    const resp = await f(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(10_000), // <-- MUST override to 2000ms
    });
    if (!resp.ok) return null;
    return (await resp.json()) as ExtractResponse;
  } catch {
    return null;
  }
}
```

### Verified: `ExtractRequest` type (types.ts ~line 152)
```typescript
export interface ExtractRequest {
  transcript: string;
  projectPath: string;
  meta?: {
    sessionId?: string;
    tenantId?: string;
    source?: "cli-exit" | "cli-clear" | "hook-stop";
  };
}
```

### Verified: `Agent.cleanup()` current shape (orchestrator.ts ~line 992)
```typescript
async cleanup(): Promise<void> {
  await Promise.allSettled([this.bash.cleanup(), shutdownWorkspaceLspManager(this.bash.getCwd())]);
}
```

### Verified: `onExit` in index.ts — awaits cleanup before exit (~line 137)
```typescript
const onExit = () => {
  void agent.cleanup().finally(() => {
    renderer.destroy();
    process.exit(0);
  });
};
```

### Verified: headless mode exit — uses `finally { await agent.cleanup() }` (~line 207)
```typescript
} finally {
  await agent.cleanup();
}
```

### Verified: SIGINT handler — triggers abort then lets onExit handle cleanup (~line 95)
```typescript
process.on("SIGINT", () => {
  orchestratorAbort.abort("SIGINT");
});
```

### Verified: `promptStale` client method — reference for 2s AbortSignal pattern (~line 324)
```typescript
signal: AbortSignal.timeout(2000),
```

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies beyond EE server, which is already used by prior phases and handled as optional/fail-silent per D-05).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `bunx vitest run src/ee/extract-session.test.ts` |
| Full suite command | `bunx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EXTRACT-01 | `extractSession()` calls `/api/extract` on cleanup | integration | `bunx vitest run src/ee/__tests__/extract-session.integration.test.ts` | ❌ Wave 0 |
| EXTRACT-02 | Transcript is compacted/serialized before send | unit | `bunx vitest run src/ee/extract-session.test.ts` | ❌ Wave 0 |
| EXTRACT-03 | Extract resolves within 2s even with 3s stub latency | integration | `bunx vitest run src/ee/__tests__/extract-session.integration.test.ts` | ❌ Wave 0 |
| EXTRACT-04 | Sessions < 5 user messages do not fire extract | unit | `bunx vitest run src/ee/extract-session.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `bunx vitest run src/ee/extract-session.test.ts`
- **Per wave merge:** `bunx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/ee/extract-session.ts` — new module to create
- [ ] `src/ee/extract-session.test.ts` — unit tests for threshold check, compaction, error swallowing
- [ ] `src/ee/__tests__/extract-session.integration.test.ts` — integration test using stub server (add `/api/extract` to stub)
- [ ] `src/__test-stubs__/ee-server.ts` — add `extract` handler to `StubConfig` and request routing

---

## Open Questions

1. **`clearHistory()` caller audit**
   - What we know: `clearHistory()` exists in `orchestrator.ts`; callers in TUI app call it to handle `/clear` command
   - What's unclear: Exact locations of all callers and whether they are in async contexts
   - Recommendation: Grep `clearHistory` before implementing — if any caller is in a sync event handler, use `void extractSession(...).catch(()=>{}).then(() => this.startNewSession())` pattern to avoid blocking the UI event loop

2. **`extract()` method signature change scope**
   - What we know: The 10s timeout is baked into `extract()` in client.ts; changing the signature may affect other callers
   - What's unclear: Whether other callers of `extract()` exist in the codebase outside the client itself
   - Recommendation: Grep `\.extract(` — if no other callers, add optional `signal?: AbortSignal` param with backward-compatible default

---

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `src/ee/client.ts` — `extract()` method, timeout behavior confirmed
- Direct code inspection of `src/ee/types.ts` — `ExtractRequest`, `ExtractResponse`, `source` enum confirmed
- Direct code inspection of `src/ee/intercept.ts` — `getDefaultEEClient()` singleton pattern confirmed
- Direct code inspection of `src/orchestrator/orchestrator.ts` — `Agent.cleanup()`, `startNewSession()`, `this.messages` loading confirmed
- Direct code inspection of `src/index.ts` — `onExit`, SIGINT handler, headless `finally` block confirmed
- Direct code inspection of `src/flow/compaction/compress.ts` — `compressChat()` function signature confirmed
- Direct code inspection of `src/flow/compaction/extract.ts` — `extractDecisions()` function confirmed
- Direct code inspection of `src/flow/compaction/index.ts` — `deliberateCompact()` pipeline confirmed (too heavy for shutdown path)
- Direct code inspection of `src/__test-stubs__/ee-server.ts` — stub server routes; `/api/extract` missing confirmed
- Direct code inspection of `vitest.config.ts` — test configuration confirmed
- npm registry: vitest@4.1.5, Node.js v22.19.0

### Secondary (MEDIUM confidence)
- `AbortSignal.timeout()` behavior: Node.js 18+ built-in, already used in codebase in `promptStale` — confirmed via code pattern match

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all assets confirmed by direct code inspection, no external libraries needed
- Architecture: HIGH — integration points verified in actual source files; patterns follow existing posttool/judge/touch conventions exactly
- Pitfalls: HIGH — identified from direct code inspection (stub missing extract route, clearHistory synchronous, 10s timeout baked in)

**Research date:** 2026-05-01
**Valid until:** 2026-06-01 (stable internal codebase — not dependent on external library churn)
