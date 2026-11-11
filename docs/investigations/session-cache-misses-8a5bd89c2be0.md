# Cache misses in session 8a5bd89c2be0

Read-only usage snapshot: max event 6653, cutoff 2026-11-02T07:15:04.043Z.
Main message calls grouped by `message_seq`: first calls read 41.88% from cache
(14/30 zero reads); follow-ups read 62.43% (27/128 zero reads). These are parent
session usage rows, not an attribution of detached worker billing.

Prepared call `d1738793-830f-4de9-b091-a31703e327e1` had 329,169 history
characters at step 0 and 83,994 at step 1. The local B4 compactor projects a
smaller request without changing canonical history; that view previously lived
only within one SDK invocation. The next user turn started from full history
and could pay for another full request before compaction consultation finished.

The actual SDK mock regression `cross-turn-request-history.test.ts` reproduces
the defect: request 258,478 characters, compacted request 23,963, next turn
259,343 before the fix. After the fix the next turn is 24,388 characters; 25
historical provider-message entries match the compacted prefix exactly. These
are serialized request character counts, not billed tokens or cache-hit rates.

`RequestHistory` retains one transient, Agent-owned view from an actual
compactor pass. It excludes the current user message and generated response
tail, and validates the complete canonical prefix before reuse. Owner, cwd,
model, static prompt, permission, sandbox, focus and compaction settings bind
the view. Changed inputs invalidate it. Explicit preservation/pins restore the
original history; an unknown restoration boundary refuses instead of guessing.
Active WorkingContext projection and the Claude path retain their own behavior.
Media URLs/binary content, tool pairs and original transcript evidence remain
available. The snapshot is not persisted across process restarts.

Prepared-request numeric metadata includes `requestHistoryReusedChars` (zero
when not reused or explicitly restored); no prompt text is copied into it.
Forensics treats post-hit zero reads as an observation, without assigning
provider latency or asserting unchanged prefixes from usage counters alone.

The expanded regression also exposed a local overflow count `50429` being
matched as status `429`, causing unnecessary retries and a false provider-rate
hint. Local unsent-request overflows now remain non-transient; actual HTTP429
handling is preserved. Six token-count controls reproduced this before repair.

Verification artifacts are under
`.quick-codex-flow/sessions/01a19a34-2b32-7d10-b985-5f867afcc7e5/`:
`cache-misses-evidence.json`, `cache-sdk-measurement.json`, and cache history
test/build logs. No paid-provider replay, live-session restart or post-fix
provider cache improvement is claimed. Existing processes must reopen to load
the rebuilt code; the first request in a fresh process has no prior view.

Final verification:172 tests/15 files passed, build/typecheck passed, native
smoke-boot1/1 passed (1bfc19c5-fbde-4a16-a7a5-d0526dad523a).
