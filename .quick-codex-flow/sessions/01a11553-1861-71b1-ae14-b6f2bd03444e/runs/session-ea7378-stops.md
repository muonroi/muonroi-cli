# Session ea7378aab8f8 repeated task interruption

Workflow: qc-flow, balanced, single agent, auto within the authorized diagnosis/repair. Gate: research closed; checked repair plan ready.

Goal: diagnose and repair repeated task interruptions reported with chat-export-ea7378aab8f8.txt. Distinguish provider stalls, goal/context loss on rotation/helper handoff, stale runtime versus the recently released background PIL, and DB/live presentation differences.

Evidence so far: export ends with Model not responding (provider stall guard), not a TurnStallError label. debug.log:2393 records rotation d78d41cab2b8 -> ea7378aab8f8 at 06:12:01 with summaryLength 0. Helper 387de3109b1c was forked/resumed and returned receipts three times; export repeats plan review rather than implementation. Need exact DB/accounting/breadcrumb request evidence and runtime reproduction before naming root causes.

Protected: preserve user task artifacts/WIP, settings/credentials and session DB; read-only forensic queries only. Preserve main-primary ownership, tool permissions, background-only PIL, existing watchdog protections and model-owned council. Do not implement the unrelated guard/measurement/trace task contained inside the exported conversation.

Next verify: query targeted session and helper rows; compare process timestamps and current build contract; reproduce any faulty rotation or nested-tool stall with mock providers and temp state. Close research then write/check the smallest repair plan, focused regressions, build/typecheck/native QA; full configured unit suite zero failures before any push.

## Confirmed evidence

- Read-only tool_calls: helper gsd_plan_review started 06:25:34.032, provider idle fired 06:27:34.005 (interaction 54696); main review started 06:29:30.290, idle fired 06:31:30.333 (54924). Both calls remained pending. Council breadcrumbs continued through synthesis at 06:37:45.914 after turn finalization. These are tool waits misclassified by the outer provider timer, with cancellation failing to reach the nested council.
- debug.log:2393: rotation d78d41cab2b8 -> ea7378aab8f8, summaryLength 0. New session seq2/seq3 asks what to retry; helper likewise lacks earlier request. Regression sub-session-delegation.test fails: expected session-parent, received session-child for whitespace compaction.
- nested-council-stall.test uses real Agent + AI SDK execution + isolated DB, mocked workflow policy/council work. Red: slow tool produces Model not responding; overdue/cancelled council receives no abortSignal (3 failures). Logs session-ea7378-red-nested.log and session-ea7378-red.log retain proof.
- Runtime pid22728 started 04:20:56 UTC, before the prior background-PIL release build. It does not hot reload the module graph. Current-source repro establishes that stale runtime alone does not explain these independent defects.

## Checked execution plan

1. Preserve main/history if compaction is blank before creating or linking a replacement session. Validate with the existing Agent rotation regression; keep successful rotation coverage.
2. Use request-owned tool-activity handles to suppress outer provider idle/progress only during bounded tool work. Renew only undeclared tool activity on actual nested council deltas through a scoped async context; explicit command deadlines stay fixed. Verify slow/streaming council continuation, stalled tool expiry and parallel scope isolation.
3. Thread SDK tool abortSignal through workflow review -> debate -> runCouncilV2. Guard post-abort council transcript updates and plan-review retries/artifact writes. Verify cancellation reaches the child and no late transcript/plan writes occur.
4. Run focused regressions, typecheck/build/semantic checks and native TUI QA for workflow changes. Run the full configured Vitest unit suite before any push; preserve test source through hooks. Report local proof and remaining real-provider/runtime limits separately.

Plan check: scope is shared liveness/cancellation and atomic rotation, with no new provider/model literals, no removal of watchdogs, no edits to user DB/task artifacts. No active gray area; main-primary/background-PIL contracts remain protected. Each step has a runtime verification path.

## Implemented and focused verification

- Guard blank compaction before session creation/link/swap. Nonempty rotation remains supported.
- Provider watchdog consults request-owned bounded tool registrations; actual council deltas renew only the owning undeclared tool's idle window through AsyncLocalStorage. Explicit bash deadlines and expired work cannot be renewed. Tool expiry is logged as tool-stall/tool-execution with a distinct error; no misleading provider rescue on that path.
- SDK abortSignal flows through both GSD plan review and verification into nested debate and Agent.runCouncilV2. Plan council cancellation cannot retry, fall back, overwrite verdict artifacts, or advance the workflow. Council stops before synthesis/outcome persistence and its detached quality callback checks cancellation.
- 82 targeted tests / 12 files passed, including real Agent + SDK slow/streaming/overdue/user-cancelled tool tests, rotation preservation, actual GSD callback cancellation, and cancellation during council synthesis.
- typecheck, build, Biome (zero errors; existing warnings), strict semantic checks and secret scan passed.
- Native selfverify d29c9fbb-1105-4b64-8f4e-bd97fdd6cfe8: 1 smoke-boot scenario passed, zero failed/inconclusive. This is boot evidence only.
- Mounted TUI: 12 behavioral assertions / 5 specs passed. Bun native crash diagnostics still occur during harness child shutdown; this known independent limitation is not claimed fixed.
- Full configured suite (bun run test -> Vitest) running. Source snapshot session-ea7378-tested-source.json freezes 1847 source/test/script inputs; no push authorized by this gate until full suite reports zero failures.
- Recovery: src/index.ts:959 supports --session <id>. Existing CLI process requires a restart; loading a saved session reconstructs persisted history rather than using its old in-memory module graph. User DB/task files remain unchanged.

Additional transition audit: the hypothesis that a completed review leaves too little progress budget for its next provider step did not reproduce. Added a real SDK status -> delayed review -> streamed reasoning -> final text case; it passes without another production change. The first full-unit attempt was deliberately cancelled to include this additional regression in a fresh run. Only session-ea7378-full-unit-final.log will count as the final full-suite gate.

## Final validation gate

- Configured full unit suite completed with exit 0: 943 files passed, 6 skipped; 8841 tests passed, zero failed, 14 skipped, 2 todo; 826.70 seconds. Log: session-ea7378-full-unit-final.log. All five nested-council SDK scenarios passed in this full run.
- Native Bun SQLite coverage: 10 passed, zero failed (export-transcripts and transcript-fts).
- typecheck (after final test addition), build, staged Biome, strict semantic instrumentation and secret scan passed. Source hash comparison after the full suite and staged formatting: zero differences across 1847 inputs.
- Native selfverify and mounted-TUI results remain as recorded above; the independent Bun shutdown-crash limitation remains open. These checks are local verification, not live provider replay or remote CI evidence.
- Implementation released: d3f1a51deb3bba390ac753aea06b371734260fef, pushed to origin/develop and matched git ls-remote refs/heads/develop. Normal commit/push hooks passed; binary compile smoke passed. Push selector detected no watched UI/harness/self-qa changes, so explicit native QA above supplies the workflow verification.
- Remote reports two required status checks expected; remote CI is not claimed green. No user DB, credentials, or task artifacts were changed by the forensic/repair work.
- Goal audit: the reported false provider stall, uncancelled nested review and empty rotation are reproduced and covered by passing regressions. Actual provider outages, workflow revise verdicts and the independent Bun shutdown crash are not claimed eliminated. Main-primary ownership and background-only PIL remain intact.
