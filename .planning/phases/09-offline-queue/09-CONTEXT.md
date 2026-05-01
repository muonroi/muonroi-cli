# Phase 09: Offline Queue - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning

<domain>
## Phase Boundary

No EE data is lost when the server is temporarily unreachable. The CLI buffers failed EE write operations (feedback, extract, prompt-stale) to a local disk queue and replays them automatically when the EE server recovers. The queue is transparent to the user and never blocks the CLI hot path.

</domain>

<decisions>
## Implementation Decisions

### Queue Storage & Format
- **D-01:** One JSON file per queue entry in `~/.muonroi-cli/ee-offline-queue/` directory. Atomic writes, easy to enumerate and delete.
- **D-02:** Timestamp-based filenames (`{Date.now()}-{random4}.json`) for natural FIFO ordering with no collisions.
- **D-03:** Each entry stores: original request body, endpoint path, and enqueue timestamp. Enough to replay any queued EE call.
- **D-04:** Cap enforcement on enqueue: if count >= 100, delete oldest file before writing new one. Simple FIFO, no background sweep.

### Replay Strategy
- **D-05:** Replay triggers on circuit breaker half-open probe success. The existing circuit breaker already detects EE recovery — piggyback replay on that signal. Zero extra timers.
- **D-06:** Sequential replay, one entry at a time. Prevents flooding a just-recovered EE server. Extract payloads can be heavy (Phase 08 context).
- **D-07:** If replay of an entry fails, leave it in queue and re-close the circuit. Entry survives for next half-open cycle. No infinite retry loop.
- **D-08:** Replay runs in background async (fire-and-forget). Never blocks CLI hot path per success criterion #5.

### EE Client Integration
- **D-09:** New `src/ee/offline-queue.ts` module. Clean separation from client.ts. Client calls `enqueue()` on failure, `drainQueue()` on circuit recovery.
- **D-10:** Only write operations get queued: feedback, extract, prompt-stale. Intercept (read) already short-circuits when EE is down — no value in queuing stale reads.
- **D-11:** Lazy init on first enqueue — create the queue directory only when needed. No overhead for users with stable EE.
- **D-12:** Hook into `recordCircuitSuccess()` in client.ts to trigger `drainQueue()`. Existing function already runs on EE recovery — add a single call.

### Claude's Discretion
- Internal error handling for filesystem operations (mkdir, readdir, writeFile, unlink)
- Whether to use fs/promises or synchronous fs for queue operations
- Test structure and mocking approach for the offline queue module
- Whether to add a debug log on enqueue/dequeue for developer troubleshooting

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/ee/client.ts` — EE HTTP client with circuit breaker pattern (lines 53-101), `recordCircuitSuccess()` is the recovery hook point
- Circuit breaker constants: 3 failures to open, 30s open duration, half-open probe
- `src/ee/types.ts` — All request/response types for EE endpoints
- `src/ee/intercept.ts` — `getDefaultEEClient()` singleton pattern

### Established Patterns
- EE client methods return `null` on failure with try/catch swallowing errors
- Rate-limited logging for unreachable state (`logUnreachable()`)
- AbortSignal.timeout for all HTTP calls
- Module-level state variables for circuit breaker (not class-based)

### Integration Points
- `recordCircuitSuccess()` in client.ts — wire `drainQueue()` call here
- `feedback()`, `extract()`, `promptStale()` catch blocks — add `enqueue()` on failure
- `~/.muonroi-cli/` directory — already used by CLI for config, extend with `ee-offline-queue/` subdirectory

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The queue is a straightforward file-based FIFO with circuit breaker integration.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
