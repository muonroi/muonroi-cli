# Session5689: usable safe workers and accurate coordinator guidance

Status: verified locally against the frozen source/build below. No commit, push, deployment or user-session migration was performed.

## Outcome

Main retains coordination, user communication, planning and evidence synthesis. Substantive research, runtime audits, source inspection, commands, implementation, tests and independent review belong to workers. Blocked workers do not authorize main takeover or unsupported-tool probe loops. The source/tool boundary remains enforced; guidance now agrees with it.

Safe model-only workers can run without approving nonexistent operations. Actual permission-requiring worker operations use a separate host-owned Allow once/Deny channel, bound to owner/job/controller/request/toolCallId/input SHA256/original deadline. Model messages cannot approve tools. The same original executor/context and SDK step budget are retained; no safe-to-yolo conversion, role widening or TOTAL deadline extension occurs.

Explicit task background:false now waits through the durable task path; default/true stays asynchronous. The documented interim worker-question handoff remains possible. Worker approval polls before the main-busy gate, so a foreground wait does not block the human card.

Worker approval now has an independently focused, nonsticky preview viewport outside the transcript. Job/tool/call/digest/deadline and Allow once/Deny/Esc remain visible. PageUp/PageDown/Home/End control only this preview, including with a composer draft and global scroll-lock disabled. Request changes reset the view; terminal/expired requests disappear and stale decisions remain refused. Main payment presentation and decision handling are unchanged.

## Incident and reproduced defects

Stored session5689cd3c2e8c used step-5-preview in Agent mode at D:/sources/Core/extension/ai-dock. Read-only DB rows8858-8887 contain30 calls and no bash/list_tools/read_file/grep/edit_file/write_file execution: this was not a root source-tool escape. Main nevertheless performed the substantive runtime audit itself using metadata. Repeated prose promising work-tool probes did not prove those tools ran.

| Defect | Evidence | Repair |
| --- | --- | --- |
| Safe no-tool worker refused before inference | eager-emerald-heron:2691ms;clever-amber-sparrow:3443ms;both safe/off and explicitly no tools;w1-red-sentinel.log | Remove blanket setup refusal; obtain permission at actual operation boundary |
| Explicit false detached anyway | DB task row8875 stores background:false | Honor false in both explore selection and root-TUI routing |
| Prompt/tool mismatch | w2-prepared-red.log:real Agent,3 outgoing SDK requests exclude work tools but contain4 direct-work instructions | Project reference,skills,stage,system/cheap steering,batching and GSD actions by host role; role enters prompt cache key |
| Root quick-depth hint advertises absent review tool | w2-quick-red.log:actual quick/standard/heavy inventories,1failed/2passed | Describe available planning/review tools without changing workflow policy/state |
| Unseen suffix authorized | w1-preview-red.log:4046-character operation hides suffix after4000 yet writes it | Refuse oversized full redacted input before queue/effects;3999/4000 accepted intact,4001 refused |
| Long App preview cannot be inspected through transcript paging | tui-safe-inspection-diagnostic.json:stable71-row layout;secondPageUp does not move from58/5 | Dedicated worker-only preview navigation; exact deeper old global-scroll mechanism remains unattributed |

ACK protection already worked: row8878 guessed a version and was refused;8879 used the saved version. EE empty recall followed by successful write/recall/feedback is not an outage. Optional PIL timeout and StealthGPT401 are not established causes of these failures. No account quota/429 cause is inferred here.

## Verification on the final freeze

| Check | Fresh result | Evidence |
| --- | --- | --- |
| Canonical unit scope | Test Files  1007 passed \| 6 skipped (1013); Tests  9478 passed \| 14 skipped \| 2 todo (9494);exit0 | final-full-tests.log |
| Separate Bun-native SQLite/export | 10 pass; 0 fail; Ran 10 tests across 2 files. [742.00ms];exit0 | final-bun-sqlite.log |
| Final focused approval/UI/GSD |78/78 across6 files | ui-inspection-final-focused.log |
| Actual built Bun App |8/8 named controls | tui-safe-final-acceptance.json |
| Fresh native selfverify |boot1/1;zero skipped;emit=false | native-selfverify.json/log |
| Independent source review |PASS;51/51 source/dist hashes match | final reviewer handoff recorded in run artifact |
| Typecheck/build/semantic/diff |exit0;build warning lines=0 | ui-inspection-handoff.md;w1-w2-ui-build.log |
| Frozen revision |2058 source/test files unchanged before/after | validation-revision-before.json;validation-revision-after.json |
| Real user settings |hashes unchanged after native and full unit validation | evidence JSON settings |

Focused suites overlap and must not be added as unique tests. All logs above are under .scratch/session5689/. Canonical configured exclusions/skips/todo remain visible in the complete test log; Angular/browser/other dedicated suites are not implied by this result.

The eight actual App controls are sentinel, allow, deny, escape, foreground, responsive, long-preview, draft-preview. They use actual native UI keys, detached worker I/O, tool execution, durable SHA256 artifacts and completion callbacks with offline SDK responses. Main SDK has no project work tools; root SQLite is dispatch-only. No model-callable approval decision tool is exposed. Deny/Esc execute nothing; model-only safe sentinel requires no operation approval; foreground card appears while main waits; default background accepts a real followup before approval;80x24 preview renders prefix/middle/suffix and returns; draft survives with global scroll-lock off and later reaches SDK unchanged. Every captured operation card retains exact metadata and buttons. Human consent was withheld on failed inspection runs.

## Revision and protected state

HEAD: 2d33b8d9a557a8fec30ea4713d98b8469f8f5603. Started with 407 dirty/untracked paths; the full working tree was tested, not a clean committed revision. Follow-up ownership includes pre-existing WIP in shared files and does not attribute every existing diff to this task. Final manifest binds 31 source/test and 20 compiled paths, SHA256: e88b60d724d884d42fd18ead76384ac3240c1f39fa1277c222cd9aaf5c85a528. Source/test fingerprint: a50eafc42098504f1b695118d466b01a079e1c52f1451281788e669abc6f8368. No staging, commit, push, deployment or user DB/job/export migration was issued; real settings hashes are checked and historical reports retained. Existing user CLI processes need restart to load this local build.

Source anchors: src/orchestrator/worker-approval.ts:46,56,99;stream-runner.ts:330,650;orchestration-policy.ts:107;src/tools/registry.ts:1075,1093;context-load.ts:28;src/orchestrator/prompts.ts:550;src/gsd/workflow-tools.ts:131;src/ui/modals/wallet-picker-modal.tsx:11,23;src/ui/use-app-logic.tsx:6591;src/ui/app.tsx:2205.

## Evidence and limits

Machine-readable [evidence](evidence/session5689-worker-approval-2026-10-17.json) contains command summaries, hashes, native jobs/results and exact report paths. The authoritative run is .quick-codex-flow/sessions/01a1393f-631b-7752-94f0-59a96a173e2c/runs/session5689-worker-approval.md. Reproducers, failed private harness/probe attempts and the deliberately interrupted pre-correction full run are retained; none are relabelled as final passes. The prior implementation checkpoint draft is preserved at .scratch/session5689/report-implementation-checkpoints.md.

These controls prove the named local host/prompt/tool/UI contracts. They do not prove universal live-model obedience, paid-provider reliability, quota exhaustion, comparative token savings or all platforms. Stable file URLs/hashes plus exercised paths are not module-loader tracing. No external EE/server/provider deployment was required for this repair.
