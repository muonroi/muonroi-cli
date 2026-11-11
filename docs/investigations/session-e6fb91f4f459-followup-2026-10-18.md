# Session e6fb91f4f459: evaluation follow-up and missing council activity

Source report: `D:/sources/Core/extension/ai-dock/evaluation_report.md` (13,907 bytes at inspection). The original report and its jobs/artifacts were preserved. Scope: local CLI repairs; no vendor auth changes, permission widening, paid fan-out, deployment or interruption of the user's council.

## Findings against host evidence

| Reported observation | Verified boundary |
| --- | --- |
| Five workers completed | Confirmed: three initial probe/verification jobs, plus report writer steady-emerald-wolf and reviewer steady-emerald-falcon. The report appendix lists only the first three. |
| MCP unavailable in explore worker | Confirmed for lively-white-badger: exact docs_search grant persisted, list_tools MCP count0. Explore intentionally has no arbitrary MCP tools. The host wrongly accepted and silently ignored the incompatible grant; this does not establish failure of general-worker MCP mounting. |
| All child MCP tools are missing | Not established. A fresh general-worker setup fixture mounted, discovered, described and executed its exact granted MCP; ungranted/parent tools stayed absent. Separately, child discovery did incorrectly use the global parent inventory; that defect was reproduced and repaired. |
| Four tiers/basic-general-advanced-super and provider rows openai-gpt/claude | Contradicted by the same session's actual worker_models result at DB message seq3: total2, deepseek-v4-flash/fast and deepseek-v4-pro/premium, both provider=deepseek. Do not use the report's model section as runtime inventory. |
| cmd /c timeouts under MSYS | Host worker evidence records the timeouts. Fresh EOF-dependent shell repro also timed out before repair. A later native cmd /c probe exited0 with only a prompt, proving that closing stdin alone does not validate command execution. |
| canExecute=false blocks all execution | Incorrect scope. This gate controls flow_execute; flow_ship has its own gate. Direct task/delegate admission also checks model, role, permission and concurrency independently. |
| StealthGPT401/PIL timeout, DeepSeek unknown vendor limits | Retained as bounded observations, not fixed by substituting credentials or inventing quotas. A configured background-job cap is not a measured account RPM/TPM limit. |

Host artifacts are summarized in `.scratch/evaluation-e6fb91-20261018/host-evidence.json`; only native baseline tool results and bounded job metadata were extracted from the read-only DB/job store.

## Repairs

1. `src/tools/registry.ts`: child list_tools/describe_tool use the child-local final permitted tool set supplied by StreamRunner. They no longer borrow the parent's global inventory. The advertised schemas now state the role boundary for MCP grants.
2. `src/orchestrator/orchestration-policy.ts`, `delegations.ts`, `stream-runner.ts`: incompatible MCP grants are refused at selection/dispatch/setup with `worker_capability_role_refused`, before a worker/model call. General task workers can receive exact grants; explore, verify-detect and reviewOf keep their existing read-only limits. A tool name such as read/search is not treated as evidence that an arbitrary MCP is side-effect-free.
3. `src/tools/bash.ts`: foreground commands receive EOF on inaccessible stdin, matching background execution. Leading cmd /c and quoted /c in Windows Git Bash are refused with `msys_cmd_switch` and cmd //c guidance. No arbitrary command rewriting or global path-conversion change was introduced. The guard covers the observed leading-command forms, not a general parser for every possible nested shell expression.
4. `src/workflow/workflow-tools.ts`: flow_status includes gateScope, naming flow_execute/flow_ship and the separate worker admission checks. Gate facts, permissions and durable workflow state are preserved.
5. `src/ui/utils/agent-activities.ts`: convene_council is now a council activity in Agents and /jobs, using the topic as label and reason/context as detail. A successful dispatch receipt remains running until the durable job snapshot becomes terminal. Shell grouping is unchanged.

## Missing council in the user's screenshot

The actual job was gentle-teal-falcon, kind=council, owner=e6fb91f4f459, PID62396. At inspection it was running with a live Bun process. The UI collector recognized task/delegate/background bash but omitted convene_council; the callback/snapshot code already included council jobs. A regression reproduced zero rows for the council before the repair.

Actual completion evidence, observed without claiming or changing notification state:

- Started: 2026-10-18T09:21:52.571Z.
- Completed: 2026-10-18T09:27:56.063Z.
- notifiedAt/deliveredAt: 2026-10-18T09:27:56.466Z (403ms after completion).
- Parent transcript seq71: completion system message at09:27:56.449Z.
- Parent seq72: host-generated wake prompt beginning `[background jobs finished]` at09:27:56.608Z. Its user role is the existing synthetic wake convention, not proof of a manually typed continue.
- ACK: 09:28:18.029Z for resultVersion f1398d84913ff35d31d5c117284baa99526aace0d4d67b12c4462cb6a83141f6.

