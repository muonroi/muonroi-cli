# Phase 8: Session End Extraction - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

CLI automatically sends a compacted session transcript to EE `/api/extract` when a session ends, so the EE brain learns from every meaningful CLI session without user intervention. This phase wires the extraction call into all exit paths and enforces the 5-message threshold and 2s shutdown budget.

</domain>

<decisions>
## Implementation Decisions

### Transcript Compaction Strategy
- **D-01:** Reuse existing compaction pipeline (`src/flow/compaction/`) to produce the transcript string. Already tested and proven for context window compaction — same logic applies to extraction payloads.
- **D-02:** Include tool names and success/failure outcomes in the compacted transcript, but strip full parameters and raw output. Balance of learning context and payload size.

### Shutdown Timing & Fire Model
- **D-03:** Extract call runs inside `Agent.cleanup()` using `Promise.allSettled` alongside existing bash/LSP cleanup. NOT fire-and-forget — `process.exit(0)` kills pending HTTP requests, so extract must complete within the await window.
- **D-04:** Extract call uses `AbortSignal.timeout(2000)` to enforce the 2s budget. Total shutdown time = `max(current_cleanup_time, 2s)`.
- **D-05:** If extract fails (timeout, network error, EE down), swallow the error silently. No retry, no queue (Phase 09 handles offline queue).

### Message Counting & Threshold
- **D-06:** Count user messages only (`role === 'user'`). 5 user messages = meaningful session. Ignores tool results, system messages, and assistant responses which inflate raw count.
- **D-07:** For resumed sessions, count total messages including those from the previous session. A resumed session with 3 old + 3 new user messages = 6 total, triggers extraction.

### Extraction Trigger Points
- **D-08:** All 4 exit points trigger extraction:
  - Normal quit (Ctrl+D, /exit, TUI exit) — `meta.source = 'cli-exit'`
  - SIGINT / Ctrl+C — `meta.source = 'cli-exit'`
  - Headless `--print` mode exit — `meta.source = 'cli-exit'`
  - `/clear` command — `meta.source = 'cli-clear'`
- **D-09:** `/clear` resets extraction scope. Extract on clear covers messages accumulated so far. Subsequent exit extract only covers messages after the clear. Prevents duplicate extraction to EE.

### Offline Queue Awareness
- **D-10:** Phase 08 does NOT pre-wire offline queue. Failed extracts are silently swallowed. Phase 09 will retrofit the EE client with queue-backed logic.

### User Visibility
- **D-11:** Extraction is completely silent to the user. No UI indication, no status bar message. Debug logging only (for developer troubleshooting).

### Claude's Discretion
- Internal implementation of the compaction-for-extract function (may use compress.ts or extract.ts from compaction module)
- How to track "messages since last clear" for the extraction scope reset
- Whether to create a dedicated `src/ee/extract-session.ts` or inline in existing files
- Testing approach (unit tests with mocked EE client, integration test for cleanup pipeline)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### EE Client & Types
- `src/ee/client.ts` — EE HTTP client, `extract()` method already exists (line ~340), uses 10s timeout (needs 2s override)
- `src/ee/types.ts` — `ExtractRequest`, `ExtractResponse` types (line ~151), `meta.source` enum
- `src/ee/intercept.ts` — `getDefaultEEClient()` singleton pattern

### Session Lifecycle
- `src/index.ts` — `onExit` callback, SIGINT handler, `agent.cleanup()` call chain (lines ~91-141)
- `src/orchestrator/orchestrator.ts` — `Agent.cleanup()` method (line ~992), `this.messages` array (line ~784)

### Compaction Pipeline
- `src/flow/compaction/compress.ts` — Compaction logic for context window
- `src/flow/compaction/extract.ts` — Extraction-specific compaction
- `src/flow/compaction/index.ts` — Pipeline entry point

### EE Pipeline (Prior Phases)
- `src/ee/posttool.ts` — Fire-and-forget pattern example
- `src/ee/judge.ts` — Auto-judge using `getDefaultEEClient()` pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `client.extract(req)` — Already implemented in `src/ee/client.ts`, sends POST to `/api/extract`. Currently uses 10s timeout, needs 2s override for shutdown path.
- `ExtractRequest` type — Already defined: `{ transcript: string, projectPath: string, meta?: { sessionId, tenantId, source } }`
- `src/flow/compaction/` — Full compaction pipeline for producing condensed text from messages array
- `getDefaultEEClient()` — Singleton accessor in `src/ee/intercept.ts`

### Established Patterns
- Fire-and-forget for non-critical EE calls (posttool, feedback, touch)
- `Promise.allSettled` for cleanup tasks that shouldn't block each other
- `AbortSignal.timeout()` for EE call timeouts
- `shutdownWorkspaceLspManager` cleanup pattern in Agent.cleanup()

### Integration Points
- `Agent.cleanup()` in orchestrator.ts — Add extract call here alongside bash/LSP cleanup
- `onExit` in index.ts — Already awaits `agent.cleanup()` before `process.exit(0)`
- SIGINT handler in index.ts — Already wired, triggers `orchestratorAbort.abort("SIGINT")` then onExit
- Headless mode exit in index.ts — `finally { await agent.cleanup() }` block

</code_context>

<specifics>
## Specific Ideas

No specific requirements — standard EE integration pattern following established conventions from Phases 05-07.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 08-session-end-extraction*
*Context gathered: 2026-05-01*
