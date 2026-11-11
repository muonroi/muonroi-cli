# Nonblocking native Flow plan review

## Trigger and scope

The user reported that Flow tools held main instead of yielding like delegate. The native `flow_plan_review` path awaited `plan:post` and the complete council debate inside the root tool call. The previous dfd06b45d9db investigation measured repeated long review call/result pairs; limiting retries alone did not release main during each review.

This change detaches the expensive council-bearing Flow tool exposed to root: `flow_plan_review`. Status/discuss/plan remain short metadata operations. Worker/infrastructure inline review and internal verify/ship behavior are unchanged; root still cannot invoke those role-filtered work/ship tools.

## Resulting contract

1. `flow_plan_review({})` starts an owned durable council job and returns its receipt immediately. It reuses the existing process launcher, credentials/permission/throttle checks, result manifests, notification delivery and ACK machinery. No Flow verdict is written by the child.
2. Concurrent unchanged reviews reuse the owned running/completed job. The host binds depth, revision cycle, actual planning root, and full-byte digests of plan/context/research/assessment/prior review/state/roadmap/config inputs.
3. After the job wakes main, main reads the exact result and checks its claims against host evidence. Notification delivery and ACK do not admit execution.
4. Main explicitly calls `flow_plan_review({action:"complete",jobId,resultVersion,assessment})`. The host requires an owned successful native review, actual owner read, exact saved result digest, structured verdict and current inputs. Generic council output, foreign jobs, unread/notified-only results, changed contexts and tampered files are refused.
5. Completion consumes the saved synthesis; it does not launch another council. Owner/cwd, saved output and input digests are rechecked synchronously immediately before native review artifacts/state are written, after asynchronous leader resolution.
6. A quick wake can complete its original bound heavy/standard review. Wake-up classification does not replace the review's host-bound depth. Internal wakes retain the live owner's review allowance; they clear the old stream-stop flag only to permit reading/completing existing work. New review/rewrite remains refused at the spent allowance. A genuine new user request starts a new allowance.
7. Routine review tool cards are hidden by the existing display-only internal activity filter. Main, diagnostics, raw receipts and exports retain the evidence. Main reports the outcome and any meaningful blocker.

## Fresh verification

- Final test output: `.scratch/async-flow-final-tests.log`: **177/177 tests, 13/13 files passed**, exit 0, duration 147.78s. Earlier failed/stalled attempts are retained separately; the stalled run was stopped by its identified Vitest PID/children and was not counted as passing.
- Typecheck: `.scratch/async-flow-typecheck-final.log`, exit 0. Final build: `.scratch/async-flow-build-final.log`, exit 0.
- Built Agent/AI SDK control: `.scratch/async-flow-review/compiled-main.json`, **12/12 checks passed**, exit 0, 2026-10-19T07:20:31.890Z–07:20:34.390Z. A real detached fixture child waited for an explicit release sentinel written only after main ended its turn. Main returned in 515 ms in this controlled run; this is not paid-provider latency evidence.
- The control exercised native root dispatch, main final output while the child remained running, durable owner notification, still-closed gate after notification, exact-version completion, no inline council/second job, retained allowance on an internal wake, quiet review projection and protected planning hashes.
- Fresh native tools-MCP `selfverify_start(mode="tier1", emit=false)` drove the actual built Bun TUI: **1/1 smoke-boot passed**. `.scratch/async-flow-review/native-selfverify.json`. Boot evidence does not establish the live council workflow/UI.
- Fixtures used OS-temp HOME/cwd/DB/planning outside the checkout. DB and planning containment were asserted before mutation. Complete bytes and hashes of five protected repo planning paths were backed up before the compiled control and all five stayed unchanged.

## Limits and remaining convergence work

The provider and council synthesis in the compiled control were offline controls. No paid council, user's already-running TUI, production DB, settings or credentials were changed. The existing detached council execution/evidence path was reused, not newly certified across every provider or permission configuration. Batch callback wiring builds, but the compiled control exercised streaming root SDK execution. The retained allowance is scoped to a live Agent owner/cwd; this does not establish allowance persistence across a process restart.

**This is the async delivery wave, not the full proof-backed convergence protocol.** Main's assessment is explicit and version-bound, but the native verdict still uses concern/evidence strings. Stable finding IDs, per-finding host proof validation, main adjudication/closure ledger and proof-backed reopening remain in `plan-review-evidence-convergence-design-2026-10-19.md`. A completed job or prose assessment does not prove its findings. Do not claim that issue-level convergence has been implemented.

Restart the built interactive CLI with Bun to load the change: `bun D:/sources/Core/muonroi-cli/dist/src/index.js`.
