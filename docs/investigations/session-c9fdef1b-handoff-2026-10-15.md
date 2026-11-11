# Durable worker handoff and session feedback

## Scope and result

The owner's highest-priority acceptance criteria are consistent job/delivery state, retrievable child evidence, and preserving handled results across compaction. These are the implementation scope of this repair. Historical session inspection is read-only; the TCIS checkout, actual worker records and user DB were preserved. No provider calls, deployment, commit or push were performed.

The earlier session0717b08730a1 callback/stall investigation is separate: see [worker-callback-stall-2026-10-15.md](worker-callback-stall-2026-10-15.md). It proved callback delivery and repaired a local streaming-slot leak; it did not establish a historical StepFun429 for the stalled turn.

## What the real session establishes

All dates2026-10-15, timesUTC. Sources are SQLite messages/tool results/interaction logs, owner-scoped job records, and source read in the working checkout.

| Observation | Evidence and conclusion |
|---|---|
| Parent/child relationship | `195fd9a9b18a.parent_session_id=c9fdef1b04d4`, kind=subagent, both model=gpt-6.1-sol. The screenshot's tree relationship is correct. |
| First helper result | Child response04:29:36.827; main stores a returned receipt04:29:37.131, then produces its own acceptance response04:31:06.295. |
| Missing later helper result | Child resumes04:31:11.677 and produces a response04:32:07.925 with compacted=true; parent receipt04:32:08.206 says no result/no tool results. The positional handoff boundary is invalidated when compaction shortens the message array. |
| Repeated heron handling | Main calls delegation_read(clever-violet-heron)04:30:09.247 and uses it in its04:31:06 response. The job is then notified04:31:06.589, triggering a helper which reads it again04:31:53.924. Reads previously did not record delivery; the notification mechanism only knew notifiedAt. |
| Otter still running | Main's first read starts04:30:21.423; worker completes04:32:03.774; completion notice04:32:08.248. The retained evidence does not establish completed-then-running state reversal. |
| Completion publication | completeDelegation already writes the output before terminal JSON. Preserve that order; do not call this an established publication race. |
| Overlapping scope | Both jobs audit overall CodeStandards maturity. Existing default instructions mandated delegation for ANY research and suggested delegation from fixed tool-round counts. Main now decides from scope/independence. |

The Sessions card is a context tree, not a live worker counter: its dot means isCurrent, its msg count comes from persisted messages, and active is an open-session status. A routed sub-session runs inside the current agent turn, returns a bounded evidence receipt, and main performs acceptance. A background worker runs independently in another process and uses the durable job/result/notification path. The screenshot alone does not prove stale message counts or a running worker.

## Implemented delivery contract

- A terminal result has `resultVersion=SHA256(saved artifact)`. Completion/failure notices and reads include jobId, version and saved artifact path. A missing or changed artifact is not delivered as a readable completion.
- Execution and handling are separate. Execution retains running/complete/error and adds a distinct cancelled state. Handling is pending/delivered/acknowledged, with durable version/timestamp fields. Delivery is not an assertion that the worker's verification passed.
- A successful owner read records delivery under the same job lock used by notification consumption. An already delivered version does not generate a later redundant wake. Existing notifiedAt records remain compatible.
- `delegation_ack({jobId,resultVersion})` records main's explicit handling after processing the evidence. It rejects stale versions, unread versions and foreign owners. The metadata survives restart and context compaction. Helper execution cannot acknowledge on main's behalf.
- Helper reads do not consume the owner's completion. Only after the result's evidence is persisted into main's receipt does it become owner delivery. An interrupted helper leaves the notice available to main.
- Notification consumption remains a durable claim, not a transactional exactly-once guarantee spanning a filesystem job record and a model response. Acknowledged state is explicit; this repair does not infer successful processing merely from an assistant answer or an artifact read.

## Implemented evidence and compaction contract

