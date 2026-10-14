# Main-primary orchestration repair

## Goal and inputs
User authorized implementation after confirming main owns goals, plans, decisions and final synthesis; sub-session/task/delegate offload working context. Evidence: SESSION-COORDINATION-AUDIT.md, delegation-control-probe.json and session cde402aafc74. Existing PIL and wallet repairs and unrelated WIP must remain intact. Route qc-flow, sequential execution, no delegation. User authorization to start repairs overrides workflow manual checkpoints; continue while the next step is concrete.

## Required outcomes / boundaries
R1: router child results return as bounded helper context; main runs its own decision/answer step with normal tools on its own session/model. Child text and done must not terminate or masquerade as main's answer.
R2: general/verify tasks remain valid foreground work regardless of round count; only explore is routed to the read-only background executor.
R3: persisted background jobs record originating session ownership; only that owner consumes automatic notifications. Legacy ownerless records remain explicitly inspectable, not silently claimed by a session.
R4: dead workers become visible terminal failures; kill reports verified outcome; late completion cannot revive cancelled/error work.
R5: cancellation and generator cleanup restore parent identity/cwd and prevent a new main decision after cancellation; existing detached read-only worker independence is preserved.
No new pause/steer feature, payment feature, model/provider hardcoding or push. Repository-wide failures are investigated from measured results; preserve actual coverage when fixing verification portability.

## Context sufficiency / resolved research
- Orchestrator :3902 forks/resumes within one Agent, :4262 restores in finally and currently absorbs assistant/tool output as a completed main turn. MessageProcessor.run can run again directly after restoration without re-entering router classification and supports existing abort-controller ownership.
- DelegationManager :215 consumes project files without owner, list trusts persisted status. Registry :993 routes general >25 incorrectly; probe confirms all three defects.
- Existing withFileLock is available for record mutations; use it instead of adding a locking dependency. Main helper result can point to stored child session and existing session-history search for full evidence.
- Runtime verification: regression fixtures with real SQLite for main/child roles plus isolated delegation files/process probes; existing source-runtime tool registry tests. No open product gray area for R1-R5. Any newly discovered repo ambiguity reopens research before editing that area.

## Verified plan and waves
| Wave | Change | Proof |
|---|---|---|
| P1/W1 | Add failing owner/liveness/routing regressions; correct registry routing, persist owner, scope list/read/kill/notifications, reconcile liveness, lock terminal writes | Isolated records and registry execution; live child termination test; late completion test |
| P2/W1 | Add real SQLite main-continuation regression; bound helper receipt; restore main then run normal processor; suppress child answer/done and preserve cancellation | Child/main dispatch order, different final answer, lean parent, error/cancellation and cleanup regressions; existing resume/model/cwd tests |
| P3/W1 | Typecheck/build, impacted tests, native local selfverify plus mounted startup regression; run full configured suite and report exact result | Captured logs; no claim of all-suite-green if failures remain |
| P4/W1 | Resolve the final suite failure caused by requiring unavailable sh in an indirect-commit test; keep all guard assertions using a standard-library Node script; repeat full verification after the test-only change | git-script-shell-probe.log, isolated complete git-effect-guard suite, final full suite |
Plan-check PASS: every outcome maps to runtime assertions and only evidenced boundaries are changed. No production edit before the corresponding failing regression.

## Resume digest
Current gate done; P1-P4 complete. Required outcomes verified with focused regressions, actual SQLite, real MessageProcessor/SDK mock, compiled Node/Bun probes, mounted startup, native selfverify and a green full suite. Remaining delivery action: restart CLI to load rebuilt modules. No implementation blocker or red test gate remains for this run. Risk/limitations: tests use mock model responses, not a live-provider soak test; existing skipped/todo tests are not newly enabled. Approval strategy: local repair only, no commit/push. Recommended next command: restart the CLI and use the rebuilt local installation.

