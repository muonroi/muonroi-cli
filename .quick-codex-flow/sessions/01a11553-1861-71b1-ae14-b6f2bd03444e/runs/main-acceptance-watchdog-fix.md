# Main acceptance watchdog regression

## Resume Digest
- Goal: fix session 0a64c9560662 acceptance stall while retaining main ownership.
- Mode: auto, authorized local fixes; no commit/push.
- Gate: plan verified; execute bounded provider stream fix.
- Evidence: debug.log 2346 helper returned 01:21:45Z; 2347-2348 compaction proposer deadlines; 2349 main acceptance watchdog 01:27:00Z.
- Affected candidate surfaces: main acceptance entry, MessageProcessor preparation/streaming, compaction/provider awaits.
- Protected: unrelated WIP, main model ownership, bounded helper receipt, parent cancellation, independent helper DB.
- Trace: parent PIL ended 01:21:55; toolEngine setup ended and stream/accounting began 01:23:00; no persisted provider answer or tools before watchdog 01:27:00. Historical exact socket await is not instrumented.
- Reproducer: real Agent + MessageProcessor + AI SDK, scaled timers: slow / wedged / abort-ignored acceptance all failed with generic watchdog (acceptance-repro-before.log). sdk-stall-probe.mjs emits SDK start immediately, then still blocked 300ms after abort.
- Confirmed defects: SDK start is counted as provider activity and stops first-byte liveness; SDK abort does not guarantee pending stream iterator settles. Existing primitive-only tests missed actual SDK lifecycle events.
- Scope: tool-engine provider drain (main and routed helper sessions), existing llm-deadline utility, regression tests. No provider/model/settings defaults changed.
- Plan: ignore SDK start/start-step as provider byte; race pending next against existing combined abort using withDeadlineRace; always dispose timers; retain zero-output retry budget; persist stream stall/first-part breadcrumbs.
- Verification: real main handoff slow/retry/exhaustion/cancel and late ignored-abort output; relevant stream/deadline/watchdog tests; typecheck/build; compiled Node/Bun probes; native TUI QA.
- Plan check: no helper answer promoted to main; no replay after meaningful stream output; bounded existing provider timers, no new timeout value; parent cancel must skip retry; cleanup may not await a wedged iterator return. Production provider-side cause remains unproven; client regression is reproduced.
- Mid-loop experiment: completed read_file followed by never-resolving next doStream produced chunksThisStep=2 (queued previous step tail after eager prepareStep reset), so existing continuation gate rejected a clean inter-step stall. Resolve with stream finish-step reset and capture SDK onStepFinish response messages for safe continuation if final response never settles; test must prove one read and tool result in resumed prompt.

## Verification checkpoint
- Regression suite: 9 passed across main-handoff-stream and abortable-stream. Includes real SDK start/no first byte, slow response, zero-output retry, exhausted retry with ignored abort, main cancellation without retry, mid-loop read preserved once, late read discarded, provider errors preserved.
- Typecheck and build exit 0. Owned whitespace check passed. Source model/provider IDs remain runtime-derived.
- Compiled Node and Bun: four cases each passed, actual configured 10s stall floor, no timer getter mocks. Slow 2.5s wait survives scaled 1s turn idle; retry ~10.9s; exhausted ~20.9s; cancel <0.5s; receipt and main session retained. Reports acceptance-runtime-node.json and acceptance-runtime-bun.json.
- Socket-free standalone probes need a referenced keepAlive interval because production watchdog timers are intentionally unref'd. Initial Node probe exited 13 on unsetttled top-level await and initial Bun fixture was terminated after exact command/PID verification; fixed fixture passes both. This is fixture lifecycle evidence, not a provider repair.
- Native local MCP selfverify run 65002ea8-9971-4437-88dd-44fcd09e6d8e: 1 passed / 0 failed / 0 inconclusive, boot-to-idle only. Separate mounted wallet-boot harness 1 passed, composer/input-ready asserted.
- Full unit suite: running; do not reuse the prior 8756-pass claim for this revision.

## Export evidence supplied by user
- chat-export-0a64c9560662.txt: DB signature n=50 tool_result:49 user:1; live n=3 assistant:1 tool_group:1 user:1. Live assistant contains auto-commit status and watchdog error, no main final synthesis.
- src/ui/slash/export.ts compares entry type/count signatures; groups and error/status messages are different representations. Export preserved both sides. No evidence from count mismatch alone that helper evidence was lost.
- Historical root scope remains precise: production reached provider stream after PIL/compaction; SDK client failure mode reproduced and fixed. No live paid-provider soak or server-side root cause established.
- Remaining: final full-suite result, final artifact/state and memory note; no commit/push.
- Full suite and isolated headless-exit-code reproduce two JSON answer losses: step_start/step_finish emitted but PONG/partial answer absent (text mode passes). Abortable iterator adds scheduling; SDK lifecycle callback can finish before consumer processes text. Verified emitter clears text at step start and flushes only at step finish. Plan amendment: notify observer lifecycle from drained start-step/finish-step parts (ordered with text); keep provider callbacks for usage/checkpoint tracking. No headless output contract changes. Re-run headless and full suite after fix.
- First full run: 8762 passed / 2 failed / 14 skipped / 2 todo, 843.35s; both failures exactly headless-exit-code JSON rows. Retained log acceptance-full-suite.log. Source was corrected during the run; treat it as diagnostic only.
- After ordered observer fix: 30 passed (headless JSON/text/partial-error, golden, output, main acceptance and abortable stream), plus 131 passed across 8 guard/session/deadline files. Build final exit 0; Node+Bun final compiled cases now assert JSON output too (8 passed). Native final selfverify c38c4a58-1a6c-49c0-b28e-489d11d79208 1/1 passed.
- Production/test source frozen (acceptance-frozen-source.json) for final full-suite-final run. No source changes while it runs. Completion pending its exit and counts.

## Behavior after repair
| Situation | Main acceptance behavior |
|---|---|
| Provider delayed but below provider stall deadline | Keep main alive while waiting for actual provider data; stream main's answer normally. SDK start/start-step do not stop first-byte liveness. |
| No provider output | Existing provider idle timeout (default 120s) aborts the pending consumer read even when SDK ignores abort; safe zero-output retry (default one, 500ms backoff); exhaustion emits provider stall error and ends turn with receipt retained. |
| Completed tools followed by empty next step | Preserve SDK completed-step messages and continue within existing retry budget; verified single read_file execution and result in resumed prompt. |
| Main cancellation | Pending consumer read exits without retry; owner controller cleared; receipt retained. |
| Late abandoned output | Consumer does not yield it; aborted SDK finish callbacks do not update usage/checkpoints for a later active turn. |
| JSON/text output | Observer start/finish events are drained in stream order, so JSON includes main's text; text output remains covered by real CLI spawn tests. |

Provider server behavior (why it was silent in the historical session) is unknown. This repair bounds the CLI's wait and recovery; it does not guarantee that a remote server honors cancellation.

## Final outcome
- Final full suite: exit 0, 8764 passed / 0 failed / 14 skipped / 2 todo; 935 passed files / 6 skipped (941), 834.04s. Log acceptance-full-suite-final.log. Frozen source hashes match after completion.
- Final build/typecheck, 30 output/regression tests, 131 guard/session/deadline tests, 8 compiled Node/Bun cases (including JSON), native boot QA and mounted boot passed.
- Repair complete locally; no commit/push; unrelated WIP preserved. Existing running CLI must restart to load rebuilt modules.
- Memory curated: C:/Users/phila/.codex/memories/extensions/ad_hoc/notes/20261008-muonroi-cli-main-acceptance-stream.md.