This confirms delivery/wake/ACK for this council. ACK records handling, not validation or acceptance of the council's conclusions. The running job was not killed or restarted by this investigation.

## Fresh verification

| Check | Result | Artifact under .scratch/evaluation-e6fb91-20261018 |
| --- | --- | --- |
| Initial reproducers |3 failed/33 passed before changes: child inventory, incompatible grant, stdin EOF | before.log |
| cmd false-success reproducer |1 failed/1 passed before the targeted guard | cmd-before.log |
| Council rail reproducer |1 failed/22 passed before classification | council-rail-before.log |
| Focused regression |233 tests /17 files passed, exit0 | accepted-tests.log |
| Council return and durable delivery |17 tests /2 additional files passed, exit0 | council-callback-tests.log |
| Build/typecheck/semantic instrumentation |Pass, exit0 | build.log, typecheck.log, semantic.log |
| Compiled-module controls, real Git Bash/MSYS |10/10: stdin EOF, scoped inventory/description/execution, exact-role refusal, cmd rejection/escape, gate scope | compiled-controls.json |
| Native OpenTUI/React rendered rail |4/4 actual native character buffers: running/done, widths44/28, height10 | council-frames.json; council-28-running.txt and other frame files |
| Native selfverify through built tools-MCP |Boot1/1, no skipped scenario | native-selfverify.json |

The frame checks render the actual compiled rail component using OpenTUI's native test renderer; they are not a full live App navigation test. The separate selfverify proves App boot. The general-worker MCP execution test uses an isolated MCP acquisition fixture, not a claim that a third-party MCP currently accepts credentials. No broad vendor load test or full repository test suite was run. Existing Vitest mock-hoisting and React act warnings are retained in the logs.

The local build contains these repairs. An existing TUI process must restart to load them; its historical transcript/job records can then reconstruct council rows. No automatic restart of the user's active work was performed.

## Council result audit after the full result was shared

Follow-up implemented and locally verified: see [Council caller output and executed-tool evidence](council-output-evidence-2026-10-18.md). The historical observations below remain unchanged; the new result does not retroactively add evidence to the old job.

PID62396 breadcrumb records establish9 paired phase enter/exit events: panel_select; evaluate/research decision; research; opening for2participants in parallel; exchange round1/1pair; round evaluation; evidence-verification research; summary; synthesis. Recorded model IDs include deepseek-v4-pro for leader/synthesis and deepseek-v4-flash for summary. These are observed workflow stages; six minutes elapsed and a pros/cons table alone would not prove the execution path. Phase-level records do not establish each participant's model identity or that every factual claim was independently verified.

The verdict must be qualified:

- The same-session native worker_capabilities output (DBseq3) reported19 capabilities, including6 muonroi-docs tools. The explore worker's job granted1 of them, docs_search. Its read-only child exposed0 arbitrary MCP tools. These are different scopes, not evidence that an identical mount path randomly returned19/1/0.
- The council's input brief already contained the describe_tool digest and missing-tool observations. Its saved job has0 host native tool artifacts. Two research phase completions do not establish which source was read; no captured tool call proves docs_search execution or independent rereading of the referenced digest. The claim of recursive/independent MCP-gap confirmation is therefore unverified.
- The reported severity P1 and confidence0.7 are council judgments, not measurements. Delivery/ACK confirm result handling, not correctness. A blanket warning whenever MCP count0 would be wrong for intentionally native-only/read-only jobs; the implemented refusal is tied to an explicitly requested grant that the selected role cannot receive.
- Pros/cons, evidence ledgers and dissent can also be written by a single model. This run demonstrates a staged council workflow; a quality advantage over a single worker requires a controlled comparison, which was not run.
- The requested synthesis contract was one compact JSON object with recommendation/rationale/dissenting_view. Removing the host markdown envelope, the saved body is not a single parseable JSON value: it includes the full decision, a READABLE section and another compact JSON. The compact-output contract is not demonstrated as satisfied; this is recorded as an output-contract follow-up, not silently reported as fixed.

The scoped-grant and child-inventory defects identified in the implementation section are repaired; an older council conclusion does not supersede those current runtime checks. Evidence for this additional read-only audit: `evidence/session-e6fb91f4f459-council-audit-2026-10-18.json`. No new code/model experiment was performed for this audit.