## Verification ledger
- Pre-fix owner/liveness/routing regressions: 8 failed / 2 passed (coordination-before.log).
- Pre-fix main decision step: real SQLite regression fails because only child dispatch exists (main-continuation-before.log); repaired test passes.
- Helper error, notification-in-child and parent-model consultation regressions each fail before their corresponding edits; captured *-before.log files.
- Earlier focused group: 59 passed across 8 files; expanded related group: 104 passed across 13 files. More final tests added since those runs.
- Real MessageProcessor + actual SDK mock stream: main-handoff-stream.test.ts passes, main's own answer is streamed after helper evidence (main-sdk-stream.log); no live provider request.
- Helper results are bounded to 12000 content characters and reference child session for retrieval. Main continuation retains its session/model and normal tool engine; child prose/structured response/done is withheld. Receipt and helper prose are hidden in rebuilt main transcript; underlying child data remains persisted.
- Ownership persists on new jobs; read/list/kill respect owner; legacy ownerless records remain explicitly inspectable but receive no automatic session claim. Notifications are deferred while Agent temporarily holds child context. Terminal updates use existing file lock and atomic rename; late completion cannot overwrite failure/cancellation.
- Live-process termination is tested, along with dead-PID reconciliation and concurrent polling. Parent consultation now uses the parent's configured model with parent cancellation and a 30-second signal deadline.
- Earlier full suite 8728 passed / 5 failed is historical evidence, not verification of this new change.
- Review reopened research for nested ownership and helper cwd drift. Two new regressions failed (owner-cwd-before.log), then passed after preserving outer main owner/cwd and separating job storage cwd from worker execution cwd. Background jobs remain discoverable by main after helper cd. Active full-suite attempt was interrupted to freeze the final source state; coordination-full-suite.log is partial, not a completed verdict. Final measurement is coordination-full-suite-final.log.
- Final affected scope: 141 tests pass across 18 files (coordination-impacted.log), including real MessageProcessor/SDK mock and actual SQLite persistence. No live provider request was used for these tests.
- Build exit 0 (coordination-build.log): TypeScript and extension rewrite pass. A test mock initially omitted required toolCalls; it was corrected before this successful build. No compiler error/warning in final build; Bun's shell runner line is captured by PowerShell as stderr but is not a compiler diagnostic.
- Native local selfverify final run fbdeabb4-b8bc-4a7d-b914-8aab961bf169: done, 1 passed / 0 failed / 0 inconclusive (coordination-selfverify-final.json). Scope boot/idle only.
- Mounted TUI regression: wallet-boot.spec.ts 1 passed (coordination-mounted-boot.log), actual composer and input-ready required.
- Existing Vitest bun:sqlite mock-hoisting warning remains; it does not fail the affected tests. No no-warnings claim for the test runner.
- Compiled dist runtime under Node and Bun: compiled-main-handoff.mjs uses the real router classifier, real MessageProcessor, mock model sequence and isolated actual SQLite. Both exit 0, create one child, restore parent, persist helper receipt and main answer, and stream only MAIN_FINAL (compiled-main-node.json / compiled-main-bun.json). Temporary homes are removed. No live provider request.
- Completed full suite before test runner repair: 8755 passed / 1 failed / 14 skipped / 2 todo; 933 passed files / 1 failed / 6 skipped; 832.83s, exit 1. Prior askcard failures no longer appear; EE integration also passes in this run. The remaining failure is a fixture launch error, not evidence that the production guard missed an actual commit. No production guard edit.
- P4/W1 portability repair: cmd /c sh --version exits 1 with "'sh' is not recognized". Indirect mutation now executes sneaky.cjs using process.execPath and execFileSync; script launch failure throws rather than silently becoming a missing guard violation. All 24 guard tests pass (git-effect-guard-portable.log). Final frozen full measurement coordination-full-suite-green.log passes. No skip or weakened assertion was added.
- Final full suite: bun run test exit 0, 8756 passed / 0 failed / 14 skipped / 2 todo; 934 passed test files / 6 skipped, 776.12s (coordination-full-suite-green.log). This supersedes earlier red/partial measurements. No tests were skipped or weakened by this repair.
- Final typecheck after the test-only portability change: bunx tsc --noEmit exit 0 (coordination-final-typecheck.log). Production build and native/runtime QA precede that test-only change; production code is identical.
- Final owned tracked diff whitespace check passes with core.whitespace=cr-at-eol. Existing CRLF-to-LF Git notices remain; no unrelated WIP was staged, reset or reverted.

## Goal audit / delivery
| Outcome | Verified evidence |
|---|---|
| R1 main acceptance/final synthesis with lean context | Real SQLite child/main dispatch regression, bounded receipt and response-tool tests, actual MessageProcessor stream test, compiled Node/Bun probes; parent excludes 50KB child clutter |
| R2 compatible task executor | General/verify maxToolRounds=26 remain foreground; explore stays background; requested round count reaches manager |
| R3 main-owned background work | Foreign session cannot consume notification/read/list/kill owned work, concurrent poll delivers once, child-context polling defers, nested owner and helper-cwd storage tests pass |
| R4 truthful worker state and terminal result | Dead PID reconciles to durable error, actual spawned process is gone before kill acknowledgement, late completion cannot overwrite cancelled/error state |
| R5 cancellation/cleanup | Parent restored after cancellation and consumer return without a new acceptance step; existing resume/cwd/model restoration regressions pass; parent advice receives cancellation |

Scoped delivery and configured full-suite gate PASS. Local files are built and reviewable, no commit/push. No new pause/steer feature or automatic cancellation of detached workers was introduced. The main can inspect/read/kill its background helpers through existing tools.
