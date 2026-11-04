# Client retry/cancellation fixes following the StepFun investigation

The user authorized fixing three proven client issues after the historical StepFun report. This change preserves provider/model selection, catalog limits, shared cooldown scope, retry time budgets and the two 30-second compaction deadlines. The original report ZIP remains a frozen pre-fix measurement artifact.

## Changes

- Each compaction proposer attempt owns a cancellation controller. Losing the deadline race aborts its retry work before retry/cleanup. Caller cancellation propagates even when AI SDK completes an aborted stream without an error part.
- In-process RPM/concurrency waits and shared-ledger cooldown waits accept AbortSignal. Cancelled semaphore waiters are removed; grants racing with cancellation and local leases acquired before a shared wait are released. The gate checks cancellation before dispatching transport.
- Routing runs before MessageProcessor creates a turn controller. It now temporarily owns/reuses the Agent controller and passes its signal to the classifier, allowing Escape to cancel pre-turn pacing while preserving nested caller ownership.
- The exhausted retry wrapper no longer claims generic 429 proves depleted account credit. It preserves provider body and selected trace/request/retry/rate headers through bounded cause/lastError traversal. Authentication/cookie headers are excluded. Delegated task logs include this evidence and the subagent stage.
- Known title, PIL/router and compaction calls are attributed to their stages instead of unattributed.
- A later user report exposed a resume guard defect: normal TUI sessions install an emitEvent-only toast fallback under the shared runtime global. The old truthiness check treated that fallback as a harness and suppressed resume. The guard now checks the real runtime's existing attachRenderer capability, preserving normal relaunch and real harness driver ownership.

## Verification

- Regression RED: 9 failed / 72 passed before the first production changes. The later routing ownership integration produced two additional failing regression cases before its fix.
- Final focused verification: 11 test files, 234 passed, native exit 0. Includes pacer/ledger/gate cancellation, expired compaction ownership, cancellation with empty SDK completion, nested router ownership and delegated error trace logging.
- Native MCP/TUI, actual source CLI against a loopback HTTP 429 fixture: 7/7 checks passed. Fixture settings used 1-second compaction deadlines and explicit 4s/30s retry hints; this is not a live StepFun performance comparison.
  - Timeout control: one compaction HTTP request, one main response, persisted assistant marker, correct compaction stage; no abandoned compaction retries during the observation window.
  - Escape during compaction retry: no main transport request afterward; observed composer recovery 4,171ms.
  - Escape while a preloaded private ledger blocked routing: no HTTP dispatch in the observation window; observed composer recovery 2ms.
- Workspace native selfverify: tier1 smoke-boot 1/1 passed; two council surfaces skipped because no registered opener exists. The installed cached MCP selfverify package failed with missing `@muonroi/agent-harness-core/selector`; this was not a CLI-fix test failure, and its run is not reported as passed.
- Typecheck/build: native exit 0. Full unit suite result appears below. The resume guard was verified separately after this full run finished.
- Git whitespace validation: passes with `cr-at-eol` recognizing the existing indexed CRLF baseline of compaction.ts. Original line endings were retained to avoid full-file churn.
- Actual `muonroi-cli` command resolves through a Bun shim and a global package junction targeting this workspace. Compiled output contains the new routing ownership and error wording; `muonroi-cli --version` exits 0 and reports 1.9.0. Existing running processes need reopening to load the new build.
- No StepFun chat calls, profile changes, production deployment, commit or push were performed for this fix verification. Historical ZIP SHA256 is unchanged: `21c701c103802f30a530411449c74c29503f1b98a74b45640376c947ef7080bb`.

## Evidence locations

The current workspace keeps native scripts and results in `.scratch/stepfun-client-fix/verify-native.mjs` and `native-result.json`, selfverify evidence in `selfverify-result.json`, focused tests in `final-focused.log`, latest build in `build-latest.log`, and full-suite output in `full-tests-final.log`. These scratch files are local diagnostic artifacts. The persistent workflow ledger is `.quick-codex-flow/sessions/01a1393f-631b-7752-94f0-59a96a173e2c/runs/stepfun-client-cancellation-fix.md`.

## New external guidance supplied during verification

The owner forwarded a StepFun moderator recommendation: use 3.7 for Flash, 5 preview for large-model work, and slower/spaced requests for 429. This guidance does not specify the rejection dimension, counter scope or Retry-After/reset interval. The historical experiment already sent sequential requests with 10-second gaps and recorded mixed successful and rejected 3.5 requests. The recommendation adds operational guidance but does not identify the exact counter behind those responses. Model configuration was preserved during these client fixes; the owner's subsequent catalog migration/deployment request is tracked separately.

## Final verification ledger

- Full unit suite: `bun run test` -> 959 files passed, 6 skipped; 9,050 tests passed, 14 skipped, 2 todo, 0 failures; duration 822.50s; native exit 0. Output: `.scratch/stepfun-client-fix/full-tests-final.log`.
- Subsequent resume guard: actual callback runtime reproducer changed the ordinary toast-fallback case from a harness toast with no relaunch to normal terminal handoff/relaunch. Both no-runtime and real-harness controls remain correct. Native MCP/TUI resume control passed 3/3 checks: resume-request event, responsive retained driver, stop/start restores persisted fixture content. First fixture run sampled before any visual frame; synchronizing on persisted content fixed that diagnostic race without a production change.
- Resume-focused verification: 24 tests passed across 3 files, native exit 0. Final build after the guard: native exit 0, `.scratch/stepfun-client-fix/build-resume.log`. Callback/native evidence: `verify-resume-callback.mjs`, `resume-callback-before.json`, `resume-callback-result.json`, `verify-resume-native.mjs`, `resume-native-result.json` under the same scratch directory. The user's original session was not opened or modified by these fixtures.
