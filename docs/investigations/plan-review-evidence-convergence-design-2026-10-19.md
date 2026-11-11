# Evidence-backed plan review convergence

Status: design following the user's correction; not implemented. The existing request resource guard remains in place until an evidence-based protocol replaces the blind loop.

## User requirement

Review must converge. A reviewer proposing a blocker must substantiate it, and the main coordinator must verify that finding before commissioning a fix. Main owns disposition and acceptance; workers perform substantive inspection, commands, edits and independent verification.

## Current evidence

- `src/workflow/verdict-schema.ts`: concerns are strings; evidence is an optional separate string array defaulting to empty. There is no mandatory per-finding proof or issue identity/version binding.
- `src/workflow/plan-council.ts`: parsed verdict is persisted and passed directly to `applyVerdict`, which changes Plan Verified / phase. There is no intervening coordinator disposition protocol.
- Current native/built controls accept a scripted revise concern with an empty evidence array and keep the gate closed. The earlier counter fix bounds that behavior; it does not verify the concern.
- Sessiondfd06b45d9db:9revise reviews,0revision index throughout,90m13s aggregate paired interaction review time. Several legitimate concerns and some role-conflicting demands occurred. Do not assert all nine reviews were false alarms.

## Proposed protocol

1. **Freeze the reviewed baseline.** Bind the user goal, acceptance criteria, protected boundaries and exact plan hash to an explicit task/run. Main owns changes to that baseline. A changed plan invalidates stale acceptance, not the historical evidence record.
2. **Review produces proposed findings, not final admission.** Each finding has a stable host-owned issue ID, plan hash, violated requirement/boundary, concrete claim, expected/actual behavior, scoped evidence references and an acceptance condition for resolution. Evidence references are actual host tool/artifact IDs and digests, never just text claiming a tool ran.
3. **Main adjudicates findings.** Main checks binding and whether the evidence supports the claim. Reuse sufficient existing host evidence. When proof is missing or independence is required, dispatch one bounded verification worker for a batch of related findings. Do not launch a full council or a new agent per comment by default.
4. **Disposition is explicit.** A finding becomes confirmed, rejected with counterevidence, disputed, or needs-evidence. Unsupported assertions do not become instructions to rewrite the plan. A decision-critical unknown remains an explicit verification prerequisite; missing evidence never silently means safe or approved.
5. **Fix only confirmed blockers.** Main assigns the smallest required change to a worker. Nonblocking enhancements are recorded separately and do not expand the user's deliverable without a scope decision.
6. **Close through proof.** A changed paragraph or worker saying fixed is insufficient. Resolution evidence must establish the issue's acceptance condition against the current plan version. Main closes the issue only after checking that proof. Source/test work is independently verified where required.
7. **Review the delta.** Subsequent review covers remaining findings and the new diff. Closed issues require new material evidence to reopen; rewording or a new reviewer is insufficient. A newly demonstrated correctness/safety failure can still block. An optional improvement cannot be promoted to a blocker without a requirement or protected-boundary link.
8. **Accept explicitly.** Council approval becomes a review recommendation. Main's acceptance is separate and host-validated against the current plan hash, issue ledger, required checks and version-bound evidence. Outstanding confirmed blockers or decision-critical unknowns prevent acceptance. Main cannot clear a blocker with an unsupported boolean.

Convergence means the accepted baseline is stable, all required blockers have proof-backed dispositions, resolution checks are complete and no decision-critical dispute remains. It is neither a fixed number of rounds nor repeated reviewer agreement without proof.

## Evidence proportional to the claim

- Existing runtime bug: a bounded reproducer/trace with expected/actual behavior and matching executed revision/environment.
- Existing source contract: current host-recorded read evidence and the relevant exact code/contract relationship; static inspection does not prove execution.
- Plan contradiction: exact conflicting clauses in the same plan version can substantiate a logical inconsistency. Do not require code that has not yet been implemented to execute before a concrete guarded preflight may be planned.
- Risk with missing facts: state the missing fact, why it affects the decision, the bounded probe and stop conditions. Do not convert a hypothetical into a proven defect or demand universal containment guarantees unrelated to the planned operations.

## Lifecycle

`proposed -> confirmed | rejected | disputed | needs-evidence`

`confirmed -> fix-pending -> verification-pending -> closed | reopened`

Rejection and closure both retain evidence, coordinator rationale and the current plan binding. Append transitions; do not overwrite the original finding or silently merge findings by fuzzy text similarity. Main explicitly links duplicates to stable IDs.

## Implementation boundaries to resolve before coding

- Use existing versioned delegation manifests, host-collected review evidence and scoped artifact readers; do not create an alternative unbound evidence channel or give main shell/file-work tools.
- Provide an approval-respecting, read-only verification path while a plan is unapproved. Existing mutation-capable task dispatch remains gated; this protocol must not open general worker execution to verify a claim.
- Native council research currently returns evidence strings, not a complete proof-linked finding ledger. Capture and bind the relevant host artifacts before accepting references; do not label legacy strings verified.
- Add coordinator-only issue-disposition and final plan-acceptance operations, with current-version and owner checks. A reviewer must not adjudicate its own finding on main's behalf.
- Persist the ledger under explicit task/run authority. Do not infer task/project identity from prose, choose a different project, or attach an unrelated workspace's old concerns automatically.
- Preserve historical verdicts, accepted results and planning WIP. New protocol migration/activation must be explicit; do not invalidate or rewrite historical reports as if they used it.
- Keep the current review cost ceiling as a last resource guard, not a quality decision. Track verified issue progress and target no-progress verification rather than automatically commissioning another full review. A pause reports precise unresolved issues and the next needed evidence.

## Verification plan

- Reject a blocking finding lacking proof binding; keep a decision-critical unknown pending rather than approving it.
- Reject stale plan hashes, foreign/forged/mismatched artifacts and unauthorized issue closure.
- Distinguish a corroborated finding, disproven finding and an unresolved disagreement.
- Reuse and batch evidence without repeated full councils; fix only confirmed blockers.
- Require closure proof; refuse reopening a closed finding without new material evidence.
- Preserve a legitimate newly demonstrated blocker and strict unknown/safety checks.
- Prevent council approval from directly marking a plan executable before coordinator acceptance.
- Demonstrate a complete propose/verify/fix/reverify/close/accept cycle plus a bounded no-progress stop through actual SDK/native host controls.
- Fixtures must be outside the checkout, change cwd before imports and assert both DB and planning-root isolation before writes. Back up complete protected state bytes/hashes before any built probe.
# Async delivery implementation checkpoint (2026-10-19)

The first bounded implementation wave now detaches root plan council and requires explicit main completion against an already-read, version-bound, current result. See `async-flow-plan-review-2026-10-19.md` for fresh checks and limits. This implements delivery/authority separation only; the issue-proof ledger and main adjudication protocol below remain design work.
