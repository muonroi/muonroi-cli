# Native plan review loop: dfd06b45d9db

## Runtime evidence

Production SQLite was opened read-only. The session used `step-5-preview` in `D:\sources\Core\muonroi-cli`. It issued nine `flow_plan` and nine completed `flow_plan_review` calls. All reviews returned `revise`; all nine reported `recordedRevisionCycle: 0`. No task dispatch or `flow_execute` event appears in this session's captured interaction inventory.

The nine paired interaction call/result windows total **5412.929 seconds (90m12.929s)**. Use those paired interaction records, not `tool_calls.started_at/completed_at`: the first pairs disagree with interaction timings. The session had one original user message; UI answers are distinct from user-message turns.

| Review | Call/result records | Seconds |
| --- | --- | ---: |
|1|65280/65370|566.708|
|2|65378/65535|694.796|
|3|65543/65645|587.891|
|4|65669/65939|943.618|
|5|65947/66028|400.679|
|6|66036/66059|241.799|
|7|66067/66222|510.057|
|8|66230/66443|724.838|
|9|66456/66755|742.543|

UI record66056 auto-continued the generic pattern guard after repeated review calls; that guard did not impose a plan-review resource limit. After eight rounds, UI record66446 records the user's explicit `rev9` choice. The ninth round was authorized, not an unauthorized ninth retry. Record66758 later records `user_decides`.

Concerns expanded from probe isolation/preflight to full-profile effect certification, artifact registries, citation linting and executable gatekeepers. Several are real evidence/safety questions; this repair does not declare them invalid or approve the plan. The final verdict additionally demanded that main synchronously spawn commands, despite main's orchestrator-only role. The requested runtime report was not completed by these reviews.

## Reproduced defects

- The native tool path never supplied `revisionCycle`; `runPlanCouncil` defaulted to0. `buildCouncilContextBundle` only marks prior concerns for revisits when cycle>0, so this path did not activate that prior-concern guidance.
- No native review/rewrite allowance existed. Actual native tools admitted a fourth rewrite/review after three unresolved verdicts. Two new regression tests failed before repair.
- A model-controlled pattern guard can elect to continue. Removing the new host stop from the root SDK control leaves26tools exposed to the next request; the corrected control ends tools and uses tool-free finalization.

## Changes

- Add a host-owned allowance created once per `executeToolEngine` request, outside provider retry/tool-registry rebuilding. Default: **3 native review attempts per user request**. User environment `MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS` accepts1..20; invalid/nonpositive values use3. Model tool arguments cannot reset or enlarge it.
- Rewriting a plan does not refund the allowance. An exhausted allowance refuses both further native review and plan rewrite before host mutations/model review calls. Responses include remaining allowance, current review concerns and `stop_and_report`.
- The third unresolved review requests a host stop before the model's generic continue/stop pattern decision. Existing tool-free finalization reports the blocker. A genuine approval clears the stop request and can proceed; exhaustion never grants approval or changes a prior verdict. A new actual user request gets a new bounded allowance without unlocking review admission.
- Native revisions now use indices0/1/2 within the request, allowing prior concerns to be included on revisits. This is not a redesign of persistent task ownership across sessions.
- Share convergence/authority guidance between debate and perspective prompts: address prior concerns first; justify material new blockers; separate enhancements from requirements; do not demand completed implementation evidence before permitting a concrete guarded preflight; do not require main to perform worker work. Genuine acceptance/correctness/safety blockers remain revise/block.

## Verification and limits

Evidence: `.scratch/plan-review-loop-dfd0/`.

| Check | Result / boundary |
| --- | --- |
| Native before controls (`before.log`) |2failed: repeated review admitted and cycles0/0/0 |
| Root before control (`root-before.log`) |Fails: final request retains26tools when host stop is removed |
| Focused regression (`tests.log`) |92tests/12files pass: limits, rewrite/refusal, shared budget, cycles/prior concerns, genuine approval, block/revise, cancellation, ignored model force/reset, prompt parity, gate/role dispatch and watchdog |
| Typecheck/build |Exit0 / exit0 |
| Corrected built Agent/SDK (`compiled-loop-final.log`, `compiled-loop.json`) |8/8: exactly3 mocked council calls, no fourth rewrite, tool-free final sees stop, cycle2, prior concerns, no auto-approval, visible unresolved final |
| Native selfverify (`native-selfverify.json`) |Bun TUI boot1/1; boot only |

The SDK and built controls use mock providers/council synthesis. They establish host stopping and data flow, not that a live model will converge within three reviews. No paid incident replay, full suite, push or deployment was performed. Other product-loop entry points and stale workspace context ownership are outside this native tool fix.

## Compiled fixture isolation incident and restoration

The first built control placed its fixture under this checkout's `.scratch` and used `Agent.setCwd` without isolating the run's flow-state anchor. Flow anchoring correctly treated that descendant as part of the original run. The probe mistakenly wrote fixture PLAN.md, PLAN-REVIEW.md and PLAN-VERIFY.md into the real `.planning`, plus the existing phase's PLAN.md. STATE.md was touched but its content hash remained unchanged. This was a fixture isolation error, not accepted verification evidence.

Execution was stopped. The three root files were reconstructed from original session tool arguments, exact recorded synthesis/verdict and native formatter, and **all three matched the pre-probe SHA256 snapshots before restoration**. Restoration checked that the current files still matched the owned fixture bytes before writing, to avoid overwriting concurrent edits. STATE.md needed no content restoration.

The phase PLAN copy was restored from the original final `flow_plan` body and `copyPlanToPhaseDir`'s byte-preserving contract. No pre-probe hash of that phase copy was captured, so it is not claimed independently byte-identical to its pre-probe state. Restoration authority and the preserved erroneous files are in `restoration-result.json`, `restoration/`, `escaped-audit.json` and `escaped-probe-backup/`.

The corrected fixture uses an OS temporary directory outside the checkout, changes process cwd before importing application code, owns a private `.planning` marker and asserts `planningRoot` plus DB containment before execution. Full byte backups for all five affected planning paths were taken before retry; all five hashes remained unchanged during the accepted retry (`planning-after-final.json`). The original failed result remains in `compiled-loop-escaped.json` and `compiled-loop.log`.

Restart the built CLI with Bun to load the resource guard. The saved production verdict remains `revise`; the evaluation report has not been completed or accepted by this repair.
