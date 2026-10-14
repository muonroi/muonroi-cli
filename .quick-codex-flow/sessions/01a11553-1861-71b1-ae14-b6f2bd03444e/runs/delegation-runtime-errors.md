# Delegation runtime diagnostics and research controls

## Resume Digest
- Workflow: qc-flow, balanced, single agent, auto execution after evidence and plan-check.
- Goal: investigate steady-copper-badger in session ea7378aab8f8; preserve main authority and heavy mutation authorization.
- Gate: done; P1/W1 and P2/W1 verified and released.
- Protected: user .planning files, session DB, exports, credentials; no fabricated council approval.
- Evidence: job elapsed 2.157s, model gpt-6.1-sol, generic SDK No output generated error. Export lines 1141-1142 and 1735-1736 confirm bash and todo_write blocked. Current PLAN-VERIFY is structured revise with three actual concerns.
- Unknowns: historical provider error was not retained in the job. Verify background OAuth initialization and preservation of provider error events with isolated SDK fixtures.
- Scope: background runtime/auth/model dispatch, stream error reporting, todo planning control. General shell access remains gated; direct file inspection is already available.
- Next verify: isolated real SDK reproduction with a provider error event and OAuth-backed background task; no real provider request required.

## Research evidence
- delegation-oauth-init.test.ts against unchanged production: actual OpenAI SDK fetch targets api.openai.com/v1/responses, max_output_tokens=8192, store=true instead of fixture OAuth backend. This proves runTaskRequest bypasses auth initialization, independently of historical error retention.
- stream-runner.test.ts against unchanged production: six failed cases. SDK-thrown HTTP errors become No output generated; emitted error parts can return success with Task completed fallback. HTTP 429 loses its original transient classification. Logs: delegation-provider-repro.log.
- heavy-gate-research.test.ts: main cannot execute todo_write under heavy/revise; expected Tracking 1 todo absent. Other three authorization fixtures pass. Log: delegation-todo-repro.log.
- Read-only SQLite inspection at 09:35-09:38 confirms structured review and helper launch; there is no helper provider-error row because the background agent does not persist a session. Historical exact HTTP error cannot be recovered from these records.
- Background job model stores the parent model; task resolution intentionally selects a worker model. Do not force helpers onto the leader model.
- Arbitrary bash remains protected under heavy/revise, including git status. Existing direct read_file/grep inspection remains permitted; adding a shell-command authorization heuristic or new git API is outside this targeted repair.

## Verified plan and plan-check
1. P1/W1: initialize existing OAuth authentication at the common runTaskRequest boundary before requiring a provider. Preserve worker model resolution and main/helper ownership.
2. P1/W1: throw the original SDK error event, including final synthesis; preserve transient retry and cancellation/stall behavior. Always log bounded provider error message/status/body through redacting logger; redact user-facing error text.
3. P1/W1: exempt todo_write from the mutation gate as progress bookkeeping. Keep its existing serialization and all filesystem/shell mutation gates.
4. P2/W1: verify failing fixtures, sibling OAuth/retry/stall/gate tests, build/typecheck, native selfverify and full configured unit suite before normal commit/push.
- Plan-check: each production change has an executed failing fixture; no unknown authorization boundary remains. User plan/verdict/credentials/DB are protected. No regex approval, force execution, provider literals, or new dependencies.
- Goal audit requires restart instructions and explicit distinction between proven runtime defects and unrecoverable historical HTTP detail.

## Execution and focused verification
- Existing OAuth initialization now precedes runTaskRequest provider resolution, including fresh background agents. Isolated real-provider transport proves OAuth endpoint/Bearer header, store=false and no max_output_tokens.
- SDK error parts and final synthesis failures retain the original error; failed task includes HTTP status. Always-on bounded diagnostic fields use the redacting logger and report the actual child model.
- Stream progress survives exceptions. Transient errors before text/tools can reach the existing retry wrapper; after text or tool calls they return failure without replaying completed work. Both partial-text and final-synthesis regressions pass.
- todo_write remains serialized but no longer requires production execution approval. Actual SDK dispatch fixture proves checklist update succeeds while write_file and explore shell mutation remain blocked under heavy/revise.
- 125 focused tests in 11 files pass, zero failed. Build/typecheck clean.
- 4 live TUI fixture tests pass (subagents browser and council question card). Native workspace selfverify tier1 boot passes; see delegation-runtime-selfverify.json. This does not establish a live paid-provider task or council approval.
- Full configured suite: bun run test exited 0; 8,869 passed, zero failed, 947 files passed, 6 files skipped, 14 tests skipped, 2 todo; duration 781.37 seconds.
- Source snapshot before commit: all 1,950 source/package/script/test files matched the pre-suite SHA256 snapshot; zero drift. See delegation-runtime-tested-source.json for compact receipt and changed-source hashes.
- Pre-commit secret scan rejected the 18-character mock accessToken literal. Shortened only that test fixture's token/expected header to fixture; secret scan then passed and all 125 focused tests re-passed in 12.32 seconds. All 1,949 other source hashes, including every production file, remain identical to the full-suite revision. No hook bypass or production change followed the full run.

## Goal audit
- Proven: fresh helper task authenticates through OAuth transport rather than a literal sentinel key; provider failures retain status/reason and cannot become false success; progress prevents whole-task replay; todo bookkeeping proceeds without weakening production gates.
- Historical boundary: steady-copper-badger's original HTTP detail was not persisted. Runtime fixtures reproduce the exact generic SDK failure, but do not establish that old job's HTTP status.
- Council boundary: current review is structured revise with actual staging/containment/licensing concerns. No user plan rewrite or fabricated approval was made.
- Native/TUI boundary: boot and fixture UI pass; live paid-provider task completion and remote CI were not exercised.
- Release: implementation 18d993a94e59cfa5a375a21d8a787c2986163da5 pushed to origin/develop with normal hooks; ls-remote confirmed exact ref. Pre-push binary compile smoke passed. Remote CI was not verified.
- Post-hook audit: orchestration incorrectly continued to push after a hash check returned nonzero. The sole differing file was the OAuth fixture: reconstructing its three edited CRLF lines as LF produced the exact pre-hook SHA256, proving line-ending normalization only. No production drift. The committed fixture was re-run and passed. Keep dependent shell actions conditional on successful exit codes.
- Runtime: restart CLI and resume ea7378aab8f8; historical failed helper records remain historical.