- Handoff uses the first new persisted message sequence number, rather than a starting array length. The original current-turn bound still prevents replaying an earlier answer when a resumed helper produces nothing.
- Main ownership/model/context are restored before reading the saved child handoff, so an injected child-read failure does not strand the UI in the helper. RealSQLite controls also cover successful owner delivery versus interruption after a helper read.
- The receipt contains the final deliverable and bounded previews of current-turn tool evidence, including results before final prose. Large legacy raw output stays in the child. Receipts have their own resultVersion and name session-qualified toolCallIds.
- Existing `retrieve_tool_result` already searches the same-root session tree. A new realSQLite regression proves main retrieves a child's command result through that path; no redundant retrieval API was introduced. Child-local bash-N labels are explicitly described as insufficient global references.
- Short delegation results remain verbatim through compaction. Long results become a bounded handoff summary retaining version, saved-result location, conclusion previews and the toolCallId needed to retrieve full evidence. The transformation is stable on repeated compaction passes.
- Main's delegation instructions now ask for concrete scope/exclusions, relevant verification, budget, source/command/exit-code evidence, unverified areas and blockers. Percentages require a rubric; agreement between models does not replace evidence.
- The convergence mirror now scopes tool counts to the latest user-message boundary. Historical tools no longer appear under This turn. This is not a new persistent session-wide accounting dashboard.

## Verification

RED controls captured before repairs:

- Five initial delivery cases failed: read-before-poll duplication, absent version/ACK, unreadable completion and owner protection.
- Persisted-sequence compaction regression failed under the old positional boundary.
- Two delegation compaction cases lost their short handoff or retrieval reference.
- Mirror regression counted earlier-turn tools as current work.

Accepted native controls:

- TUI6/6: owner reads saved version, explicitly acknowledges it, no notification after that read, no redundant auto-wake, restart does not replay, ACK persists.
- Native background worker7/7: actual worker process runs, main handles a human follow-up before completion, deliverable/result/owner persist, and an unread completion wakes main.
- Source native selfverify run `a8c72dcb-3187-4b8a-8a7a-a85cf5aad411`: boot1/1pass,0failed;2council surfaces skipped because no opener is registered. This is a CLI boot check, not CodeStandards analyzer verification.

Final acceptance: **160tests /15files passed**, build/typecheck passed and whitespace check passed, all native exit0. Measurements are recorded in `.scratch/session-feedback-c9fdef1b/accepted-tests.log` and `accepted-build.log`. No full-suite or paid-provider acceptance claim is made. Initial native fixture errors (mock path allowlist, short fake-key provider picker, missing live fixture PID) were corrected before the accepted run; they are not production failures.

## Remaining feedback and attribution boundaries

These items are recorded for a separate scope; they are not silently reported fixed:

| Feedback | Verified evidence | Remaining work |
|---|---|---|
| Two-tool-round instruction conflict | The reported exact two-round instruction was not located in the inspected audit paths. Mandatory research delegation was located and removed. | Trace the effective instruction source before altering user-owned policies; preserve explicit project requirements. |
| EE cross-project result | Tool calls7453/7492 specify tcis-libraries but return Muonroi material. The client forwards project_slug; EERecallOptions calls it advisory and entries expose id/collection without project provenance. | Agree on strict server-side scoping/provenance before filtering arbitrary formatted text in CLI. No backend cause or fix is asserted. |
| Batched range/truncation | Call7456 requests start1/end180 with multiple paths, yet AGENTS header says1–298 and is capped. The current documented batch contract reads whole files; ranges apply to the single-file path. | Add explicit batch ranges/returned-range metadata and bounded line-safe output as a separate contract change. |
| Selfverify named pipe and unrelated files | Run7552f358-3e1d-40cf-bc24-514e11eb3d1a fails after90s waiting for a harness pipe. Its scenario derives from five pre-existing deleted docs/helper paths. Default self-QA entry/fixture paths resolve against cwd, and native tier1 tools do not expose the existing diffFilesOverride input. | Reproduce/fix foreign-workspace startup and expose task-owned file selection. This CLI harness failure proves nothing about C# analyzer correctness. |
| Budget dashboard / independent evidence scopes | Prompt guidance now leaves scope and verification with main; existing job tool limits remain. | No new aggregate token/time scheduler, automatic overlap detector or session-wide budget UI was introduced. |

Restart the CLI to load the rebuilt modules. The repair does not retry the owner's tasks or mark their historical results as newly accepted.
