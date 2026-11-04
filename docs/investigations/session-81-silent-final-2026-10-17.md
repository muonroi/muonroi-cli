# Session81: silent finalization after tool evidence

## Confirmed incident

Session `81e606ae4fda`, 2026-10-17 **02:48:42 UTC / 09:48:42 Asia/Bangkok**. Original DB was opened read-only. Two `read_file` calls completed; the model then ended with reasoning but no visible final answer. The text-only finalization call emitted native `<tool_call>` markup instead of an answer.

| DB record | Observation |
| --- | --- |
| 60299-60305 | Two report/evidence reads and their successful results. |
| 60308 | `error/tool_markup_leak`, model `step-3.7-flash`, 1,149 characters suppressed. |
| 60309 | `f6_synthesis`, `outcome=error`, elapsed 13,026 ms, `ToolCallMarkupLeakError`. |
| 60310 | `agent_response`, `textLength=0`, `toolCallCount=2`. The turn ended empty. |
| Message seq55 | Reasoning-only assistant content; no successful execution of the intended bash markup. |
| Message seq57 | User `tiếp tục`. A subsequent turn completed at seq68. |

There is no recorded HTTP429 in this failing main-turn window. The evidence establishes an invalid provider response **and** a CLI recovery/reporting gap; it does not establish exhausted quota, callback failure, or context overflow. The no-tools guard correctly prevented markup being treated as an answer or executed as a command.

## Implemented repair

- F6 receives the current completed assistant/tool messages together with the input history; previously it received only the input request history.
- A typed `ToolCallMarkupLeakError` from F6 permits **one** ordinary tool-enabled continuation, using the saved tool evidence. The rejected markup is never executed or converted into a shell command.
- Recovery requires available tools, remaining soft/hard step budget, no cancellation/ceiling/no-progress halt, and remaining existing re-steer allowance. Spent steps carry into the new attempt. Output-length continuation remains a separate bounded mechanism.
- Empty, generic-failed or exhausted finalization produces a visible, persisted **Task incomplete** notice. Failure is recorded in `final_answer_failure`, agent response `incomplete`, and routing failure outcome instead of normal success. A recovered attempt records `final_answer_recovery`.
- Existing permission/GSD checks, model/provider choice and tool results remain authoritative. No unbounded retry, automatic provider switch, generic429 retry, or rerun of completed actions was introduced.

Production changes: `src/orchestrator/tool-engine.ts`, plus two event-type declarations in `src/storage/interaction-log.ts`. Working-tree changes were preserved; no session/database/settings migration or release was performed.

## Verification

Private scripts and logs: `.scratch/session-81-interruption/`.

| Check | Result |
| --- | --- |
| Original regression reproduction | 5 RED failures: recovery absent and empty final replies had no durable notice. |
| Real Agent/MessageProcessor/tool-engine tests with SDK mock streams | 47 passed across 5 files, including markup recovery, empty/error fallback, retained evidence, one-time read, step cap, carried budget, caller cancellation, existing output-length and main-handoff cases. |
| Existing tool-loop cap suite | 15 passed, 1 file. |
| Build | Exit0; first build's missing event-union types were corrected before the accepted build. |
| Actual compiled Agent + SDK mock + real provider markup guard + isolated SQLite | **8/8**, exit0. Test session `1c5e6557ab58`, 03:14:24.137-03:14:25.463 UTC: 3 main calls, 1 rejected no-tools markup response, 1 recovery event, exactly1 file read, no bash invocation, final answer persisted. |
| Rebuilt local tools-MCP/native controls | **16/16**, including actual mock TUI routing command. |
| Native selfverify via freshly started local tools-MCP | Run `bd397c6c-b56e-46bc-a961-9dfa8cb22486`, boot/status **2/2**, no failed or inconclusive scenarios. |

Compiled-probe instrumentation failures were retained: its first selector also counted background compaction calls; the next assertion looked for the event subtype in the metadata JSON rather than its dedicated column. The corrected probe checks the actual subtype and a finalization request carrying actual tool-result messages. No application guard was bypassed.

The original live provider incident is confirmed by DB records; repaired behavior is established by bounded source integration and compiled mock-provider experiments, not a paid live-provider replay. No full unit suite or push was performed.

## Corrections to the consumer session's verification report

1. `Session=20261017095226327691500` was created with `date`; the actual session is `81e606ae4fda`. A package version and hash of a file on disk do not prove that file is loaded by the running CLI. Provenance remains unverified without process/module evidence.
2. A successful literal history query does not test the bare `*` preflight. Keep literal search PASS and wildcard UNVERIFIED until the exact call is made.
3. Routing unit tests passed; live TUI routing was not verified by that consumer session. Separate those verdicts instead of one unconditional PASS. Our isolated local TUI evidence is a different run.
4. `ee_health=200` with `recallReady=not_checked` and `ee_query=ee_unavailable` is a failed/unavailable recall observation, not a contradictory health claim or proof of server downtime. The 02:35 successful recall and the 02:51 unavailable recall occurred at different times and in different project contexts. The latter needs its own request/transport/circuit/scope trace before attribution.
5. Historical file sizes/cooldowns, tool count, declared stub behavior and mixed Windows paths do not by themselves establish current token waste, council cost, current429s, parsing failure or policy conflict. `no such column: After/edit` without the exact MATCH query and schema comparison does not establish schema drift.
6. Checkpoint goal replacement was not established here. DB seq1 contains the older runtime-only evaluation request; seq52 contains the newer explicit verification request. The checkpoint's verification goal matches seq52. No compaction goal-selection change was made on this evidence.

## Apply

The change is built locally. An already running CLI retains its loaded modules; restart using the rebuilt workspace CLI to apply it. Original user sessions and shared MCP processes were not terminated or reconfigured.
