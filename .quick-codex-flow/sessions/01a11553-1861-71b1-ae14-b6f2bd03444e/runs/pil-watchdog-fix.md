# PIL preparation deadline repair

## Requirement Baseline
- User requests fixing PIL dependence/hangs that cause the watchdog to terminate turns.
- Required outcomes: R1 automated preparation returns within a bounded budget even if an await ignores abort; R2 real user-answer waits do not consume this budget; R3 turn cancellation unblocks preparation and reaches provider callbacks; R4 layer-level failure evidence is retained; R5 timed-out work cannot continue into later layers/store updates.
- Protected scope: existing WIP, model/provider routing decisions, human question semantics, user data and credentials.
- Out of scope: audit-script corrections, pre-PIL transcript write-ahead changes, remote deployment/push, exact retrospective identification of the missing inner await in session cde402aafc74.
- Baseline HEAD 54e2a8c2ab9de3b8f93b7c5604b48e90b55ef264; runtime evidence: previous AUDIT.md and frozen snapshot.
- Current gate: done; scoped implementation and verification are complete, with repository-wide failures explicitly retained below.

## Research Pack
- Existing built Node/Bun probe proves interactive runPipeline ignores the pipeline budget when classifier never resolves; noninteractive returns fallback.
- preprocessor.ts:47-95 always supplies an interaction handler and has no parent signal wiring; pipeline.ts:389-395 skips the entire timeout race for that handler.
- llm-classify.ts already supports per-call signal; discovery proposer does not yet accept it.
- CouncilManager brackets actual human waits with a watchdog hold; automated work must be bounded separately.
- Existing withDeadlineRace guarantees the caller can stop even when abort is ignored, with configurable abort grace and late-rejection logging.
- Exact historical inner await is not available; implementation closes the experimentally demonstrated entire-preparation gap rather than claiming a provider-specific repair.

## Gray Area Register
| ID | Question | Evidence / resolution | Status |
|---|---|---|---|
| G1 | Which wait is exempt? | Only interactionHandler.askQuestion, not classifier/discovery proposal/layers | resolved |
| G2 | What happens on timeout/cancel? | Pristine pipeline-timeout fallback for deadline; propagate parent cancellation; signal/active checks prevent later stages | resolved |
| G3 | How to retain source of stall? | Optional phase observer from PIL to preprocessor breadcrumbs; timeout includes last phase | resolved |
| G4 | Which exact inner await caused the historical failure? | Missing historical trace; excluded from required outcomes, retain limitation | out of scope |

## Delivery Roadmap / Verified Plan
| Phase/wave | Goal | Allowed files | Verify |
|---|---|---|---|
| P1/W1 | Add regression fault injections, bound automatic work while preserving human waits/cancel and layer evidence | src/pil/timeout.ts, pipeline.ts, discovery-types.ts, discovery.ts; src/orchestrator/preprocessor.ts, council-manager.ts (signal-aware responder), message-processor.ts (stale comment); focused PIL/preprocessor/responder tests | New tests fail before fix; pass after; existing PIL/classification/discovery/orchestrator tests and typecheck |
| P2/W1 | Verify assembled local change | Same scope, artifact files only | Build/typecheck, full unit suite, native selfverify tier1, review own diff; keep unrelated WIP |

## Plan Check
- Every outcome maps to fault-injected regression assertions; reuse deadline helper, no new dependencies or model/provider literals.
- Interactive budget default 60s of automated work (below default 120s idle watchdog); configurable up to 90s. Existing noninteractive budget remains unchanged. The existing test override supports deterministic small budgets.
- Actual askQuestion pauses budget; parent cancellation is still armed during that pause. Boundary progress prevents a resumed human wait sharing an expired idle window with new automatic work.
- No retrospective leaf cause or deployment success is claimed.
- Plan verdict: PASS for this bounded scope; one active wave; no subagents.

## Resume Digest
- Goal R1-R5 verified; current gate done; P1/W1 and P2/W1 complete with verification limitations.
- Remaining blockers: no implementation blocker for this scope; repository-wide test gate is red and any future push remains blocked.
- Risks: late async completion, global PIL store, true human wait cancellation, dirty shared worktree.
- Experience snapshot: unrelated recall entries will receive wrong_repo feedback; source/runtime evidence is authoritative.
- Evidence: pipeline-deadline.test.ts measured 6 failed / 1 passed before production edits; 7 passed after deadline implementation. Typecheck now passes.
- Verification: 129 impacted tests passed across 9 files; final expanded focused group 48 passed. Typecheck and build passed. Build emitted no errors/warnings; test runner emitted its existing bun:sqlite mock-hoisting warning.
- Next verify: restart the existing CLI process to load rebuilt modules; future delivery must resolve all five full-suite failures before any push.
- Checkpoint: no commit was created because the index/worktree already contains unrelated user changes; no staging, reset, stash or push is authorized by this repair run.
- Recommended next command: no implementation wave remains for this run; open separate scoped work for the repository-wide test failures if requested.

