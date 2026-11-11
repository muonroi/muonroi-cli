# Worker status, modal Escape and stale worktree model pins

The owner reported session `0717b08730a1` showing two running agents while main reported no workers, followed by Escape dismissing a jobs modal and stopping the underlying run. Both CLI defects were reproduced and fixed. Investigation also identified the actual failure of the later worker `calm-teal-panda`.

## 1. Main and rail lost the worker registry when cwd changed

Real saved records showed:

| Worker | Stored scope | Recorded outcome |
|---|---|---|
| eager-teal-owl | original shipd-challenge checkout | error, 2026-10-14 09:49:55.821 UTC |
| brisk-blue-fox | original checkout | complete, 2026-10-15 03:28:27.760 UTC |
| calm-teal-panda | debt-w7 worktree | error, 2026-10-15 03:40:02.172 UTC |

All three records belong to owner session0717b08730a1. They were not deleted. Their directories are `shipd-challenge-2994c693d6` and `debt-w7-win-portability-6282a3834d` under the user's delegation storage.

Before the fix, Agent supplied mutable bash cwd to DelegationManager's storage lookup. The directory key hashes the whole cwd. Moving into a worktree therefore redirected list/read/snapshot/notification lookup to a different directory. Main's actual exported tool output was `No delegations found for this project.` The rail still had the original launch receipts and treated a started job missing from the snapshot as running. This produced the observed disagreement.

Fix:

- Future registry storage follows the owning session's persisted `cwdAtStart`, including resume. Constructor cwd is the fallback for nonpersistent sessions. Helper handoff keeps registry ownership distinct from actual tool execution cwd (`src/orchestrator/orchestrator.ts:631` and4041).
- Existing records created under a different cwd remain discoverable across saved scopes only when `parentSessionId` exactly matches the owner (`src/orchestrator/delegations.ts:296`). List/read/kill/notifications use the same lookup. Other owners and unowned legacy records outside the current project are excluded.
- Historical failed/done states remain intact. The rail now receives actual terminal states; no heuristic marks a missing worker successful. Shell grouping and fresh-running behavior remain covered by the existing lifecycle tests.

## 2. Escape had multiple independent interruption paths

The UI has raw-input, internal-key and stdin Escape listeners calling `interruptActiveRun`. Its old guards protected council/preflight cards but did not protect ordinary modals. Returning from the jobs-modal reducer did not prevent the independent listener from calling `Agent.abort()`.

A native source TUI with a slow mock stream reproduced exactly one actual abort call when Escape dismissed `/jobs`. This was measured by wrapping the real Agent.abort method inside the isolated harness bootstrap, without changing production instrumentation.

Fix: the shared interrupt callback checks the current modal keyboard-owner snapshot before queue clearing or run cancellation (`src/ui/use-app-logic.tsx:3955`). The modal Escape reducer consumes the key so another key listener cannot also handle it (`line6585`). Native verification covers both `/jobs` and `/model`: dismissing each makes zero abort calls, the same main stream finishes, and a subsequent Escape with no modal still invokes abort. The no-modal queue-first stage is retained.

## 3. The latest worker failed on a remaining 3.5 pin

`calm-teal-panda.json` contains the exact error:

`Model "step-3.5-flash" not found in catalog — cannot determine provider.`

Its worktree-local `.muonroi-cli/settings.json` still set `subAgentModel` to3.5, although the original checkout/user settings had been migrated. This worktree copy was missed during the prior catalog migration. A sweep of all three registered Shipd worktrees found the other debt-tooling worktree retained the same pin.

Both worktree worker pins now use `step-3.7-flash`; their main model remains `step-5-preview`. Exact pre-change backups are outside git workspaces in `C:/Users/phila/.muonroi-cli/settings-backups/20261015-stepfun37/`. The actual settings loader and catalog resolution, run from the active worktree, report configured/resolved model `step-3.7-flash`, provider `stepfun`.

No user worker was relaunched or killed, and no Shipd implementation files or original delegation records were edited. This configuration check does not claim the W7 task has completed or prove future inference will avoid rate limits.

## Verification

- Status regression RED: 3 real-SQLite cases failed before the fix (cd, resume from worktree, helper execution). Extended fixtures cover terminal records in both scopes, read/kill routing, foreign-owner exclusion, unowned legacy exclusion and exactly-once notifications.
- Modal callback RED: 26 failed / 2 passed before the fix. Tests execute the actual extracted shared interrupt callback for each modal surface and retain normal Escape/queue controls.
- Final focused tests: **205 passed across16files**, native exit0.
- Final native MCP/TUI: **9/9checks passed** with three terminal worker fixtures spread across two scopes. Rail reports0running/1done/2failed; main list/read agree. Both modal dismissals preserve the stream, and plain Escape still cancels a later stream.
- Workspace native selfverify: run `b1325a64-f72d-4f60-a48a-440e04ebe4ab`, smoke-boot1/1passed,0failed; two council surfaces skipped because no registered opener exists.
- Final build and Git whitespace validation: native exit0. Formatting checks on changed test/delegation files exit0, retaining existing advisory warnings. No new full-suite claim, commit or push.
- The machine's global Bun package is a junction to this workspace. Reopen muonroi-cli and resume the session to load the rebuilt code. Existing processes retain their loaded implementation. Catalog2.21 stays deployed; these client fixes require no additional FastAPI deployment.

Tools and raw evidence: `.scratch/agent-status-cwd/` contains `native.mjs`, `bootstrap.ts`, native before/after JSON, the three-record summary, real-DB regression logs, `accepted-tests.log`, `accepted-build.log`, selfverify results, and `check-worker-config.ts`/`worktree-config-result.json`. Native tests use private HOME/DB/job records, mock inference and fixture instrumentation; they do not drive or interrupt the user's active session.
