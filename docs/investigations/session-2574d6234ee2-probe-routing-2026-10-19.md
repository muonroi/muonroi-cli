# Probe routing: session2574d6234ee2

Read-only SQLite investigation. Original user message requests a bounded background Vietnamese write/edit/read probe and independent review, without council or source-based diagnosis. Main model recorded as step-5-preview; session cwd D:/sources/Core/muonroi-cli.

## Observed

-100 tool-call events,0 task calls,0 delegate calls. No matching durable delegation jobs were found for this owner. The requested implementation/reviewOf probe was not dispatched.
- Initial flow_status result64451 contains a revise review. This is a recorded workflow state; no task dispatch refusal was observed. A status flag alone does not prove that the host rejected the requested probe.
- Askcard event64483 at2026-10-19T01:48:56.623Z records answerKind=choice and answerText="Authorize the FLOW repair path (breaks 'no council' / 'max 2 workers')". The subsequent flow/council work therefore has explicit user authorization; it must not be described as an unauthorized council invocation.
- Two flow_plan_review calls:64499→64729,683.648s;64737→64874,551.441s. Total1235.089s, approximately20m35s. Both returned revise rather than advancing to the requested probe.
- Event64875 at02:11:39.144Z is provider-stall,kind=progress,model=step-5-preview,phase=provider-stream. Event64877 at02:12:38.039Z records stall_rescue,rescued,8 tool results,4936 chars. This is not a ModelMessage schema rejection or a recorded429.
- The persisted final response says no report.md/evidence.json fixture artifacts were written and requests a further workflow decision. It supplies no completed write/edit/read probe.

## Verdict / limits

| Question | Finding |
|---|---|
| Vietnamese background write/edit/read succeeds? | UNVERIFIED: probe never dispatched |
| Main can retrieve the probe's host artifacts? | UNVERIFIED: no probe artifacts |
| Fresh schema failure/path reproduced? | No schema failure captured; requested evidence absent |
| Host mutation gate actually refused task/delegate? | UNVERIFIED: no such call or refusal |
| User authorized changing the original no-council constraint? | Yes: askcard event64483 |
| Session accomplished the requested runtime probe? | No |
| Running process loaded a particular rebuilt revision? | UNVERIFIED |

This session demonstrates workflow detour and a subsequent progress stall, not a background-edit or Vietnamese-language defect. Further reproductions should isolate the bounded diagnostic from unrelated pending planning state. No global gate/permission bypass is justified by this trace.

Evidence: `.scratch/session-2574d6234ee2/evidence.json`. No source/settings/credentials/planning/job/session mutations, paid tests or runtime repair were performed in this investigation.
