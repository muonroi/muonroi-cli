# Native EE scope recovery and delegation acknowledgement guidance

## Confirmed trigger

Session804115f7251f exposed two usability gaps in the native tool handoff:

- Main seq5–8: both query-only recall and an explicit AI Dock cwd returned ee_project_required400. The generic error advised supplying cwd without identifying the scope already rejected.
- Main seq15–16: both completed workers were read and durably delivered, but neither was explicitly acknowledged at the review snapshot. Direct reads returned the job/version/path; ACK instructions existed in completion notifications, not in the direct read result.

Prior read-only evidence: `.scratch/session-804-feedback/trace.json`; review `session-804-runtime-feedback-2026-10-17.md`. This change does not rewrite those historical jobs or claim to resolve the server's AI Dock project mapping.

## Resulting behavior

### EE

`src/ee/search.ts` now includes the actual attempted cwd and explicit project, if any, in a scope-required400 diagnostic. It explains that repeating that unresolved scope or changing query text does not resolve the mapping. The next step is the native `ee_query({"action":"projects"})`, then selecting the exact slug for the intended repository. A different target can use its absolute cwd. If the intended project is absent or still rejected, continue using repository/local artifact evidence and report the unresolved mapping.

Strict filtering/proof remains required. There is no automatic project selection, extra HTTP request, retry, cross-project widening, or conversion of scope rejection into downtime. A valid explicit project still binds to the task only after successful strict verification.

### Delegation

`src/orchestrator/delegations.ts` now adds the following to successful terminal reads, before the full worker artifact:

- Execution status, delivery status and acknowledgement status separately.
- An exact `delegation_ack({"jobId":...,"resultVersion":...})` instruction for main **after processing** an unacknowledged result.
- Reading does not acknowledge, verify or accept the worker's claims. Helpers forward the reference and do not ACK for main.
- A previously acknowledged version reports acknowledged without requesting another ACK.

The persisted artifact and version are unchanged. Owner/version checks, missing/tampered artifact rejection, cancellation and notification dedup remain intact. Read-only helper observation does not claim owner delivery.

Native `delegation_list` now renders labels such as `[execution=complete] [delivery=delivered] [ack=pending]`. A running job or legacy artifact without a validated resultVersion has `ack=not_ready`; reading a valid legacy artifact establishes its version before ACK becomes pending. Tool descriptions reinforce this distinction. This is native tool output; no TUI layout redesign is claimed.

## Fresh verification

| Check | Result | Evidence |
| --- | --- | --- |
| Before repair | 5 new guidance tests failed as expected | `.scratch/session-804-scope-ack/red.log` |
| Focused regressions | 9 files,111 tests passed, exit0 | `accepted-tests.log` |
| Build | exit0 | `build.log` |
| Compiled native/owner probe | 13/13 controls passed | `compiled-guidance.json` |
| Offline compiled controls | 16/16 passed | `compiled-controls.json` |
| Native selfverify via freshly rebuilt local tools-MCP | 2/2 passed | run5cdbce02-0ea5-4a03-89e7-29ef033e9cd5 |
| Scoped whitespace check | exit0 | `git -c core.whitespace=cr-at-eol diff --check -- <changed files>` |

Regression coverage includes real native HTTP-fixture errors, explicit project/no auto-selection, remembered verified scope, single-request refusal, real artifact delivery without auto-ACK, helper non-consumption, owner/version rejection, no repeated ACK hint after acknowledgement, and preserving the ACK next action through repeated compaction of a long result. The existing worker-state integration fixture was updated for the intentional labelled output format and validates delivery separately after reading.

The compiled probe uses freshly rebuilt native tools, real Agent owner methods and isolated SQLite/files. Its HTTP responses are deterministic fixtures, not live EE server measurements. Initial private probe assertions were corrected to count recall requests separately from catalog initialization and to assert the actual existing stale-ACK error contract; no production behavior was altered for those probe corrections.

## Limits / loading the change

No paid provider execution, live EE deployment change, full unit suite or push was performed. Settings, real job acknowledgements and active user processes were preserved. Restart with `bun D:/sources/Core/muonroi-cli/dist/src/index.js` to load the new native guidance. Existing historical tool results retain their original text; fresh native reads/listings use the new output.

Evidence manifest: `docs/investigations/evidence/session-804-scope-ack-guidance-2026-10-17.json`.
