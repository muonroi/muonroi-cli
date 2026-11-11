# Session55a0b3593c0f: nested research activity cancellation

## Observed incident

Production SQLite was opened with `mode=ro`. The session used `step-5-preview`, cwd `D:\sources\Core\muonroi-cli`, from02:44:51.203Z to03:02:40.628Z on2026-10-19. Its user requested a runtime-only CLI assessment, including council/ideal, and an evidence-backed report.

| Event | Record / tool call | UTC / outcome |
| --- | --- | --- |
| Four general task dispatches | 64944/64947/64950/64955 | All four returned the explicit heavy-depth FLOW refusal; no general implementation launched through these calls |
| First plan write | 64965 ->64966 |02:48:01.453Z ->02:48:01.500Z; `.planning/PLAN.md` |
| First review |64969 ->65091; `chatcmpl-tool-9a01e035df507ead` |02:48:04.762Z ->02:55:47.594Z; completed `revise` |
| Second plan write |65095 ->65096 |02:56:37.598Z ->02:56:37.636Z; revised PLAN.md |
| Second review |65099; `chatcmpl-tool-8dece00f6c18e7dc` |Started02:56:40.556Z; no matching completed root tool-result |
| Research during second review |child call`2c82f23b-78f4-46b0-91b6-e0af15531bb8` |Council research02:58:02.152Z ->03:02:03.409Z; multiple read/grep steps, results65228/65229 at03:01:11.993Z |
| Cancellation |65239; main call`b0891890-8237-40f7-b808-5bf9be4c576b` |03:02:40.602Z; `tool-stall`, kind`idle`, phase`tool-execution`;360.046s after second review start |

The host emitted: `Tool execution exceeded its activity budget. The request was cancelled; review partial changes before retrying.` Council output/spend events still appeared around the cancellation; these events alone do not establish a completed second review or approved plan. Accounting row counts are not council-run counts.

## Reproduced defect and repair

The existing parent tool activity lease uses AsyncLocalStorage ownership. Its default renewable idle interval is300000ms plus5000ms grace. Explicit tool deadlines do not renew; expired leases cannot revive. Before this repair, only council LLM output noted progress to that lease. StreamRunner research could successfully read/search repeatedly without renewing its parent's activity.

This was reproduced through actual SDK execution, then through a root Agent whose plan-review bridge invoked real StreamRunner research. With progress notes removed, that root control emitted the same cancellation text while research continued. With notes restored, it completed and returned to the main answer. These are isolated mock-provider controls, not a replay of the paid incident. The original process-loaded revision and historical timeout environment were not captured; defaults are source values, not asserted effective runtime settings.

`src/orchestrator/stream-runner.ts` now notes nonempty text, tool-call and successful tool-result progress to the existing owning lease, after checking cancellation. It adds no periodic heartbeat and does not renew on reasoning-only stream events. Explicit deadlines, foreign request activity, expired leases and existing failure-loop guards retain their behavior. No budget values, workflow admission, provider routing or automatic retries were changed. Existing council reasoning accounting was not redesigned.

## Partial effects and preservation

- Captured root mutations include two native FLOW plan writes and the completed first review. The session has no write_file/edit_file interaction events; its seven recorded bash calls are research inspections in their captured previews. Truncated previews are not a complete filesystem audit.
- Requested runtime evaluation probes/report were not proven complete by this session. Four intended general probe workers were refused before launch.
- The internal council research accessed source even though the original request asked for runtime-only assessment. This patch addresses activity accounting; it does not change review sourcing policy or claim those source reads were runtime-only evidence.
- Snapshot hashes for STATE.md, PLAN.md, PLAN-VERIFY.md and PLAN-REVIEW.md match after repair. No production DB, job, settings, credentials, planning state or report was replayed, cleared or rolled back. Existing changes are preserved.

## Verification

Evidence: `.scratch/nested-research-55a0/`.

| Check | Result |
| --- | --- |
| Isolated SDK before-control (`before.log`) | Renewable parent incorrectly expires after real read/text progress; explicit-deadline negative control passes |
| Corrected top-level before-control (`nested-before.log`) | Exact activity-budget cancellation reproduced |
| Focused regression (`tests.log`) |87tests/8files pass; SDK reads, nested council research, explicit timeout, owner isolation, no revival, overdue/cancellation, failure-loop, first-token watchdog, catalog admission |
| Typecheck / build |Exit0 / exit0 |
| Fresh built Agent/SDK (`compiled-progress.json`) |8/8; private HOME/USERPROFILE/DB; actual local fixture read, correct owner renewal, foreign/explicit deadline unchanged and eventual expiry |
| Native selfverify (`native-selfverify.json`) |Actual Bun TUI boot1/1; boot only |
| Planning preservation (`planning-after.json`) |Four saved planning hashes unchanged |

The initially added top-level test had fixture-only approval/default-mode and method-name issues. Only the corrected before/after control is causal evidence. No paid council/provider rerun, live-duration latency claim, full suite, push or deployment was performed. Restart the built CLI with Bun to load the repair; inspect the preserved review state before any user-authorized continuation.
