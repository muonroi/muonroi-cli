# Main-session coordination audit

This document records the pre-repair baseline. After user authorization, coordination changes were implemented and their current verification is recorded in main-primary-fix.md. Statements below about unchanged production behavior describe the audit snapshot, not the later delivery.

## Scope and verdict
Read-only audit of router sub-sessions, foreground task agents and background delegates. No coordination production changes were made. The additional user-reported wallet startup crash was repaired separately through qc-flow.

The main session can delegate and collect results, but these mechanisms do not share a parent-owned supervisor contract.

## User-confirmed architecture contract
The user clarified after this audit: the main session is primary; sub-sessions, task agents and delegates are helpers to reduce the main context load. This section describes required behavior, not a claim that it is already implemented.

- Main retains the user's goal, plan, work assignment, result acceptance and final answer. A worker handles a bounded assignment, not ownership of the entire user turn.
- Each helper receives only the context needed for its assignment and works in its own context. Main receives a concise result with evidence, changed-file/test references where applicable, limitations and task status; full tool logs remain retrievable on demand.
- Completion returns control and the decision to main. Main determines whether the result satisfies the assignment, requires more work or needs a different helper. Final synthesis is owned by main.
- Helper status and notifications belong to the originating main session/task. Waiting, timeout, failure, cancellation and delayed completion must preserve that ownership and cannot overwrite a newer assignment.
- Helpers remain available for context offload; the target is to correct handoff and result acceptance, not simply disable delegation. routerSubSessions=false is an existing temporary control, not the desired final architecture.
- The current router branch replaces the main's turn with a child and salvages its final output without a separate main decision step. That behavior is an evidenced mismatch with this contract; the routing, owner-notification and dead-worker probes above establish additional integration gaps. No new coordination behavior has been applied by this documentation update.

| Mechanism | Runtime relationship | Existing controls | Verified limits |
|---|---|---|---|
| Router SPAWN_SUB_SESSION | Same Agent and active generator temporarily switch session/model/transcript | Parent/root linkage, related-child resume, parent context/model restoration, shared turn cancellation | Main waits for child; shared filesystem; completed child can remain active for resume; salvage is not an independent main-model review |
| Foreground task | New StreamRunner, local child messages, parent session accounting and unique subCallId | Model/budget/round limits, compaction/dedup, stall guards, parent abort | Awaited tool blocks main next step; no child-specific prompt steering/pause API; no separately persisted child session row |
| Background delegate | Detached independent process, read-only explore | list/read/kill, result persistence and completion notification | Project-scoped records without parent/root owner; main abort does not cancel detached work; no pause/resume/steer API |

## Source evidence
- src/orchestrator/orchestrator.ts:3902 router switch, :3930 latest active child selection, :4272 restoration/salvage.
- src/orchestrator/orchestrator.ts:1774 foreground runner; :1881 delegation; :1464 background notification consumption.
- src/tools/registry.ts:993 task routing chooses background for explore or maxToolRounds > 25.
- src/orchestrator/delegations.ts:65 explore restriction, :215 shared-file notification consumption. Job schema has no parentSessionId/rootSessionId.
- src/ui/use-app-logic.tsx:4714 UI polling consumes project notifications into the current agent.
- src/orchestrator/orchestrator.ts:4519 parent consultation performs an auxiliary model call over parent transcript. This is advice generation, not resuming the parent's active decision loop. The callback supplies no cancellation/deadline; runtime hanging of this path was not reproduced and is not asserted.
- routerSubSessions=false is an existing supported setting that keeps implicit router delegation on the main session/model. Explicit task/delegate remain available. Configuration was not changed.

## Runtime evidence
session-coordination-data.json is a read-only database snapshot for 2026-09-30T08:39:55.574Z through 2026-10-07T08:39:55.574Z. Counts include QA activity.

Root cde402aafc74 has child 5e827c722715: parent has 3 messages/0 tools/1 error; child has 32 messages/30 tools/0 errors and status active. Session active is a resume/lifecycle status, not evidence that a worker process is running.

delegation-control-probe.ts exercises real registry/manager code with isolated synthetic records, without provider calls or spawned workers. delegation-control-probe.json proves:
1. Synthetic PID does not exist (ESRCH), but list reports running.
2. A second manager for the same cwd consumes the completion notification; the originating manager then receives none.
3. task general with maxToolRounds=26 routes only to background, then fails the explore-only restriction. The foreground executor is never called.

Project delegation records demonstrate successful background completion and overlapping execution intervals, but their missing owner IDs do not prove attribution to a particular main session.

## Priorities supported by reproduction
1. Correct long-general task routing so the chosen executor accepts the agent type.
2. Establish originating-session ownership for delegate notification delivery; same-project consumers currently compete for the same notifiedAt flag.
3. Reconcile worker liveness with persisted running status and verify termination before reporting success. Dead-PID listing is reproduced; current kill acknowledgement is source evidence, not proof of actual termination failure.

Cancellation policy, per-child steering and result acceptance are separate product requirements. Existing mechanisms have the controls listed above; this audit does not implement new controls or attribute the historical PIL watchdog to them.

## Verification
- session-coordination-tests.log: 110 passed across 10 files.
- session-mutex-tests.log: 52 passed across 3 files, including serialization and sub-agent budget/compaction checks.
- No push/commit; unrelated staged and unstaged WIP preserved.
