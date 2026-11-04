# Git snapshot timeout in session 4edc02516a92

The exact saved session is4edc02516a92, cwd `D:/sources/CompanyLibs/tcis-libraries`, main model step-5-preview. Its saved tool result at seq174 contains a refused `flow_plan_review` receipt: `git rev-parse --show-toplevel`, codeETIMEDOUT, signalSIGTERM. No verifier was launched by that refusal. SIGTERM in this child-process error does not establish that the parent host was killed.

## Observed versus unresolved

- Plain Bun probes and an owned mounted TUI reading the actual consumer both successfully created source fingerprint `f234c741f5f2795f86ef6fd773e920a1df09950ef1e383882145b0e5bed71cce`. The historical10-second timeout was not reproduced; the result does not identify a particular environment, antivirus, PATH or disk cause.
- The mounted TUI measurement did reproduce host event-loop blocking: old synchronous snapshot461ms total, maximum heartbeat gap380ms; asynchronous snapshot656ms total, maximum gap36ms. These are one before/after local samples, not speed guarantees. The total call did not become faster; the host could process callbacks while waiting for Git.
- Consumer Git index stayed SHA7549b0d1f10cb7ec6f523f626e526c826845ecbac5b1dc4b8382a2220c1e2134. Current consumer plan is499 lines, SHA5dc7141141b1d8ea5860405ad8c7d83597e31571181fab732c85a011f7a76764. This work did not amend it or its gate artifacts.

## Implementation

`src/orchestrator/review-evidence.ts` now uses native asynchronous execFile throughout its already async sourceFingerprint API, including nested Git roots and Gitlinks. Commands remain sequential, shell-free, read-only with GIT_OPTIONAL_LOCKS=0,10s root-probe deadlines,30s enumeration deadlines and existing byte limits. No timeout increase, filesystem fallback for broken Git, staging requirement or gate bypass was added.

Failures retain native code/status/signal and bounded redacted stderr; diagnostics now include measured elapsedMs and configured timeoutMs. Numeric execFile exit codes are also exposed as status to preserve existing refusal diagnostics. Snapshot source identity and native planning-input binding remain separate: ignored PLAN content is hashed directly by the latter.

The saved `[dup of call #...]` output is not proof that dispatch was skipped: sub-agent-cap.ts executes the inner tool before compressing duplicate result text. This investigation does not change dedup behavior or authorize retry loops.

## Verification and limits

-123 existing Git/independent-review/async-plan-review cases passed;6 focused cases passed, including4 overlapping prior cases and2 new controlled async/timeout cases (125 unique tests across4 files).
- Mounted native TUI fixture passed against both an owned repo and the actual read-only consumer, with mock providers and no paid request. Controlled pending-Git test confirms host callbacks run before the native snapshot completes; a controlled timeout still refuses admission with its original signal/deadline.
- Build/typecheck passed. Native selfverify smoke-boot cbd009cf-cfec-4f96-9f38-d3a6df1dd0c5 passed1/1.
- No live session restart, revalidation dispatch, Flow completion, Git index/config edit, commit or push. No TCIS build/test/pack or corpus Tier2 classification was executed. Reopen/resume the CLI to adopt this execution change; live-session admission remains unproven.

## Follow-up: diagnostics report and process chronology

Read-only checks on 2026-11-03 confirmed the consumer report at `D:/sources/CompanyLibs/tcis-libraries/.muonroi-flow/planning/notes/git-host-diagnostics.md`, SHA-256 `044b62b900e8b2a7e390bd9733af1282e1171a4fb22d8504cc6b4081a7df4c92`. Two report conclusions need correction:

- `pending_calls.jsonl` is not the complete result store. A read-only SQLite query of `C:/Users/phila/.muonroi-cli/muonroi.db`, session `4edc02516a92`, message seq174, returned a persisted tool result at `2026-11-03T01:04:16.392Z`. Tool call `call_a184f837d9aa444fb3e6922c` has `ok:false` and a receipt containing `code=ETIMEDOUT; status=none; signal=SIGTERM`. This proves a saved refusal exists; it does not prove verifier execution.
- `debug.log:7364`, timestamp `2026-11-03T01:22:56.147Z`, belongs to the controlled test checkout `.../Temp/snapshot-async-YKY35D`, with injected `Timed out Git child`, elapsedMs=0 and timeoutMs=10000. `src/orchestrator/__tests__/review-evidence-async.test.ts:50` injects that exact error. This is intentional negative-test evidence, not another timeout from the consumer session.

At `2026-11-03T04:29:35.682Z`, Get-CimInstance still found mu.exe PID81888 and its Bun child PID56220. The Bun process creation time is `2026-11-02T14:48:23.554489Z`. The global installed `dist/src/orchestrator/review-evidence.js` was last written at `2026-11-03T01:23:31.265413Z`, after that host started. The latest cited real consumer timeout is `debug.log:7304-7305` at `2026-11-03T01:10:48.782Z`, before the new build. These timestamps do not inspect in-memory module contents; they establish that the cited failures do not validate the new build in a fresh host.

The next bounded check is to exit the existing interactive host, resume the same session in a fresh global CLI process with `mu --session 4edc02516a92` from the consumer directory, confirm its start time is later than the build, and perform one native revalidation of the unchanged intended snapshot. Record the new receipt and measured diagnostics if it fails. Reading privileged host environment variables is not necessary for this next check. No restart or revalidation was performed by this investigation.
