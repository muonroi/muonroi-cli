# Worker completion followed by a main stream stall

## Result

Session `0717b08730a1` received the completion notice for `quiet-violet-panda` and automatically started a new main turn. The failure happened after callback delivery. Two main stream attempts received zero content chunks and hit the 120-second watchdog. There is no recorded HTTP 429, response status, response body or provider trace for these attempts. A timeout does not establish exhausted credits or an upstream outage.

A separate, reproducible CLI defect was found and repaired: terminated streams retained provider concurrency slots. On Bun, five source errors, consumer cancellations or caller aborts each exhausted the five-slot pool; the sixth call did not reach the synthetic transport. The old fallback waited 900000ms (15 minutes) before releasing a stranded slot. This proves a local mechanism for the same zero-output symptom. The historical process's in-memory semaphore was not captured, so this report does not claim all historical silence was caused by that mechanism.

## Historical measurements

Sources: original export, read-only SQLite transaction, owner-scoped delegation record/output, debug log and durable crash breadcrumbs. All timestamps UTC, 2026-10-15.

| Time | Recorded event | Evidence |
|---|---|---|
| 04:16:39.680 | Worker marked complete | `quiet-violet-panda.json` |
| 04:16:40.551 | Completion marked notified | Same record |
| 04:16:40.559 | Main receives system notice | Message seq112 |
| 04:16:40.706–04:16:48.713 | Main pre-turn classification | Breadcrumb start/end, DIRECT_ANSWER |
| 04:16:49.895 | Main turn preparation logged | Interaction57194 |
| 04:16:49.913 | Main routing selects step-3.7-flash | Interaction57196, project-model-pin |
| 04:16:49.915 | Full wake prompt persisted | Message seq113 |
| 04:17:19.966 / 04:17:49.978 | Compaction proposer retry / final timeout | Two 30000ms deadlines |
| 04:17:50.032 | First stream attempt starts | Interaction57197, preparation60135ms |
| 04:19:50.040 | First idle stall; zero chunks | Interaction57199, call7e788b62-8828-4f8d-92df-e017ff5168b3 |
| 04:19:50.046 | One automatic stall retry | Interaction57200, delay500ms |
| 04:20:20.576 / 04:20:50.591 | Compaction proposer repeats and times out | Debug log |
| 04:20:50.655 | Second stream attempt starts | Interaction57201, cumulative240759ms |
| 04:22:50.671 | Second idle stall; zero chunks | Interaction57203, callce54c570-c720-4424-b98e-2fa3960c44ff |
| 04:22:50.674 | Main stores interrupted-turn marker | Message seq114 |

Elapsed from worker completion to final error: approximately371s. Attribution: approximately10s to start preparation, 60s initial compaction, 120s first stream watchdog, 0.5s retry delay, 60s repeated compaction, 120s second stream watchdog. No `delegation_read` or other main tool ran during this wake turn. PIL preparation itself was3ms in the breadcrumbs. This is not a missing callback or a main thread polling the worker.

The stream accounting estimates were110164 then101797 input tokens (character estimates, not billed tokens), below the recorded256000 ceiling. The preceding ordinary main response used the same3.7 model and completed at04:16:37.870, reporting98145 input /933 output tokens. No successful usage row exists for the failed wake turn.

The worker's saved output is only400bytes and says `Task completed. Last action: cd ...`; it does not contain a substantive implementation/verification receipt. `status=complete` is process outcome evidence and does not prove the W7 task was finished. This investigation did not rerun or modify that task.

## CLI reproduction and repair

The measurement tool invokes the actual `wrapModelWithGate` and limiter with an isolated temporary ledger and a local synthetic transport. It makes zero network requests. Concurrency is five. For each mode, terminate five streams and attempt a sixth with a150ms cancellation bound.

| Bun scenario | Before: slots retained after five | Before: transport invocations | After: slots retained | After: transport invocations |
|---|---:|---:|---:|---:|
| Source stream error | 5 | 5; sixth blocked | 0 | 6 |
| Consumer cancels readable | 5 | 5; sixth blocked | 0 | 6 |
| Caller aborts request | 5 | 5; sixth blocked | 0 | 6 |

Baseline elapsed181/170/167ms; accepted after-repair measurement68/34/32ms, including temporary ledger I/O. In the source-error control the sixth request reaches transport and receives the original synthetic error, which is expected; it is no longer blocked by the local limiter.

Cause: the old `releaseOnStreamEnd` relied on `TransformStream.flush` and a transformer `cancel` callback. Source errors do not flush, and Bun did not invoke that transformer cancellation callback for readable cancellation. Caller abort had no immediate lease cleanup. Node/Vitest reproduced the abort leak; the separate Bun probe reproduced all three paths.

Repair in `src/providers/model-gate.ts`: observe the native `pipeTo` promise for completion/errors/cancellation, forward caller abort into the pipe, release local/shared leases on abort, and remove the abort listener/watchdog through an idempotent cleanup function. Existing stream errors and usage settlement remain observable. Healthy streams keep their slot while producing output. Catalog limits, model settings, timeouts, retries and callback policy are unchanged.

## Export comparison

Original path: `D:/sources/Core/shipd-challenge/chat-export-0717b08730a1.txt`.

- Size324133bytes; SHA256 `e4eed9feb9a10a0e0333e73d141743f2bea90d1d6e8a939254c08273cc62b8c5`.
- Header reports128DB entries /107grouped live entries. Expanding the live tool groups yields128rendered entries, with the same type histogram.
- Content still differs: internal wake prompts versus compact wake labels, durable interrupted-turn marker versus visible stall error, plus earlier shifted user labels. Keeping both sections is justified. Equal expanded counts do not prove content equality.
- The final export footer is excluded from message comparisons. The original file is preserved.

## Verification and evidence limits

- Focused acceptance:200tests /10files passed, native exit0, including real gate/ledger lifecycle, pacing, cancellation, compaction deadlines, main handoff, stream runner and real-DB delegation tests.
- Native Bun probe: all three terminated-stream modes release slots and dispatch the sixth request.
- Native MCP/TUI:7/7checks passed; a native background worker runs, main responds to a human before completion, output is saved, and completion auto-wakes main. Mock provider, private home; no user task replay.
- Native `selfverify_start`: run564218a6-268c-4876-a59a-539a4196fbff, boot1/1pass,0failed;2council surfaces skipped because they have no registered opener. Uses the workspace native server.
- Build passed, native exit0. The existing Vitest setup hoisting advisory remains; it is not a test failure. No full-suite or paid-provider acceptance claim for this change.
- No new StepFun calls, settings changes, user worker cancellation, DB mutation, API deployment, commit or push. Restart the CLI to load the rebuilt module and clear old in-memory slot state.

Retained tools and selected measurements: `reports/worker-callback-stall-2026-10-15/`. Private detailed DB/export/log extracts remain in `.scratch/worker-callback-stall/` and are not part of the shareable measurements. The earlier StepFun429 support archive is unchanged.