## Compact-Safe Summary / Wave Handoff
- Source audit and both repair waves complete; local delivery only, no commit or push.
- Phase relation same-phase; carry forward tests for never-resolving automated work, slow human answers and abort; forget broad seven-day analysis output.
- Do not edit existing WIP, audit script, provider/model routing or transcript persistence.
- Before final delivery record full suite/build/harness results and any limitations. No push requested.

## Verification Ledger
| Check | Result / evidence |
|---|---|
| Regression before production edits | pipeline-deadline.test.ts: 6 failed / 1 passed; interactive never-resolving calls remain pending |
| Impacted existing and new tests | 129 passed across 9 files; expanded final focused group 48 passed |
| Typecheck / build | bunx tsc --noEmit and bun run build exit 0 |
| Rebuilt Node/Bun runtime | pil-fixed-probe-node.json / pil-fixed-probe-bun.json: interactive and noninteractive hangs return pipeline-timeout; real human wait can exceed automatic budget; parent cancellation returns promptly |
| Native installed npx MCP | run 50853a1b-64eb-4b74-8ac6-517965ad7e49 fails before execution: missing @muonroi/agent-harness-core/selector |
| Local built native MCP | run c5dc94df-37f1-4bd1-bfba-33d57547761a: tier1 smoke-boot 1 passed / 0 failed / 0 inconclusive; pil-local-selfverify-summary.json retains captured metadata. The original full report was overwritten during follow-up wallet QA. Boot/idle only, no claim of mounted React or end-to-end PIL interview coverage; final frame nodes are empty |
| Configured full suite | bun run test exit 1: 8728 passed / 5 failed / 14 skipped / 2 todo; 927 passed test files / 3 failed / 6 skipped; 848.62s. full-unit-tests.log retains output |
| HEAD baseline for initial suite failures | Detached 54e2a8c2 worktree, same dependencies: git-effect-guard 1 failed, askcard-parked-run 3 failed; 23 passed. baseline-failing-tests.log proves these four failures precede PIL edits |
| EE integration failure | Full-suite assertion expected feedback[0] for P1/Edit/FOLLOWED, received a foreign shipd-challenge cwd and IGNORED feedback. Isolated current/HEAD reruns pass 3/3. Cross-repository payload is observed; exact ingress remains untraced. Full suite remains red |
| Diff whitespace check | git -c core.whitespace=cr-at-eol diff --check passes for owned tracked files (existing Biome config emits CRLF, .gitattributes records LF) |
| Runtime installation provenance | C:/Users/phila/.bun/install/global/node_modules/muonroi-cli is a junction to this workspace; running PID 6236 predates rebuilt output and needs restart to load the repair |

## User-facing Behavior Contract
- No automatic response: interactive default budget 60s, then pristine raw-prompt fallback with pipeline-timeout and active-layer evidence.
- Slow automatic response: accept within remaining budget; beyond budget use fallback and reject advancement/store writes by abandoned work.
- Successful response: preserve existing schema validation and use valid enriched context; invalid context uses schema-reject fallback.
- Only actual human answer waits pause the timer; answering resumes remaining budget, not a fresh one. Parent cancellation still propagates during the pause.
- Configuration MUONROI_PIL_PREP_TIMEOUT_MS accepts at least 1000ms and is capped at 90000ms. Noninteractive budgets remain 1500/3500ms.
- This bounds PIL awaits, not arbitrary later stages or synchronous event-loop blocking.

## Goal Audit / Delivery
- R1: never-resolving interactive classifier and later enrichment layer terminate with pipeline-timeout (fault-injected tests and rebuilt Node/Bun probes).
- R2: a human wait longer than the entire automatic budget remains pending and then succeeds; remaining-budget regression verifies no reset on answer.
- R3: parent abort unblocks ignored automated awaits and unanswered cards; responder tests verify only its own watchdog hold is released.
- R4: phase start/end/error assertions and active-layer logging retain attribution; nested cancelled markers are closed.
- R5: resolving an abandoned classifier after another turn cannot enter later layers or overwrite getPilLastResult.
- Scoped verdict: PASS. Repository-wide release gate: FAIL with five failures; four reproduced on unchanged HEAD, one foreign-feedback integration assertion. No all-suite-green or historical inner-leaf claim.
- Local files are built, uncommitted and reviewable; existing staged and unstaged user changes are preserved. Running PID 6236 has not been terminated or restarted by this task.
