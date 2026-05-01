# Phase 8: Session End Extraction - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-01
**Phase:** 08-session-end-extraction
**Areas discussed:** Transcript compaction strategy, Shutdown timing & fire model, Message counting & threshold, Extraction trigger points, Offline queue awareness, User visibility

---

## Transcript Compaction Strategy

### Q1: How should the session transcript be compacted before sending to EE /api/extract?

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse existing compaction pipeline | Use src/flow/compaction/ (same logic as context window compaction). Produces a condensed text summary. Already tested and proven. | |
| Raw messages array as JSON | Send this.messages directly as JSON string. No compaction — let EE server-side handle summarization. Simpler but larger payload. | |
| Custom lightweight extract | Build a purpose-built extractor: strip tool results/system messages, keep only user+assistant text content. | |
| You decide | Claude picks the best approach based on codebase patterns and constraints. | ✓ |

**User's choice:** You decide
**Claude's recommendation:** Reuse existing compaction pipeline — already tested and consistent with codebase patterns.

### Q2: Should the compacted transcript include tool call details?

| Option | Description | Selected |
|--------|-------------|----------|
| Conversational only | User messages + assistant text responses. Tool calls stripped entirely. | |
| Tool names + outcomes | Include tool names and whether they succeeded/failed, but strip full parameters and raw output. | |
| You decide | Claude picks based on what EE extract endpoint needs for learning. | ✓ |

**User's choice:** You decide
**Claude's recommendation:** Tool names + outcomes — balance of learning context and payload size.

---

## Shutdown Timing & Fire Model

### Q3: How should the extract call fit into the 2s shutdown budget?

| Option | Description | Selected |
|--------|-------------|----------|
| Fire-and-forget, no await | Send the HTTP request and immediately continue cleanup. Extract may or may not complete before process.exit(). | ✓ (initial) |
| Await with 2s AbortSignal | await client.extract() with AbortSignal.timeout(2000). Guarantees 2s max wait. | |
| Race: extract vs 2s timer | Promise.race([extract(), sleep(2000)]). | |
| You decide | Claude picks based on Node.js process exit semantics and reliability tradeoffs. | |

**User's initial choice:** Fire-and-forget, no await
**Claude's override recommendation:** Await with 2s AbortSignal — fire-and-forget with process.exit(0) kills pending HTTP requests. User accepted override.

### Q4: Grace period before process.exit()?

| Option | Description | Selected |
|--------|-------------|----------|
| No grace period | Trust Node.js event loop. Zero delay on shutdown. | ✓ |
| Minimal grace (500ms) | setTimeout 500ms before process.exit(). | |
| You decide | Claude picks based on Node.js process.exit() behavior. | |

**User's choice:** No grace period
**Notes:** Moot point after accepting the AbortSignal.timeout(2000) recommendation — extract runs within cleanup() which is awaited.

---

## Message Counting & Threshold

### Q5: How should the '5 messages' threshold be counted?

| Option | Description | Selected |
|--------|-------------|----------|
| User messages only | Count messages where role='user'. 5 user prompts = meaningful session. | |
| User + assistant turns | Count conversation turns. 5 turns = meaningful back-and-forth. | |
| All messages | Count this.messages.length total. Simple but inflated by tool calls. | |
| You decide | Claude picks the most sensible counting method. | ✓ |

**User's choice:** You decide
**Claude's recommendation:** User messages only — most meaningful metric, not inflated by tool calls.

### Q6: Resumed sessions — include previous messages in count?

| Option | Description | Selected |
|--------|-------------|----------|
| Total messages (include resumed) | Count all messages in the transcript. 3 old + 3 new = 6 total, triggers extraction. | ✓ |
| New messages only | Only count messages added since this session started. | |
| You decide | Claude picks based on what makes sense for the EE learning model. | |

**User's choice:** Total messages (include resumed)

---

## Extraction Trigger Points

### Q7: Which exit points should trigger session extraction?

| Option | Description | Selected |
|--------|-------------|----------|
| Normal quit (cli-exit) | User types /exit, Ctrl+D, or the TUI exit flow. | ✓ |
| SIGINT / Ctrl+C (cli-exit) | User hits Ctrl+C to abort. | ✓ |
| Headless --print exit | Single-shot headless mode. | ✓ |
| /clear command (cli-clear) | User clears conversation. | ✓ |

**User's choice:** All 4 trigger points

### Q8: /clear command — extraction scope reset?

| Option | Description | Selected |
|--------|-------------|----------|
| Clear resets extraction scope | Extract on clear covers messages so far. Next extract only covers messages after clear. | |
| Always extract full session on exit | Clear triggers extraction, exit also re-extracts everything. EE deduplicates. | |
| You decide | Claude picks based on implementation simplicity. | ✓ |

**User's choice:** You decide
**Claude's recommendation:** Clear resets extraction scope — prevents duplicate extraction.

---

## Offline Queue Awareness

### Q9: Pre-wire offline queue or fail silently?

| Option | Description | Selected |
|--------|-------------|----------|
| Fail silently, Phase 09 retrofits | Keep Phase 08 simple. Phase 09 wraps EE client with queue logic later. | |
| Pre-wire queue interface | Phase 08 calls through abstraction that Phase 09 can replace. | |
| You decide | Claude picks based on Phase 09 roadmap scope. | ✓ |

**User's choice:** You decide (gave Claude full discretion for all remaining decisions)
**Claude's recommendation:** Fail silently, Phase 09 retrofits — clean separation of concerns.

---

## User Visibility

**Claude's recommendation:** Silent extraction — zero UI, debug logging only. User accepted.

---

## Claude's Discretion

- Transcript compaction implementation details
- Content scope of compacted transcript
- Message counting method (recommended: user messages only)
- Clear scope reset implementation
- Offline queue awareness (recommended: fail silently)
- User visibility (recommended: silent/debug only)
- Internal file structure (new file vs inline)
- Testing approach

## Deferred Ideas

None — discussion stayed within phase scope.
